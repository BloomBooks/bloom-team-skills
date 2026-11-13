// Serves the dashboard page on http://127.0.0.1:<port>/ for as long as the Claude session that
// started it is open, and does what the page's buttons ask in Orca.
//
// Usage: node server.mjs [--port N] [--gather-minutes M] [--no-window] [--keep-sessions] [--revive]
//   (defaults 47321 and 15)
//
// Once listening, it opens the page in a Chrome app window (chrome --app=<url>): a window of its
// own, with no tabs or address bar and its own taskbar button. --no-window leaves that out.
// --keep-sessions leaves every Claude session alone (see "sessions that exist only for the
// dashboard" below); the tests run the server with both. --revive is how the Orca plugin starts
// a server in place of one that was killed: a window still open on the killed one reloads onto
// this one, so it opens a window only when no page asks within 8 seconds.
//
// Data lives in ~/.claude/bloom-dashboard/:
//   board.json     { "board": "Bloom 6.6" }  the Kanban Board the rows were gathered for
//   rows/<id>.json one row per card (fields in SKILL.md, step 4); the session writes these, and
//                  row-facts.mjs's rowProblems says what is wrong with one
//   facts.json     the last output of gather.mjs; the session writes the first, and this server
//                  replaces it every M minutes
//   events.log     this server appends a line whenever an agent in a card's worktree changes
//                  state, e.g. "BL-16775 D:/BL-16775-grade-branding-2: working -> waiting", for
//                  each change between one facts.json and the next (see diff-facts.mjs), for
//                  each worktree the page's Create button makes, and for each problem with a row
//                  the session wrote, e.g. "BL-16775 row: has group "nearly", ..."; the session
//                  watches it with watch-events.mjs
//   progress/<worktree>.json  a preflight run's phases, written by progress.mjs
//   tasks.json     the developer's to-do items for History (tasks.mjs)
//   running.json   { "pid": N, "port": P } while this server runs; a stop below removes it, so
//                  one left behind with a dead pid means the server was killed (Claude Code ends
//                  background commands when memory runs short), and the Orca plugin starts
//                  another
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
// "PORT_TAKEN" (exit 4) when something other than a dashboard holds the port. The dashboard
// session waits for these lines (SKILL.md, step 1) and server.test.mjs checks them.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { diffFacts } from "./diff-facts.mjs";
import { ownReview } from "./own-review.mjs";
import { prComments } from "./pr-comments.mjs";
import { STANDUP } from "./standup.mjs";
import { changeTask, readTasks, TASK_ACTIONS } from "./tasks.mjs";
import { agentEventLines, agentStates, cardOf, checkoutState, dataDir, enrichRows, liveAgents, readJson, readProgress, readRowFiles, rowsDir } from "./row-facts.mjs";
import { orca, norm, setLog, bringOrcaToFront, openWorktree, createWorktree, runSkill, openInVsCode } from "../orca-worktrees.mjs";

const execFileP = promisify(execFile);
const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
// The Orca plugin starts this server from Orca's install folder with ELECTRON_RUN_AS_NODE set.
// There a command named `orca` finds Orca.exe in the current folder before the orca CLI on PATH
// and runs it as Node, so every `orca` command fails with "Cannot find module ...\orca\worktree".
process.chdir(here);
delete process.env.ELECTRON_RUN_AS_NODE;
fillInUserEnvironment();

// A server that the Orca plugin starts gets Orca's worker environment, which lacks most of the
// developer's own variables: REVIEWABLE_API_TOKEN, without which own-review.mjs reads no marks
// from Reviewable and every file counts as unreviewed, and the user Path entries that find the
// `reviewable` CLI. This adds each variable from the Windows user and machine environment that
// the process lacks, and the Path entries it lacks.
function fillInUserEnvironment() {
  if (process.platform !== "win32") return;
  const expand = v => v.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
    let text;
    try { text = execFileSync("reg.exe", ["query", key], { encoding: "utf8", windowsHide: true }); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s{4}(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
      if (!m) continue;
      const [, name, value] = m;
      if (name.toLowerCase() === "path") {
        const have = new Set((process.env.Path || process.env.PATH || "").split(";").map(p => p.toLowerCase()));
        const add = expand(value).split(";").filter(p => p && !have.has(p.toLowerCase()));
        if (add.length) process.env.Path = [process.env.Path || process.env.PATH || "", ...add].filter(Boolean).join(";");
      } else if (process.env[name] === undefined) {
        process.env[name] = expand(value);
      }
    }
  }
}
const data = dataDir();
const eventsLog = path.join(data, "events.log");
const serverLog = path.join(data, "server.log");
const factsFile = path.join(data, "facts.json");
const tasksFile = path.join(data, "tasks.json");
const developerFile = path.join(os.homedir(), ".claude", "bloom-developer.json");
fs.mkdirSync(rowsDir(), { recursive: true });
fs.appendFileSync(eventsLog, "");

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg("--port") ?? 47321);
const gatherMinutes = Number(arg("--gather-minutes") ?? 15);
const openWindow = !process.argv.includes("--no-window");
const manageSessions = !process.argv.includes("--keep-sessions");
const revive = process.argv.includes("--revive");
const runningFile = path.join(data, "running.json");
const origin = `http://127.0.0.1:${port}`;
const token = crypto.randomBytes(16).toString("hex");
// A key that every dashboard server of this user shares, so that one can ask another to exit and
// a web page cannot.
const handoverKeyFile = path.join(data, "handover.key");
if (!fs.existsSync(handoverKeyFile)) fs.writeFileSync(handoverKeyFile, crypto.randomBytes(16).toString("hex"));
const handoverKey = fs.readFileSync(handoverKeyFile, "utf8").trim();

const log = m => fs.appendFileSync(serverLog, `${new Date().toISOString()} ${m}\n`);
const event = lines => { if (lines.length) fs.appendFileSync(eventsLog, lines.join("\n") + "\n"); };
setLog(log);

// A source that can fail for a while (Orca updating itself, YouTrack down): its error goes to
// events.log when it starts failing and again only when the error changes, so a failure that
// repeats every pass is one line, and `recovered` goes there once it works again.
function outage(name, recovered) {
  let failing = null;
  return {
    fail(error) {
      if (error !== failing) event([`${name} error: ${error}`]);
      else log(`${name} error again: ${error}`);
      failing = error;
    },
    ok() {
      if (failing) event([recovered]);
      failing = null;
    },
  };
}

// ---- live agent states ----------------------------------------------------------------------
let agents = {};          // norm(worktree path) -> liveAgents() of its agents
let lastStates = null;    // worktree path -> { card, s }, for agentEventLines
const workingSeen = new Map();
// norm(worktree path) -> checkoutState(), for each worktree whose last preflight run has ended, so
// the page can tell when the code changed after it.
let checkouts = new Map();
const orcaOutage = outage("orca", "orca answers again");
async function pollAgents() {
  try {
    const ps = (await orca("worktree", "ps")).worktrees;
    const runs = readProgress();
    const ended = ps.filter(w => runs.get(norm(w.path))?.endedAt);
    checkouts = new Map((await Promise.all(ended.map(async w => [norm(w.path), await checkoutState(w.path, runs.get(norm(w.path)).head)]))).filter(([, c]) => c));
    const next = {};
    const states = new Map();
    for (const w of ps) {
      next[norm(w.path)] = liveAgents(w, runs.get(norm(w.path)), workingSeen);
      const card = cardOf(w.branch, w.path);
      if (card) states.set(w.path, { card, s: agentStates(w.agents) });
    }
    agents = next;
    if (lastStates) event(agentEventLines(lastStates, states));
    lastStates = states;
    orcaOutage.ok();
  } catch (e) {
    orcaOutage.fail(String(e.message).split("\n")[0]);
  }
}

// ---- YouTrack, GitHub and git facts ---------------------------------------------------------
// Runs gather.mjs again for the board of the last facts.json, and appends each difference to
// events.log, so that card States, PR reviews, CI and pushes reach the session the same way agent
// states do. Skipped until the session has written a first facts.json.
const readFacts = () => { try { return readJson(factsFile); } catch { return null; } };
const gatherOutage = outage("gather", "gather works again");
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
    gatherOutage.ok();
    event(lines);
    log(`regathered: ${lines.length} changes`);
    return null;
  } catch (e) {
    // Node ends an uncaught error's output with its own version line; the line that names the
    // error ("Error: orca worktree list failed; is Orca running?") is the one worth logging.
    const out = String(e.stderr || e.message).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const error = out.find(l => /^\w*Error\b/.test(l)) ?? out[0] ?? "no output";
    gatherOutage.fail(error);
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
    try { login = readJson(developerFile).github || ""; } catch {}
    if (!login) return;
    const prs = new Set(readRowFiles().rows.filter(r => r.pr && r.nextSkill === "request-peer-review").map(r => r.pr));
    for (const pr of [...ownReviews.keys()]) if (!prs.has(pr)) ownReviews.delete(pr);
    for (const pr of prs) {
      try {
        const r = await ownReview(pr, login);
        if (r) ownReviews.set(pr, r); else ownReviews.delete(pr);
      } catch (e) { log(`own review of ${pr} failed: ${e.message}`); }
    }
  } finally { checkingOwnReviews = false; }
}

// ---- the comments waiting on each PR ---------------------------------------------------------
// For each row with an open PR, the comments that wait to be processed (pr-comments.mjs), checked
// once a minute. PR URL -> { total, from }.
const commentsOfPr = new Map();
let checkingComments = false;
async function checkComments() {
  if (checkingComments) return;
  checkingComments = true;
  try {
    let login = "";
    try { login = readJson(developerFile).github || ""; } catch {}
    if (!login) return;
    const open = new Set((readFacts()?.prs || []).map(p => p.url));
    const prs = new Set(readRowFiles().rows.map(r => r.pr).filter(pr => pr && open.has(pr)));
    for (const pr of [...commentsOfPr.keys()]) if (!prs.has(pr)) commentsOfPr.delete(pr);
    for (const pr of prs) {
      try {
        const c = await prComments(pr, login);
        if (c) commentsOfPr.set(pr, c); else commentsOfPr.delete(pr);
      } catch (e) { log(`comments of ${pr} failed: ${e.message}`); }
    }
  } finally { checkingComments = false; }
}

// ---- state for the page ---------------------------------------------------------------------
// The problems with the session's rows that events.log has already been told about, as
// "<file>: <problem>". One that goes away and comes back is told again.
let toldProblems = new Set();
function reportRowProblems(problems) {
  const now = new Set(problems.map(p => `${p.file}: ${p.problem}`));
  event(problems.filter(p => !toldProblems.has(`${p.file}: ${p.problem}`)).map(p => `${p.card} row: ${p.problem} (rows/${p.file})`));
  toldProblems = now;
}
function readState() {
  let board = "";
  try { board = readJson(path.join(data, "board.json")).board || ""; } catch {}
  const { rows, problems } = readRowFiles();
  reportRowProblems(problems);
  // The developer's first name, for the page's top bar.
  let developer = "";
  try { developer = (readJson(developerFile).name || "").split(" ")[0]; } catch {}
  const facts = readFacts();
  enrichRows(rows, facts, ownReviews, readProgress(), checkouts, Date.now(), commentsOfPr);
  return {
    serverPid: process.pid, board, developer, rows, problems, agents, tasks: readTasks(tasksFile),
    standup: facts?.standup || null, standupAt: STANDUP, backForReview: facts?.backForReview || null, gatheredAt: facts?.gatheredAt || "",
  };
}

// Makes a worktree for a card (createWorktree) and names it in events.log.
async function createForCard({ card, title, pr }) {
  const { path: made } = await createWorktree({ card, title, pr });
  // The row has no worktree path yet, so this line names the card the row is filed under.
  event([`${card} ${made}: worktree created from the dashboard`]);
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
function readBody(req, limit) {
  return new Promise(resolve => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > limit) req.destroy(); });
    req.on("end", () => resolve(body));
  });
}

// The page's buttons: path -> what it does with the posted body. Each that drives Orca brings
// Orca's window to the front afterwards (`front`).
const ACTIONS = {
  "/api/open": { front: true, run: b => openWorktree(String(b.path || "")) },
  "/api/run-skill": { front: true, run: b => runSkill(String(b.path || ""), String(b.skill || "")) },
  "/api/create": { front: true, run: b => createForCard({ card: String(b.card || ""), title: String(b.title || ""), pr: String(b.pr || "") }) },
  "/api/vscode": { run: b => openInVsCode(String(b.path || "")) },
  "/api/gather": { run: async () => { const error = await regather(); if (error) throw new Error(error); } },
  ...Object.fromEntries(TASK_ACTIONS.map(a => ["/api/task/" + a, { run: b => ({ tasks: changeTask(tasksFile, a, b) }) }])),
};

// ---- sessions that exist only for the dashboard ----------------------------------------------
// The Orca plugin's button starts `claude "Open the dashboard"`. Such a session has nothing to do
// once its server is gone, and each one holds about 300 MB, so a server kills them: on listening,
// every one that started before it other than its own; on exiting, its own, unless that session
// started the server that took over. A /dashboard typed
// into a working session has another command line and is never touched. --keep-sessions turns
// this off.
const serverStarted = Date.now();
const DEDICATED = /^"?[^"]*claude(\.exe)?"?\s+"?Open the dashboard"?\s*$/i;

// Every process as { pid, ppid, name, cmd, created }, or [] off Windows or when the list fails.
async function processes() {
  if (process.platform !== "win32" || !manageSessions) return [];
  try {
    const ps = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; created = $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout).map(p => ({ ...p, created: Date.parse(p.created) }));
  } catch (e) {
    log("could not list processes: " + e.message);
    return [];
  }
}
const isDedicated = p => /^claude(\.exe)?$/i.test(p.name || "") && DEDICATED.test((p.cmd || "").trim());

// The pids from this process up to the first claude.exe above it, this process first.
function ancestry(all) {
  const byPid = new Map(all.map(p => [p.pid, p]));
  const chain = [];
  for (let p = byPid.get(process.pid); p && !chain.includes(p.pid); p = byPid.get(p.ppid)) {
    chain.push(p.pid);
    if (/^claude(\.exe)?$/i.test(p.name || "")) break;
  }
  return chain;
}
function descendants(all, pid) {
  const out = [];
  for (const p of all) if (p.ppid === pid && p.pid !== pid) out.push(p.pid, ...descendants(all, p.pid));
  return out;
}
function kill(pid) { try { process.kill(pid); } catch {} }

async function endStaleSessions() {
  const all = await processes();
  const chain = ancestry(all);
  for (const p of all) {
    if (!isDedicated(p) || chain.includes(p.pid) || !(p.created < serverStarted)) continue;
    for (const d of descendants(all, p.pid)) kill(d);
    kill(p.pid);
    log(`ended the dashboard session pid ${p.pid}, which started ${new Date(p.created).toISOString()} and had no server`);
  }
}

// Kills the session that started this server when it exists only for the dashboard, with its other
// child processes (its event watch), leaving this process and the shell between to exit on their own.
async function endOwnSession() {
  const all = await processes();
  const chain = ancestry(all);
  const own = all.find(p => p.pid === chain[chain.length - 1]);
  if (!own || !isDedicated(own)) return;
  const below = descendants(all, own.pid);
  // The same session started the server that took over from this one, and keeps it.
  const byPid = new Map(all.map(p => [p.pid, p]));
  const newer = below.find(d => d !== process.pid && /\bserver\.mjs\b/.test(byPid.get(d)?.cmd || ""));
  if (newer) { log(`left the dashboard session pid ${own.pid} open: it started server pid ${newer}`); return; }
  for (const d of below) if (!chain.includes(d)) kill(d);
  kill(own.pid);
  log(`ended this server's dashboard session pid ${own.pid}`);
}

// ---- stopping -------------------------------------------------------------------------------
// The server stops once, for the first of: the window closed, no page for IDLE_MINUTES, or a newer
// server took over. `line` goes to stdout for the session that started it.
const IDLE_MINUTES = 5;
let stopping = false;
async function stop(line, why) {
  if (stopping) return;
  stopping = true;
  log(why + "; exiting");
  console.log(line);
  // A newer server that took over may already have written its own.
  try { if (JSON.parse(fs.readFileSync(runningFile, "utf8")).pid === process.pid) fs.rmSync(runningFile); } catch {}
  server.close();
  await endOwnSession().catch(e => log("ending own session: " + e.message));
  process.exit(0);
}

let lastPageRequest = 0;   // when a page last asked for /api/state; 0 until one has
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split("?")[0];
  if (req.method === "GET") {
    if (pathname === "/" || pathname === "/index.html") return send(res, 200, page(), "text/html");
    // The page's styles and its code for drawing a row, which the Worktree panel in Orca loads too.
    const shared = { "/dashboard.css": "text/css", "/row.js": "text/javascript" };
    if (shared[pathname]) return send(res, 200, fs.readFileSync(path.join(here, pathname.slice(1)), "utf8"), shared[pathname]);
    if (/^\/icons\/icon-\d+\.png$/.test(pathname) && fs.existsSync(path.join(here, pathname.slice(1)))) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
      return res.end(fs.readFileSync(path.join(here, pathname.slice(1))));
    }
    if (pathname === "/api/state") { lastPageRequest = Date.now(); return send(res, 200, readState()); }
    // `page`: a dashboard page has asked for /api/state in the last 8 seconds, so a window is showing.
    if (pathname === "/api/health") return send(res, 200, { dashboard: true, pid: process.pid, page: Date.now() - lastPageRequest < 8000 });
    return send(res, 404, { ok: false });
  }
  if (req.method !== "POST") return send(res, 404, { ok: false });

  // Requests from local programs, which can read handover.key: another dashboard server, the Orca
  // plugin's button, and a script that changed a card (work-on-youtrack).
  const local = { "/api/handover": true, "/api/show": true, "/api/regather": true };
  if (local[pathname]) {
    if (req.headers["x-handover-key"] !== handoverKey) return send(res, 403, { ok: false, error: "forbidden" });
    if (pathname === "/api/handover") {
      send(res, 200, { ok: true });
      setTimeout(() => stop("REPLACED by a dashboard server that another session started", "handing over to a newer server"), 200);
    } else if (pathname === "/api/show") {
      showWindow().then(how => { log("show: " + how); send(res, 200, { ok: true, how }); }, e => send(res, 500, { ok: false, error: e.message }));
    } else {
      // It answers at once and the gather runs on.
      log("regather asked for by a local script");
      regather().catch(e => log("regather: " + e.message));
      send(res, 202, { ok: true });
    }
    return;
  }

  // The page's goodbye, sent with navigator.sendBeacon, which cannot set headers: the token is the body.
  if (pathname === "/api/closing") {
    const body = await readBody(req, 200);
    if (body !== token) return send(res, 403, { ok: false, error: "forbidden" });
    const closingAt = Date.now();
    send(res, 200, { ok: true });
    setTimeout(() => { if (lastPageRequest < closingAt) stop("WINDOW_CLOSED: the dashboard window closed", "the dashboard window closed"); }, 5000);
    return;
  }

  // Only this server's own page knows the token, so other web pages can't drive Orca.
  if (req.headers["x-dashboard-token"] !== token || (req.headers.origin && req.headers.origin !== origin)) return send(res, 403, { ok: false, error: "forbidden" });
  const act = ACTIONS[pathname];
  if (!act) return send(res, 404, { ok: false, error: "unknown action" });
  const body = await readBody(req, 1e5);
  try {
    const b = body ? JSON.parse(body) : {};
    log("click " + pathname + " " + body);
    const result = await act.run(b);
    if (act.front) await bringOrcaToFront().catch(e => log("front: " + e.message));
    send(res, 200, { ok: true, ...(result && typeof result === "object" ? result : {}) });
  } catch (e) {
    log("error " + pathname + ": " + e.message);
    send(res, 200, { ok: false, error: e.message });
  }
});

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
// Opens the page in a Chrome app window. Chrome hands the request to its running instance, so this
// returns at once.
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
  if (!asked) kill(pid);
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
  checkComments();
  setInterval(checkComments, 60000);
  setInterval(regather, gatherMinutes * 60000);
  // Chrome slows the timers of a minimized window to one run a minute, which IDLE_MINUTES allows for.
  setInterval(() => {
    if (lastPageRequest && Date.now() - lastPageRequest > IDLE_MINUTES * 60000) {
      const why = `no dashboard page has asked for ${IDLE_MINUTES} minutes`;
      stop("WINDOW_CLOSED: " + why, why);
    }
  }, 30000);
  log("listening on " + origin + " pid " + process.pid + (revive ? " (revived by the Orca plugin)" : ""));
  // Rewritten every 5 s: the Orca plugin revives only a server that was running a minute ago,
  // not one that a restart of the machine ended hours before.
  const markRunning = () => { if (!stopping) fs.writeFileSync(runningFile, JSON.stringify({ pid: process.pid, port })); };
  markRunning();
  setInterval(markRunning, 5000);
  endStaleSessions().catch(e => log("ending stale sessions: " + e.message));
  // After a takeover or a revive, a window left open on the old server asks within 3 s and reloads
  // onto this one, so open another only when none has asked.
  if (openWindow && (tookOver || revive)) setTimeout(() => { if (!lastPageRequest) openAppWindow(); }, 8000);
  else if (openWindow) openAppWindow();
  console.log(`DASHBOARD_URL ${origin}/`);
});
server.listen(port, "127.0.0.1");
