// Serves the dashboard page on http://127.0.0.1:<port>/ for as long as the Claude session that
// started it is open, and does what the page's buttons ask in Orca.
//
// Usage: node server.mjs [--port N] [--gather-minutes M]   (defaults 47321 and 15)
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
//
// stdout: "DASHBOARD_URL <url>" once listening, or "ALREADY_RUNNING <url> pid <pid>" (exit 3)
// when another session's server holds the port.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { diffFacts } from "./diff-facts.mjs";

const execP = promisify(exec);
const execFileP = promisify(execFile);
const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
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
const factsFile = path.join(dataDir, "facts.json");
const origin = `http://127.0.0.1:${port}`;
const token = crypto.randomBytes(16).toString("hex");
const CARD = /\bBL-\d+/i;

const log = m => fs.appendFileSync(serverLog, `${new Date().toISOString()} ${m}\n`);
const norm = p => (p || "").replace(/\\/g, "/").toLowerCase();

// orca is a .cmd shim on Windows, so it runs through a shell. Every argument is either fixed text
// or has been checked against the patterns below, and none may contain a quote or a % sign.
function quote(a) {
  if (/["%\r\n]/.test(a)) throw new Error("refusing an argument with a quote, % or newline: " + a);
  return /^[\w.:\/@-]+$/.test(a) ? a : `"${a}"`;
}
async function orca(...args) {
  const cli = process.env.ORCA_CLI_COMMAND || "orca";
  let stdout;
  try {
    ({ stdout } = await execP([cli, ...args.map(quote), "--json"].join(" "), { maxBuffer: 64 << 20, windowsHide: true }));
  } catch (e) {
    // A failing orca exits non-zero with its JSON error on stdout; report that, not just "Command failed".
    if (!String(e.stdout || "").includes("{")) throw e;
    stdout = e.stdout;
  }
  const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
  if (j.ok === false) throw new Error(`orca ${args[0]} ${args[1]}: ${j.error?.code || "failed"} ${j.error?.message || ""}`.trim());
  return j.result;
}

// ---- live agent states ----------------------------------------------------------------------
let agents = {};          // normalized worktree path -> { working, waiting, question }
let lastStates = null;    // path -> "working+done" etc., for events.log
let orcaDown = false;
async function pollAgents() {
  try {
    const ps = (await orca("worktree", "ps")).worktrees;
    const next = {};
    const states = new Map();
    for (const w of ps) {
      const list = w.agents || [];
      const q = list.find(a => a.state === "waiting" && a.programStatus?.kind === "question");
      const working = list.find(a => a.state === "working");
      next[norm(w.path)] = {
        working: !!working,
        waiting: list.some(a => a.state === "waiting"),
        question: q ? String(q.programStatus.message || "").replace(/^answer:\s*/, "") : "",
        // The skill a working agent was started on, from the prompt it was given.
        skill: (String(working?.prompt || "").match(/^\/([\w-]+)/) || [])[1] || "",
      };
      const card = ((w.branch || "").match(CARD) || (w.path || "").match(CARD) || [])[0]?.toUpperCase();
      if (card) states.set(w.path, { card, s: list.map(a => a.state).sort().join("+") || "none" });
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

// ---- YouTrack, GitHub and git facts ---------------------------------------------------------
// Runs gather.mjs again for the board of the last facts.json, and appends each difference to
// events.log, so that card States, PR reviews, CI and pushes reach the session the same way agent
// states do. Skipped until the session has written a first facts.json.
const readFacts = () => { try { return JSON.parse(fs.readFileSync(factsFile, "utf8")); } catch { return null; } };
let gathering = false;
// The error last logged, so a failure that repeats every pass (Orca down for an hour) is logged
// once, with one more line when gathering works again.
let gatherFailing = null;
async function regather() {
  const prev = readFacts();
  if (!prev || gathering) return;
  gathering = true;
  const tmp = factsFile + ".next";
  try {
    await execFileP(process.execPath, [path.join(here, "gather.mjs"), tmp, prev.board || "all"], { windowsHide: true, maxBuffer: 16 << 20 });
    const next = JSON.parse(fs.readFileSync(tmp, "utf8"));
    // The session may have replaced facts.json while gather ran; compare with what is there now.
    const lines = diffFacts(readFacts() || prev, next);
    fs.renameSync(tmp, factsFile);
    if (gatherFailing) lines.unshift("gather works again");
    gatherFailing = null;
    if (lines.length) fs.appendFileSync(eventsLog, lines.join("\n") + "\n");
    log(`regathered: ${lines.length} changes`);
  } catch (e) {
    // Node ends an uncaught error's output with its own version line; the line that names the
    // error ("Error: orca worktree list failed; is Orca running?") is the one worth logging.
    const out = String(e.stderr || e.message).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const error = out.find(l => /^\w*Error\b/.test(l)) ?? out[0] ?? "no output";
    if (error !== gatherFailing) fs.appendFileSync(eventsLog, "gather error: " + error + "\n");
    else log("gather error again: " + error);
    gatherFailing = error;
    fs.rmSync(tmp, { force: true });
  } finally {
    gathering = false;
  }
}

// ---- state for the page ---------------------------------------------------------------------
function readState() {
  let board = "";
  try { board = JSON.parse(fs.readFileSync(path.join(dataDir, "board.json"), "utf8")).board || ""; } catch {}
  const rows = [];
  for (const f of fs.readdirSync(rowsDir)) {
    if (!f.endsWith(".json")) continue;
    try { rows.push(JSON.parse(fs.readFileSync(path.join(rowsDir, f), "utf8"))); } catch {}
  }
  // The developer's first name, for the page's top bar.
  let developer = "";
  try { developer = (JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "bloom-developer.json"), "utf8")).name || "").split(" ")[0]; } catch {}
  return { board, developer, rows, agents, gatheredAt: readFacts()?.gatheredAt || "" };
}

// ---- Orca actions ---------------------------------------------------------------------------
let orcaExe = null;
async function bringOrcaToFront() {
  // Launching Orca.exe again makes the running Orca bring its window to the front (its
  // second-instance handler); the CLI calls only change what it shows.
  if (!orcaExe && process.platform === "win32") {
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-Command",
      "(Get-Process -Name Orca -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path"], { windowsHide: true });
    orcaExe = stdout.trim() || null;
  }
  if (orcaExe) spawn(orcaExe, [], { detached: true, stdio: "ignore" }).unref();
}

async function knownWorktree(p) {
  const w = (await orca("worktree", "list")).worktrees.find(x => !x.isArchived && norm(x.path) === norm(p));
  if (!w) throw new Error("Orca has no worktree at " + p);
  return w.path;
}

// The worktree's Claude terminal, if it has one: { handle, agent }. With several agents, a waiting
// one comes first, then a working one, so the Status pill opens the terminal it describes.
async function agentTerminal(wt) {
  const terms = (await orca("terminal", "list", "--worktree", "path:" + wt)).terminals;
  const ps = (await orca("worktree", "ps")).worktrees.find(x => norm(x.path) === norm(wt));
  const rank = a => ({ waiting: 0, working: 1 })[a.state] ?? 2;
  for (const a of [...(ps?.agents || [])].sort((x, y) => rank(x) - rank(y))) {
    const t = terms.find(t => `${t.tabId}:${t.leafId}` === a.paneKey);
    if (t) return { handle: t.handle, agent: a };
  }
  return null;
}

// Switches Orca to the worktree's agent terminal; with no agent there, starts Claude in it,
// resuming that worktree's last conversation when there is one.
async function openWorktree(p) {
  const wt = await knownWorktree(p);
  const target = await agentTerminal(wt);
  if (target) {
    await orca("terminal", "switch", "--terminal", target.handle);
    log("switched to agent " + target.handle + " in " + wt);
  } else {
    await orca("terminal", "create", "--worktree", "path:" + wt, "--title", "Claude", "--command", "claude --continue || claude", "--focus");
    log("started Claude in " + wt);
  }
}

// Runs a skill in the worktree's Claude session: typed into its terminal when Claude is there and
// idle, or in a new Claude terminal when there is none.
const SKILLS = ["preflight", "pr-ready-for-human"];
async function runSkill(p, skill) {
  if (!SKILLS.includes(skill)) throw new Error("not a skill the dashboard runs: " + skill);
  const wt = await knownWorktree(p);
  const target = await agentTerminal(wt);
  if (target) {
    if (target.agent.state === "working") throw new Error("Claude is busy in that worktree; open it and wait for it to finish");
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

// Makes a worktree for a card that has none and starts Claude in it. Orca names the worktree's
// branch itself from --name (adding its branch prefix, e.g. "JohnThomson/"); it has no --branch
// flag. Without a PR, that branch, <prefix><card>-<first three words of the title>, is new from
// the repo's default base. With a PR, the worktree is switched onto the PR's own branch before
// Claude starts, and Orca's prefixed branch is deleted.
async function createWorktree({ card, title, pr }) {
  if (!/^BL-\d+$/.test(card || "")) throw new Error("bad card id " + card);
  let repo = "bloombooks/bloomdesktop", prNumber = null;
  const m = (pr || "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  if (m) { repo = m[1].toLowerCase(); prNumber = m[2]; }
  const repoId = (await orca("worktree", "list")).worktrees.find(w => w.projectId === "github:" + repo)?.repoId;
  if (!repoId) throw new Error("Orca has no repo for github:" + repo);
  const args = ["worktree", "create", "--repo", "id:" + repoId, "--no-parent", "--activate"];
  if (!prNumber) {
    const words = (title || "").replace(/\[[^\]]*\]/g, "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 3);
    const r = await orca(...args, "--agent", "claude", "--name", [card, ...words].join("-"));
    const made = r.worktree?.path || r.worktreeId;
    log("created " + made + " for " + card);
    // The row has no worktree path yet, so this line names the card the row is filed under.
    fs.appendFileSync(eventsLog, `${card} ${made}: worktree created from the dashboard\n`);
    return;
  }
  const { stdout } = await execFileP("gh", ["pr", "view", prNumber, "-R", repo, "--json", "headRefName", "--jq", ".headRefName"], { windowsHide: true });
  const head = stdout.trim();
  if (!/^[\w.\/-]+$/.test(head)) throw new Error("could not read the branch of " + pr);
  const repoPath = (await orca("repo", "list")).repos.find(r => r.id === repoId)?.path;
  await execFileP("git", ["-C", repoPath, "fetch", "origin", head], { windowsHide: true });
  const before = new Set((await orca("worktree", "list")).worktrees.map(w => norm(w.path)));
  const r = await orca(...args, "--name", head.replace(/\//g, "-"), "--base-branch", "origin/" + head, "--pr", prNumber);
  const wt = r.worktree?.path || (await orca("worktree", "list")).worktrees.find(w => w.repoId === repoId && !before.has(norm(w.path)))?.path;
  if (!wt) throw new Error("Orca made the worktree but did not say where; switch it to " + head + " by hand");
  const orcaBranch = (await execFileP("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { windowsHide: true })).stdout.trim();
  // A local branch named like the PR's makes "git switch" use it; otherwise it creates one tracking origin.
  await execFileP("git", ["-C", wt, "switch", head], { windowsHide: true });
  if (orcaBranch && orcaBranch !== head) await execFileP("git", ["-C", wt, "branch", "-D", orcaBranch], { windowsHide: true }).catch(e => log("could not delete " + orcaBranch + ": " + e.message));
  await orca("terminal", "create", "--worktree", "path:" + wt, "--title", "Claude", "--command", "claude", "--focus");
  log("created " + wt + " on " + head + " for " + card);
  fs.appendFileSync(eventsLog, `${card} ${wt}: worktree created from the dashboard\n`);
}

// ---- HTTP -----------------------------------------------------------------------------------
function page() {
  const html = fs.readFileSync(path.join(here, "board.html"), "utf8");
  return html.replace(/<head[^>]*>/i, m => `${m}<script>window.DASHBOARD_TOKEN=${JSON.stringify(token)};</script>`);
}
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) return send(res, 200, page(), "text/html");
  if (req.method === "GET" && req.url === "/api/state") return send(res, 200, readState());
  if (req.method === "GET" && req.url === "/api/health") return send(res, 200, { dashboard: true, pid: process.pid });
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
      else if (req.url === "/api/create") await createWorktree({ card: String(b.card || ""), title: String(b.title || ""), pr: String(b.pr || "") });
      else return send(res, 404, { ok: false, error: "unknown action" });
      await bringOrcaToFront().catch(e => log("front: " + e.message));
      send(res, 200, { ok: true });
    } catch (e) {
      log("error " + req.url + ": " + e.message);
      send(res, 200, { ok: false, error: e.message });
    }
  });
});

server.on("error", async e => {
  if (e.code === "EADDRINUSE") {
    try {
      const h = await (await fetch(origin + "/api/health")).json();
      if (h.dashboard) { console.log(`ALREADY_RUNNING ${origin}/ pid ${h.pid}`); process.exit(3); }
    } catch {}
    console.log(`PORT_TAKEN ${port} is used by something other than the dashboard; pass --port`);
    process.exit(4);
  }
  console.log("SERVER_ERROR " + e.message);
  process.exit(1);
});

server.listen(port, "127.0.0.1", async () => {
  await pollAgents();
  setInterval(pollAgents, 5000);
  setInterval(regather, gatherMinutes * 60000);
  log("listening on " + origin + " pid " + process.pid);
  console.log(`DASHBOARD_URL ${origin}/`);
});
