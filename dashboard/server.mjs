// Serves the dashboard page on http://127.0.0.1:<port>/ for as long as the Claude session that
// started it is open, and does what the page's buttons ask in Orca.
//
// Usage: node server.mjs [--port N] [--gather-minutes M] [--no-window]   (defaults 47321 and 15)
//
// Once listening, it opens the page in a Chrome app window (chrome --app=<url>): a window of its
// own, with no tabs or address bar and its own taskbar button. --no-window leaves that out.
//
// Data lives in ~/.claude/bloom-dashboard/:
//   board.json     { "board": "Bloom 6.6" }  the Kanban Board the rows were gathered for
//   rows/<id>.json one row per card (fields in SKILL.md, step 4); the session writes these
//   facts.json     the last output of gather.mjs; the session writes the first, and this server
//                  replaces it every M minutes
//   events.log     this server appends a line whenever an agent in a card's worktree changes
//                  state, e.g. "BL-16775 D:/BL-16775-grade-branding-2: working -> waiting", for
//                  each change between one facts.json and the next (see diff-facts.mjs), and for
//                  each worktree the page's Create button makes; the session watches it with
//                  watch-events.mjs
//   progress/<worktree>.json  a preflight run's phases, written by progress.mjs
//   tasks.json     the developer's to-do items for History: [{ id, text, created, checked }],
//                  checked an ISO time or null. Only this server writes it. It is the one file
//                  here that nothing can work out again from git, GitHub or the transcripts.
//
// A server that finds another dashboard server on its port asks that one to exit (POST
// /api/handover with the key in handover.key), or kills it when it does not answer that request,
// then takes the port. The server that was asked prints "REPLACED" and exits 0. A local script
// that changed a card gets an early gather with POST /api/regather and the same key, and the Orca
// plugin's button gets the window shown with POST /api/show: brought to the front while a page is
// asking for /api/state (every 3 seconds), or opened when none is.
//
// Closing the window stops the server: the page posts /api/closing as it goes, and when no page
// has asked for /api/state 5 seconds later (a reload asks again at once), the server prints
// "WINDOW_CLOSED" and exits. A window that vanished without saying so stops it after IDLE_MINUTES.
//
// stdout: "DASHBOARD_URL <url>" once listening, "REPLACED" or "WINDOW_CLOSED" before exiting 0,
// "PORT_TAKEN" (exit 4) when something other than a dashboard holds the port.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { diffFacts } from "./diff-facts.mjs";
import { ownReview } from "./own-review.mjs";
import { orca, quote, norm, setLog, bringOrcaToFront, knownWorktree, agentTerminal, openWorktree, createWorktree } from "../orca-worktrees.mjs";

const execP = promisify(exec);
const execFileP = promisify(execFile);
const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
// The Orca plugin starts this server from Orca's install folder with ELECTRON_RUN_AS_NODE set.
// There cmd.exe finds Orca.exe in the current folder before the orca CLI on PATH and runs it as
// Node, so every `orca` command fails with "Cannot find module ...\orca\worktree".
process.chdir(here);
delete process.env.ELECTRON_RUN_AS_NODE;
const dataDir = path.join(os.homedir(), ".claude", "bloom-dashboard");
const rowsDir = path.join(dataDir, "rows");
const eventsLog = path.join(dataDir, "events.log");
const serverLog = path.join(dataDir, "server.log");
fs.mkdirSync(rowsDir, { recursive: true });
fs.appendFileSync(eventsLog, "");

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 47321;
const minutesArg = process.argv.indexOf("--gather-minutes");
const gatherMinutes = minutesArg > 0 ? Number(process.argv[minutesArg + 1]) : 15;
const openWindow = !process.argv.includes("--no-window");
const factsFile = path.join(dataDir, "facts.json");
const origin = `http://127.0.0.1:${port}`;
const token = crypto.randomBytes(16).toString("hex");
const CARD = /\bBL-\d+/i;
// Chrome slows the timers of a minimized window to one run a minute, so this allows for that.
// A key that every dashboard server of this user shares, so that one can ask another to exit and
// a web page cannot.
const handoverKeyFile = path.join(dataDir, "handover.key");
if (!fs.existsSync(handoverKeyFile)) fs.writeFileSync(handoverKeyFile, crypto.randomBytes(16).toString("hex"));
const handoverKey = fs.readFileSync(handoverKeyFile, "utf8").trim();

const log = m => fs.appendFileSync(serverLog, `${new Date().toISOString()} ${m}\n`);
setLog(log);

// ---- live agent states ----------------------------------------------------------------------
let agents = {};          // normalized worktree path -> { working, waiting, question }
let lastStates = null;    // path -> "working+done" etc., for events.log
let orcaDown = false;
// An agent's state as the dashboard counts it. Orca calls an agent "working" while a background
// Monitor runs in it (workingMode "monitoring"), though it sits at its prompt; that counts as done.
const agentState = a => a.state === "working" && a.workingMode === "monitoring" ? "done" : a.state;
// A line under a working agent's step when it is waiting on its Monitor. The tool it runs is
// left out: the developer does not want tool calls on the dashboard.
function activity(a) {
  return a.workingMode === "monitoring" ? "Waiting on reviewers and CI" : "";
}
// When this server first saw each worktree's agent working on its current prompt. Orca's
// stateStartedAt does not serve: an agent at its prompt with a Monitor running is "working" for
// hours, and a prompt typed into it then leaves stateStartedAt where it was.
const workingSeen = new Map();
function workingSince(p, a) {
  if (!a) { workingSeen.delete(p); return 0; }
  const id = a.paneKey + "|" + a.prompt;
  if (workingSeen.get(p)?.id !== id) workingSeen.set(p, { id, since: Date.now() });
  return workingSeen.get(p).since;
}
async function pollAgents() {
  try {
    const ps = (await orca("worktree", "ps")).worktrees;
    const next = {};
    const states = new Map();
    const runs = readProgress();
    for (const w of ps) {
      const list = w.agents || [];
      const q = list.find(a => a.state === "waiting" && a.programStatus?.kind === "question");
      // A skill started with `claude --continue /<skill>` in Git Bash arrives with the slash
      // rewritten into a Windows path ("C:/Program Files/Git/preflight").
      const skillOf = a => (String(a?.prompt || "").match(/^(?:\/|[A-Za-z]:\/Program Files\/Git\/)([\w-]+)/) || [])[1] || "";
      // Preflight spends much of its half hour waiting on bots with a Monitor, which Orca reports as
      // working in "monitoring" mode. That counts as preflight still running while the run that
      // progress.mjs records there has not ended; once it ends, the agent is at its prompt.
      const run = runs.get(norm(w.path));
      const working = list.find(a => agentState(a) === "working")
        || (run && !run.endedAt && list.find(a => a.state === "working" && skillOf(a) === "preflight"));
      next[norm(w.path)] = {
        working: !!working,
        waiting: list.some(a => a.state === "waiting"),
        question: q ? String(q.programStatus.message || "").replace(/^answer:\s*/, "") : "",
        // The skill a working agent was started on, from the prompt it was given.
        skill: skillOf(working),
        // When it started working on this prompt, and what it is doing now.
        since: workingSince(w.path, working),
        monitoring: working?.workingMode === "monitoring",
        tool: working ? activity(working) : "",
      };
      const card = ((w.branch || "").match(CARD) || (w.path || "").match(CARD) || [])[0]?.toUpperCase();
      if (card) states.set(w.path, { card, s: list.map(agentState).sort().join("+") || "none" });
    }
    agents = next;
    if (lastStates) {
      const lines = [];
      for (const [p, { card, s }] of states) {
        const before = lastStates.get(p)?.s ?? "none";
        if (before !== s) lines.push(`${card} ${p}: ${before} -> ${s}`);
      }
      for (const [p, { card, s }] of lastStates) if (!states.has(p) && s !== "none") lines.push(`${card} ${p}: ${s} -> worktree gone`);
      if (lines.length) fs.appendFileSync(eventsLog, lines.join("\n") + "\n");
    }
    lastStates = states;
    if (orcaDown) fs.appendFileSync(eventsLog, "orca answers again\n");
    orcaDown = false;
  } catch (e) {
    // Report an outage once (Orca disappears for a while when it updates itself).
    if (!orcaDown) fs.appendFileSync(eventsLog, "orca error: " + String(e.message).split("\n")[0] + "\n");
    orcaDown = true;
  }
}

// Reads a JSON file. The session often writes files with PowerShell, which may start them with a
// UTF-8 byte-order mark that JSON.parse rejects, so the mark is dropped first (trimStart counts it as white space).
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").trimStart());

// ---- YouTrack, GitHub and git facts ---------------------------------------------------------
// Runs gather.mjs again for the board of the last facts.json, and appends each difference to
// events.log, so that card States, PR reviews, CI and pushes reach the session the same way agent
// states do. Skipped until the session has written a first facts.json.
const readFacts = () => { try { return readJson(factsFile); } catch { return null; } };
// The error last logged, so a failure that repeats every pass (Orca down for an hour) is logged
// once, with one more line when gathering works again.
let gatherFailing = null;
// The gather in progress, so that the page's Refresh during a scheduled gather waits for that one
// instead of starting a second. Resolves to null, or to why it could not gather.
let running = null;
function regather() {
  running ??= gatherOnce().finally(() => { running = null; });
  return running;
}
async function gatherOnce() {
  const prev = readFacts();
  if (!prev) return "nothing to compare with yet: run /dashboard in Claude once to make the first gather";
  const tmp = factsFile + ".next";
  try {
    await execFileP(process.execPath, [path.join(here, "gather.mjs"), tmp, prev.board || "all"], { windowsHide: true, maxBuffer: 16 << 20 });
    const next = readJson(tmp);
    // The session may have replaced facts.json while gather ran; compare with what is there now.
    const lines = diffFacts(readFacts() || prev, next);
    fs.renameSync(tmp, factsFile);
    if (gatherFailing) lines.unshift("gather works again");
    gatherFailing = null;
    if (lines.length) fs.appendFileSync(eventsLog, lines.join("\n") + "\n");
    log(`regathered: ${lines.length} changes`);
    return null;
  } catch (e) {
    // Node ends an uncaught error's output with its own version line; the line that names the
    // error ("Error: orca worktree list failed; is Orca running?") is the one worth logging.
    const out = String(e.stderr || e.message).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const error = out.find(l => /^\w*Error\b/.test(l)) ?? out[0] ?? "no output";
    if (error !== gatherFailing) fs.appendFileSync(eventsLog, "gather error: " + error + "\n");
    else log("gather error again: " + error);
    gatherFailing = error;
    fs.rmSync(tmp, { force: true });
    return error;
  }
}

// ---- the developer's own review --------------------------------------------------------------
// For each row whose next step is request-peer-review, how much of its PR the developer has
// marked reviewed in GitHub or Reviewable (own-review.mjs), checked once a minute while they
// review. PR URL -> { files, reviewed, left, ... }.
const ownReviews = new Map();
let checkingOwnReviews = false;
async function checkOwnReviews() {
  if (checkingOwnReviews) return;
  checkingOwnReviews = true;
  try {
    let login = "";
    try { login = readJson(path.join(os.homedir(), ".claude", "bloom-developer.json")).github || ""; } catch {}
    if (!login) return;
    const prs = new Set(readState().rows.filter(r => r.pr && r.nextSkill === "request-peer-review").map(r => r.pr));
    for (const pr of [...ownReviews.keys()]) if (!prs.has(pr)) ownReviews.delete(pr);
    for (const pr of prs) {
      try {
        const r = await ownReview(pr, login);
        if (r) ownReviews.set(pr, r); else ownReviews.delete(pr);
      } catch (e) { log(`own review of ${pr} failed: ${e.message}`); }
    }
  } finally { checkingOwnReviews = false; }
}

// ---- state for the page ---------------------------------------------------------------------
// Each worktree's latest preflight run, from the files progress.mjs writes, keyed by its path.
const progressDir = path.join(dataDir, "progress");
function readProgress() {
  const runs = new Map();
  let files = [];
  try { files = fs.readdirSync(progressDir); } catch { return runs; }
  for (const f of files) {
    try {
      const run = readJson(path.join(progressDir, f));
      if (run.worktree) runs.set(norm(run.worktree), run);
    } catch {}
  }
  return runs;
}
// The developer's to-do items for History. Written whole to a temporary file and renamed over
// tasks.json, so a crash mid-write cannot leave half a list.
const tasksFile = path.join(dataDir, "tasks.json");
function readTasks() {
  try { const t = readJson(tasksFile); return Array.isArray(t) ? t : []; } catch { return []; }
}
function changeTask(action, b) {
  const tasks = readTasks();
  const find = () => {
    const t = tasks.find(x => x.id === String(b.id || ""));
    if (!t) throw new Error("no such task");
    return t;
  };
  if (action === "create") {
    const text = String(b.text || "").trim();
    if (!text) throw new Error("a task needs some text");
    tasks.push({ id: crypto.randomUUID(), text, created: new Date().toISOString(), checked: null });
  } else if (action === "check") find().checked = new Date().toISOString();
  else if (action === "uncheck") find().checked = null;
  else if (action === "delete") { find(); tasks.splice(tasks.findIndex(x => x.id === b.id), 1); }
  else throw new Error("unknown task action");
  const tmp = tasksFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, tasksFile);
  return tasks;
}
function readState() {
  let board = "";
  try { board = readJson(path.join(dataDir, "board.json")).board || ""; } catch {}
  const rows = [];
  for (const f of fs.readdirSync(rowsDir)) {
    if (!f.endsWith(".json")) continue;
    // A row's time is when its file was written, not the `updated` the session typed into it,
    // which a session can get wrong.
    try {
      const file = path.join(rowsDir, f);
      rows.push({ ...readJson(file), updated: fs.statSync(file).mtime.toISOString() });
    } catch {}
  }
  // The developer's first name, for the page's top bar.
  let developer = "";
  try { developer = (readJson(path.join(os.homedir(), ".claude", "bloom-developer.json")).name || "").split(" ")[0]; } catch {}
  const facts = readFacts();
  // Each row's PR as "draft" or "open", from the developer's open PRs in the facts, for the link's
  // colour; a PR not among them (merged or closed) is left to the page.
  const openPrs = new Map((facts?.prs || []).map(p => [p.url, p.isDraft ? "draft" : "open"]));
  for (const r of rows) if (r.pr && openPrs.has(r.pr)) r.prState = openPrs.get(r.pr);
  // Whether each row's card has the "Approved Plan" tag, which offers merging without peer review.
  const approved = new Set((facts?.cards || []).filter(c => c.approvedPlan).map(c => c.id));
  for (const r of rows) r.approvedPlan = approved.has(r.card);
  // The PR's mergeability and CI from the facts, and how much of it the developer has reviewed.
  const prFacts = new Map((facts?.prs || []).map(p => [p.url, p]));
  for (const r of rows) {
    const p = prFacts.get(r.pr);
    if (p) { r.prMergeable = p.mergeable; r.prChecks = p.checks; }
    if (ownReviews.has(r.pr)) r.ownReview = ownReviews.get(r.pr);
  }
  // The latest preflight run in each row's worktree, as progress.mjs recorded it.
  const runs = readProgress();
  for (const r of rows) if (r.worktree && runs.has(norm(r.worktree))) r.progress = runs.get(norm(r.worktree));
  return { serverPid: process.pid, board, developer, rows, agents, tasks: readTasks(), standup: facts?.standup || null, backForReview: facts?.backForReview || null, gatheredAt: facts?.gatheredAt || "" };
}

// ---- Orca actions ---------------------------------------------------------------------------
// Runs a skill in the worktree's Claude session: typed into its terminal when Claude is there and
// idle, or in a new Claude terminal when there is none.
const SKILLS = ["preflight", "request-peer-review", "merge-without-peer-review"];
async function runSkill(p, skill) {
  if (!SKILLS.includes(skill)) throw new Error("not a skill the dashboard runs: " + skill);
  const wt = await knownWorktree(p);
  const target = await agentTerminal(wt);
  if (target) {
    if (agentState(target.agent) === "working") throw new Error("Claude is busy in that worktree; open it and wait for it to finish");
    await orca("terminal", "send", "--terminal", target.handle, "--text", "/" + skill, "--enter");
    await orca("terminal", "switch", "--terminal", target.handle);
    log(`sent /${skill} to ${target.handle} in ${wt}`);
  } else {
    await orca("terminal", "create", "--worktree", "path:" + wt, "--title", "Claude", "--command", "claude --continue /" + skill, "--focus");
    log(`started Claude with /${skill} in ${wt}`);
  }
}

async function openInVsCode(p) {
  const wt = await knownWorktree(p);
  await execP("code " + quote(wt), { windowsHide: true });
  log("opened " + wt + " in VS Code");
}

// Makes a worktree for a card (createWorktree) and names it in events.log.
async function createForCard({ card, title, pr }) {
  const { path: made } = await createWorktree({ card, title, pr });
  // The row has no worktree path yet, so this line names the card the row is filed under.
  fs.appendFileSync(eventsLog, `${card} ${made}: worktree created from the dashboard\n`);
}

// ---- HTTP -----------------------------------------------------------------------------------
function page() {
  const html = fs.readFileSync(path.join(here, "board.html"), "utf8");
  return html.replace(/<head[^>]*>/i, m => `${m}<script>window.DASHBOARD_TOKEN=${JSON.stringify(token)};window.DASHBOARD_PID=${process.pid};</script>`);
}
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const IDLE_MINUTES = 5;
function exitWindowClosed(why) {
  log(why + "; exiting");
  console.log("WINDOW_CLOSED: " + why);
  process.exit(0);
}
let lastPageRequest = 0;   // when a page last asked for /api/state; 0 until one has
const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) return send(res, 200, page(), "text/html");
  if (req.method === "GET" && req.url === "/api/state") { lastPageRequest = Date.now(); return send(res, 200, readState()); }
  // `page`: a dashboard page has asked for /api/state in the last 8 seconds, so a window is showing.
  if (req.method === "GET" && req.url === "/api/health") return send(res, 200, { dashboard: true, pid: process.pid, page: Date.now() - lastPageRequest < 8000 });
  if (req.method === "POST" && req.url === "/api/handover") {
    if (req.headers["x-handover-key"] !== handoverKey) return send(res, 403, { ok: false, error: "forbidden" });
    send(res, 200, { ok: true });
    log("handing over to a newer server");
    console.log("REPLACED by a dashboard server that another session started");
    server.close();
    setTimeout(() => process.exit(0), 200);
    return;
  }
  // A local script (work-on-youtrack, after it assigns a card) asks for a gather; it answers at
  // once and the gather runs on.
  // The page's goodbye, sent with navigator.sendBeacon, which cannot set headers: the token is the body.
  if (req.method === "POST" && req.url === "/api/closing") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 200) req.destroy(); });
    req.on("end", () => {
      if (body !== token) return send(res, 403, { ok: false, error: "forbidden" });
      const closingAt = Date.now();
      send(res, 200, { ok: true });
      setTimeout(() => { if (lastPageRequest < closingAt) exitWindowClosed("the dashboard window closed"); }, 5000);
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/show") {
    if (req.headers["x-handover-key"] !== handoverKey) return send(res, 403, { ok: false, error: "forbidden" });
    showWindow().then(how => { log("show: " + how); send(res, 200, { ok: true, how }); }, e => send(res, 500, { ok: false, error: e.message }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/regather") {
    if (req.headers["x-handover-key"] !== handoverKey) return send(res, 403, { ok: false, error: "forbidden" });
    log("regather asked for by a local script");
    regather().catch(e => log("regather: " + e.message));
    return send(res, 202, { ok: true });
  }
  if (req.method !== "POST" || !req.url.startsWith("/api/")) return send(res, 404, { ok: false });
  // Only this server's own page knows the token, so other web pages can't drive Orca.
  if (req.headers["x-dashboard-token"] !== token || (req.headers.origin && req.headers.origin !== origin)) return send(res, 403, { ok: false, error: "forbidden" });
  let body = "";
  req.setEncoding("utf8");
  req.on("data", c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on("end", async () => {
    try {
      const b = body ? JSON.parse(body) : {};
      log("click " + req.url + " " + body);
      if (req.url === "/api/open") await openWorktree(String(b.path || ""));
      else if (req.url === "/api/run-skill") await runSkill(String(b.path || ""), String(b.skill || ""));
      else if (req.url === "/api/vscode") { await openInVsCode(String(b.path || "")); return send(res, 200, { ok: true }); }
      else if (req.url === "/api/gather") { const error = await regather(); return send(res, 200, error ? { ok: false, error } : { ok: true }); }
      else if (req.url === "/api/create") await createForCard({ card: String(b.card || ""), title: String(b.title || ""), pr: String(b.pr || "") });
      else if (req.url.startsWith("/api/task/")) return send(res, 200, { ok: true, tasks: changeTask(req.url.slice(10), b) });
      else return send(res, 404, { ok: false, error: "unknown action" });
      await bringOrcaToFront().catch(e => log("front: " + e.message));
      send(res, 200, { ok: true });
    } catch (e) {
      log("error " + req.url + ": " + e.message);
      send(res, 200, { ok: false, error: e.message });
    }
  });
});

// Opens the page in a Chrome app window. Chrome hands the request to its running instance, so this
// returns at once.
// Brings the dashboard window to the front when a page is open, or opens one. Returns what it did.
async function showWindow() {
  if (Date.now() - lastPageRequest < 8000 && process.platform === "win32") {
    try {
      await execFileP("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "raise-window.ps1"), "-Title", "Bloom Dashboard"], { windowsHide: true });
      return "raised";
    } catch {}   // exit 1: no window with that title, so open one
  }
  openAppWindow();
  return "opened";
}
function openAppWindow() {
  // A server that the Orca plugin starts gets no ProgramFiles or LOCALAPPDATA, hence the fallbacks.
  const candidates = process.platform === "win32"
    ? [process.env.ProgramFiles || "C:/Program Files", process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")]
        .map(d => path.join(d, "Google", "Chrome", "Application", "chrome.exe"))
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"];
  const chrome = candidates.find(p => fs.existsSync(p));
  if (!chrome) { log("no window: chrome not found in " + candidates.join(", ")); return; }
  // Name the profile folder that Chrome uses by default: Chrome started without LOCALAPPDATA (as
  // under the Orca plugin) cannot find it, starts a separate browser with an empty profile, and
  // opens the page's links there instead of in the developer's own Chrome.
  const args = [`--app=${origin}/`, "--window-size=1280,900"];
  if (process.platform === "win32") {
    args.unshift(`--user-data-dir=${path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data")}`);
  }
  spawn(chrome, args, { detached: true, stdio: "ignore" }).unref();
  log("opened an app window with " + chrome);
}

// The pid of the dashboard server on the port, or null when what holds it is not one. A busy
// server can miss one request, so this asks three times.
async function runningDashboardPid() {
  for (let i = 0; i < 3; i++) {
    try {
      const h = await (await fetch(origin + "/api/health", { signal: AbortSignal.timeout(3000) })).json();
      if (h.dashboard) return h.pid;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// Asks the running dashboard server to exit, kills it when it does not agree (a server older than
// /api/handover answers 404), and waits up to 10 s for the port to come free.
async function takeOver(pid) {
  let asked = false;
  try {
    const r = await fetch(origin + "/api/handover", { method: "POST", headers: { "x-handover-key": handoverKey }, signal: AbortSignal.timeout(3000) });
    asked = r.ok;
  } catch {}
  if (!asked) { try { process.kill(pid); } catch {} }
  log(`took over from pid ${pid} (${asked ? "asked it to exit" : "killed it"})`);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { await fetch(origin + "/api/health", { signal: AbortSignal.timeout(500) }); } catch { return; }
  }
}

let tookOver = false;
server.on("error", async e => {
  if (e.code === "EADDRINUSE" && !tookOver) {
    const pid = await runningDashboardPid();
    if (pid) {
      tookOver = true;
      await takeOver(pid);
      server.listen(port, "127.0.0.1");
      return;
    }
    console.log(`PORT_TAKEN ${port} is used by something other than the dashboard; pass --port`);
    process.exit(4);
  }
  console.log("SERVER_ERROR " + e.message);
  process.exit(1);
});

server.on("listening", async () => {
  await pollAgents();
  setInterval(pollAgents, 5000);
  checkOwnReviews();
  setInterval(checkOwnReviews, 60000);
  setInterval(regather, gatherMinutes * 60000);
  setInterval(() => {
    if (lastPageRequest && Date.now() - lastPageRequest > IDLE_MINUTES * 60000) exitWindowClosed(`no dashboard page has asked for ${IDLE_MINUTES} minutes`);
  }, 30000);
  log("listening on " + origin + " pid " + process.pid);
  // After a takeover, a window left open on the old server asks within 3 s and reloads onto this
  // one, so open another only when none has asked.
  if (openWindow && tookOver) setTimeout(() => { if (!lastPageRequest) openAppWindow(); }, 8000);
  else if (openWindow) openAppWindow();
  console.log(`DASHBOARD_URL ${origin}/`);
});
server.listen(port, "127.0.0.1");
