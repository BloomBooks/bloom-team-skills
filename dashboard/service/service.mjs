// The dashboard service: one process on each developer's machine that holds every fact the
// dashboard page and Orca's Worktree panel show, computes each card's row (rows.mjs), and does
// what their buttons ask. Orca's Bloom plugin starts it (plugin/worker.ts), and it exits once Orca
// has quit (exitWhenOrcaIsGone), whether or not any Claude session is open. Nothing here needs an
// LLM except the prose in prose.mjs.
//
// Usage: node service.mjs [--wait <ms>] [--no-window] [--check-only] [--orca <pid>]
//   --orca        Orca's process, which a restart hands to its new process
//   --wait        when the port is taken, keep trying for this long (a restart's new process
//                 waits for the old one to go); without it a second start exits at once
//   --check-only  load every module and exit, which is how a running service tests new code
//                 before it restarts onto it
//
// Where each fact comes from:
//   pushed   Claude Code hooks (POST /hook): a session's prompts, the skill it began, the end of
//            its turn with what is still in flight, its end.
//            The skills' progress.mjs (a file in progress/, then POST /tell): preflight's phases
//            and its end.
//            The Orca plugin's worker (POST /orca): an agent's status changed, a worktree came or
//            went. The service then reads `orca worktree ps` once for the detail.
//            A file watch on each row's worktree git folder.
//   polled   only while a page or panel is visible (`visible()`): cards, PRs and worktrees
//            (gather.mjs, CORE_MS), the slower lists (FULL_MS), the developer's review marks and
//            the comments waiting on each PR (Reviewable, one request at a time), git for
//            uncommitted edits (GIT_MS). A surface becoming visible, the window gaining focus,
//            Refresh and a skill's /tell each bring the next read forward.
//   checked  every LIVENESS_MS, in this process: whether each session with an open run still has
//            its process, and whether Orca still has its own.
//
// HTTP, all on 127.0.0.1:
//   GET  /                 the dashboard page          GET /events    its stream of states
//   POST /action           a button (x-dashboard-token, from the page)
//   POST /hook /tell /orca from local programs (x-bloom-key, from service.key)
//   GET  /state            the same state, for the Orca plugin (x-bloom-key); with ?since=<v> it
//                          answers when the state is newer than v, or after 25 s
//   GET  /worktree?path=   the row and checkout of one worktree, for the panel (x-bloom-key)
//   POST /decider, GET /decide/<id>, POST /decide/<id>/answers, GET /decider/<id>/wait
//   GET  /status           what the page's service indicator shows; no key
//   GET  /hooks            the newest hook payloads, for checking what sessions send (x-bloom-key)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PORT, ORIGIN, serviceDir, dashboardDir, repoDir, dataDir, dataFile, serviceKey, readJsonFile, writeJsonFile, ownEnvironment, orcaRunning, log } from "./env.mjs";
import { emptyState, applyHook, applyProgress, applyInterrupt, checkLiveness, openRun, latestRun, sessionsIn, prune, isOpen, SKILLS } from "./runs.mjs";
import { computeRow, allowAction, orderOf, GROUPS, ROW_STATES, IN_REVIEW } from "./rows.mjs";
import { readGit, gitWatcher } from "./git.mjs";
import { writeProse, digestOf, proseUsage, config, llmDir, SETTLE_MS } from "./prose.mjs";
import { addDecider, deciderPage, answerDecider, waitForAnswers, waitingDeciders, dropDecider } from "./deciders.mjs";
import { cardOf, questionOf, agentState, readProgress, progressDir } from "../row-facts.mjs";
import { ownReview } from "../own-review.mjs";
import { prComments } from "../pr-comments.mjs";
import { STANDUP } from "../standup.mjs";
import { changeTask, readTasks, TASK_ACTIONS } from "../tasks.mjs";
import { unconfirmed } from "../stale-worktrees.mjs";
import { orca, norm, setLog, bringOrcaToFront, openWorktree, createWorktree, runSkill, sendPrompt, openInVsCode } from "../../orca-worktrees.mjs";
import { developer } from "../../developer.mjs";

const execFileP = promisify(execFile);
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--check-only")) process.exit(0);

ownEnvironment();
setLog(log);
const KEY = serviceKey();
const TOKEN = crypto.randomBytes(16).toString("hex");
const startedAt = Date.now();

const CORE_MS = 60_000;          // cards, PRs and worktrees, while visible
const FULL_MS = 15 * 60_000;     // History, "Back with you for review", worktrees of resolved cards
const REVIEW_MS = 60_000;        // Reviewable, for a PR whose step depends on it
const REVIEW_SLOW_MS = 5 * 60_000;
const GIT_MS = 60_000;           // uncommitted edits made outside any session
const PS_CHECK_MS = 5 * 60_000;  // `orca worktree ps` as a check on what the plugin pushed
const PS_POLL_MS = 5_000;        // the same, while visible, when no plugin worker is pushing
const LIVENESS_MS = 15_000;
const ORCA_LIST_MS = 60_000;     // the least time between two reads of the process list for Orca
const WORKER_FRESH_MS = 45_000;
const LAUNCH_MS = 30_000;        // how long a pressed skill button waits for its run to begin
const SKILL_ACTIONS = SKILLS;

// ---- what the service knows -------------------------------------------------------------------
const cache = readJsonFile(dataFile("cache.json"), {}) || {};
const runs = readJsonFile(dataFile("runs.json"), null) || emptyState();
let remote = cache.remote || null;                 // gather.mjs's last good answer
let extras = cache.extras || {};                   // { standup, backForReview, staleWorktrees, at } of the last full one
let ps = [];                                       // `orca worktree ps`, the worktrees with their agents
const gits = new Map(Object.entries(cache.gits || {}));          // norm(worktree) -> { value, at, error }
const reviews = new Map(Object.entries(cache.reviews || {}));    // PR URL -> { value, at, error }
const comments = new Map(Object.entries(cache.comments || {}));  // PR URL -> { value, at, error }
const proses = new Map(Object.entries(cache.proses || {}));      // card -> { status, comments, next, at, model, digest }
const launches = new Map();                        // norm(worktree) -> { skill, at, failed }
const workingSeen = new Map();                     // norm(worktree) -> when its agent was first seen working
const removedWorktrees = new Set();
// Each outside source: when it was last read, and the error when that read failed.
const sources = {
  orca: { at: 0, error: "" }, github: { at: 0, error: "" }, youtrack: { at: 0, error: "" }, reviewable: { at: 0, error: "" },
  hooks: { at: 0, count: 0 }, worker: { at: 0 }, gather: { at: remote ? Date.parse(remote.gatheredAt) || 0 : 0, running: false },
};
let dev = { name: "", github: "", youtrack: { login: "" } };
// Without the developer's GitHub and YouTrack logins nothing of theirs can be found, so the page's
// Service indicator names the problem and how to settle it.
sources.developer = { at: 0, error: "" };
developer().then(d => { dev = d; sources.developer.at = Date.now(); recompute(); }, e => {
  sources.developer.error = "could not work out your GitHub and YouTrack logins; run `node developer.mjs` in the bloom-team-skills clone (" + String(e.message).split("\n")[0].slice(0, 120) + ")";
  log(sources.developer.error);
  recompute();
});
let codeError = "";
let assets = Date.now();   // changes when a page file changes, which reloads open pages

// ---- the event log ----------------------------------------------------------------------------
const events = [];   // the newest 600: { at, worktree, text }
function note(worktree, texts) {
  for (const text of [].concat(texts)) {
    const e = { at: Date.now(), worktree: worktree || null, text };
    events.push(e);
    try { fs.appendFileSync(dataFile("service-events.jsonl"), JSON.stringify(e) + "\n"); } catch {}
  }
  if (events.length > 600) events.splice(0, events.length - 600);
}
const eventsOf = key => events.filter(e => e.worktree === key || (key && e.text.includes(key))).slice(-20);

let saveRunsTimer = null;
function runsChanged(worktree, changes) {
  if (!changes.length) return;
  note(worktree, changes);
  clearTimeout(saveRunsTimer);
  saveRunsTimer = setTimeout(() => { prune(runs); writeJsonFile(dataFile("runs.json"), runs); }, 1000);
  recompute();
}
let cacheDirty = false;
function saveCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  const obj = m => Object.fromEntries(m);
  try { writeJsonFile(dataFile("cache.json"), { remote, extras, gits: obj(gits), reviews: obj(reviews), comments: obj(comments), proses: obj(proses) }); }
  catch (e) { log("could not save the cache: " + e.message); }
}

// ---- who is looking ---------------------------------------------------------------------------
const streams = new Map();     // client id -> { res, visible, at }
let panelSeenAt = 0;           // when the plugin's worker last said a panel was open
const visible = () => [...streams.values()].some(c => c.visible) || Date.now() - panelSeenAt < WORKER_FRESH_MS;
const workerConnected = () => Date.now() - sources.worker.at < WORKER_FRESH_MS;
let wasVisible = false;

// ---- Orca: worktrees and what their agents are doing ------------------------------------------
let psRunning = null, psWanted = false;
function readPs() {
  if (psRunning) { psWanted = true; return psRunning; }
  psRunning = (async () => {
    try {
      ps = (await orca("worktree", "ps")).worktrees.filter(w => !w.isArchived);
      sources.orca = { at: Date.now(), error: "" };
      const withAgents = new Set(ps.filter(w => (w.agents || []).length).map(w => norm(w.path)));
      for (const w of ps) {
        const key = norm(w.path);
        const working = (w.agents || []).find(a => agentState(a) === "working");
        if (!working) workingSeen.delete(key);
        else if (workingSeen.get(key)?.id !== working.paneKey + "|" + working.prompt) workingSeen.set(key, { id: working.paneKey + "|" + working.prompt, since: Date.now() });
        // Claude Code runs no Stop hook on an interrupt, so Orca's word is the only one.
        if ((w.agents || []).some(a => !a.parentPaneKey && (a.interrupted || a.mainAgent?.outcome === "interruption") && a.state !== "working")) runsChanged(key, applyInterrupt(runs, key));
      }
      runsChanged(null, checkLiveness(runs, alive, { agentWorktrees: withAgents }));
    } catch (e) {
      const error = String(e.message).split("\n")[0].slice(0, 200);
      if (sources.orca.error !== error) log("orca: " + error);
      sources.orca = { ...sources.orca, error };
    }
    recompute();
  })().finally(() => { psRunning = null; if (psWanted) { psWanted = false; readPs(); } });
  return psRunning;
}
let psTimer = null;
const readPsSoon = () => { clearTimeout(psTimer); psTimer = setTimeout(readPs, 300); };
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// The service runs only while Orca does. The plugin's worker names Orca's process with each
// request for the state, and while that process lives nothing more is asked. Without it (no
// worker has asked yet, or the plugin is not approved), or once it is gone, the process list
// decides, read at most every ORCA_LIST_MS, except that a process found gone is looked up at once.
let orcaPid = Number(arg("--orca")) || 0, orcaListedAt = 0, stopping = false;
async function exitWhenOrcaIsGone() {
  if (stopping || restarting) return;
  if (orcaPid && alive(orcaPid)) return;
  const now = Date.now();
  if (!orcaPid && now - orcaListedAt < ORCA_LIST_MS) return;
  orcaPid = 0;
  orcaListedAt = now;
  if (await orcaRunning()) return;
  stopping = true;
  log("Orca is not running, so the service stops");
  // The open pages close their windows; the wait lets the message leave before the process does.
  for (const c of streams.values()) c.res.write("event: close\ndata: {}\n\n");
  setTimeout(stop, 500);
}
function stop() {
  saveCache();
  try { writeJsonFile(dataFile("runs.json"), runs); } catch {}
  process.exit(0);
}

// Every worktree the service knows of, from Orca's live list and the last gather: norm(path) ->
// { path, branch, card }.
function worktrees() {
  const out = new Map();
  for (const w of remote?.worktrees || []) out.set(norm(w.path), { path: w.path, branch: w.branch, card: w.card });
  for (const w of ps) {
    const branch = (w.branch || "").replace("refs/heads/", "");
    out.set(norm(w.path), { path: w.path, branch, card: cardOf(branch, w.path), repo: w.repo || "" });
  }
  for (const key of removedWorktrees) out.delete(key);
  return out;
}
// The worktree that a folder is in: the longest known worktree path that it starts with.
function worktreeOf(cwd) {
  const p = norm(cwd);
  let best = null;
  for (const key of worktrees().keys()) if ((p === key || p.startsWith(key + "/")) && (!best || key.length > best.length)) best = key;
  return best;
}
// What the agents in a worktree are doing, from Orca, or from the hooks when Orca does not answer.
function activityOf(key) {
  const orcaOk = !sources.orca.error && sources.orca.at > 0;
  const sessions = sessionsIn(runs, key);
  const prompted = Math.max(0, ...sessions.filter(s => s.turn === "working").map(s => s.promptAt || 0));
  const asked = sessions.find(s => s.asking);
  if (!orcaOk) return { orcaOk, orcaError: sources.orca.error || "not read yet", working: prompted > 0, asking: !!asked, question: asked?.asking.message || "", since: prompted };
  const agents = ps.find(w => norm(w.path) === key)?.agents || [];
  const q = agents.find(a => questionOf(a));
  const asking = agents.some(a => a.state === "waiting" || a.state === "blocked");
  return { orcaOk, working: agents.some(a => agentState(a) === "working"), asking, question: q ? questionOf(q) : asking ? asked?.asking.message || "" : "", since: prompted || workingSeen.get(key)?.since || 0 };
}

// ---- git ---------------------------------------------------------------------------------------
const gitReading = new Set();
async function refreshGit(key) {
  const wt = worktrees().get(key);
  if (!wt || gitReading.has(key)) return;
  gitReading.add(key);
  try {
    const since = latestRun(runs, key, "preflight")?.result?.head || null;
    const value = await readGit(wt.path, since);
    const before = JSON.stringify(gits.get(key)?.value);
    gits.set(key, { value, at: Date.now(), error: "" });
    if (before !== JSON.stringify(value)) { cacheDirty = true; if (before && JSON.parse(before).head !== value.head) note(key, `HEAD moved to ${value.head.slice(0, 7)}`); }
  } catch (e) {
    gits.set(key, { value: null, at: Date.now(), error: String(e.message).split("\n")[0].slice(0, 200) });
  } finally { gitReading.delete(key); }
  recompute();
}
const watcher = gitWatcher(wtPath => refreshGit(norm(wtPath)));

// ---- cards, PRs and the slower lists -----------------------------------------------------------
const boardWanted = () => readJsonFile(dataFile("board.json"), null)?.board ?? null;
let gathering = null;
function gather(full) {
  if (gathering) return gathering;
  sources.gather.running = true;
  recompute();
  gathering = (async () => {
    const tmp = dataFile(`gather-${process.pid}.json`);
    // board.json: no file means "pick the current version's board", "" means every board.
    const board = boardWanted();
    try {
      // In a process of its own: gather.mjs runs gh and git synchronously, which would hold up
      // the hooks.
      const a = [path.join(dashboardDir, "gather.mjs"), tmp, ...(board === null ? [] : [board || "all"]), ...(full ? [] : ["--core"])];
      await execFileP(process.execPath, a, { windowsHide: true, maxBuffer: 16 << 20, timeout: 5 * 60_000 });
      const next = readJsonFile(tmp);
      if (!next) throw new Error("gather wrote nothing");
      const now = Date.now();
      for (const c of next.cards) { const was = remote?.cards.find(x => x.id === c.id); if (was && was.state !== c.state) note(null, `${c.id}: State ${was.state} -> ${c.state}`); }
      for (const p of next.prs) { const was = remote?.prs.find(x => x.url === p.url); if (was && (was.isDraft !== p.isDraft || was.checks !== p.checks || was.mergeable !== p.mergeable)) note(null, `${p.card || "PR " + p.number}: PR ${p.number} is ${p.isDraft ? "draft" : "ready"}, ${p.mergeable}, CI ${p.checks || "none"}`); }
      remote = next;
      if (full) { extras = { standup: next.standup, backForReview: next.backForReview, staleWorktrees: next.staleWorktrees, at: now }; removedWorktrees.clear(); }
      if (board === null && next.board) writeJsonFile(dataFile("board.json"), { board: next.board });
      sources.github = { at: now, error: "" }; sources.youtrack = { at: now, error: "" };
      sources.gather.at = now;
      if (full) sources.gather.fullAt = now;
      cacheDirty = true;
    } catch (e) {
      const lines = String(e.stderr || e.message).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const error = (lines.find(l => /^\w*Error\b/.test(l)) ?? lines[0] ?? "no output").slice(0, 240);
      // The gather stops at the first source that fails, and its message names it.
      const which = /\borca\b/i.test(error) ? "orca" : /\bgh\b|github/i.test(error) ? "github" : "youtrack";
      if (sources[which].error !== error) log(`gather: ${error}`);
      sources[which] = { ...sources[which], error };
    } finally {
      fs.rmSync(tmp, { force: true });
      sources.gather.running = false;
      gathering = null;
    }
    recompute();
  })();
  return gathering;
}

// ---- Reviewable: the developer's review marks, and the comments that wait ----------------------
const reviewQueue = [];   // { kind: "review" | "comments", pr }
let reviewBusy = false;
function wantReview(kind, pr) {
  if (!reviewQueue.some(j => j.kind === kind && j.pr === pr)) reviewQueue.push({ kind, pr });
  drainReviews();
}
async function drainReviews() {
  if (reviewBusy || !dev.github) return;
  reviewBusy = true;
  while (reviewQueue.length) {
    const { kind, pr } = reviewQueue.shift();
    const kept = kind === "review" ? reviews : comments;
    try {
      const value = kind === "review" ? await ownReview(pr, dev.github) : await prComments(pr, dev.github);
      // Both answer null when the source could not be read: the last good value stays, marked.
      if (value) { kept.set(pr, { value, at: Date.now(), error: "" }); if (kind === "comments" || value.reviewable) sources.reviewable = { at: Date.now(), error: "" }; }
      else kept.set(pr, { ...(kept.get(pr) || { value: null }), at: Date.now(), error: kind === "review" ? "GitHub could not be read" : "Reviewable could not be read" });
      if (!value && kind === "comments") sources.reviewable = { ...sources.reviewable, error: "could not read discussions" };
      cacheDirty = true;
    } catch (e) {
      kept.set(pr, { ...(kept.get(pr) || { value: null }), at: Date.now(), error: String(e.message).split("\n")[0].slice(0, 200) });
    }
    recompute();
  }
  reviewBusy = false;
}

// ---- rows --------------------------------------------------------------------------------------
let rowsNow = [], inReviewNow = [];
function buildRows(now = Date.now()) {
  const known = worktrees();
  const deciders = waitingDeciders(now);
  const rows = [], inReview = [];
  for (const card of remote?.cards || []) {
    const review = card.state === IN_REVIEW && card.assignedToDeveloper;
    if (!ROW_STATES.includes(card.state) && !review) continue;
    const mine = (remote.prs || []).filter(p => p.card === card.id);
    const wts = [...known.entries()].filter(([, w]) => w.card === card.id || mine.some(p => p.headRefName === w.branch));
    // The PR that a worktree is on, when the card has several; the worktree on that PR's branch.
    const pr = mine.find(p => wts.some(([, w]) => w.branch === p.headRefName)) ?? mine[0] ?? null;
    const [key, wt] = wts.find(([, w]) => pr && w.branch === pr.headRefName) ?? wts[0] ?? [null, null];
    // A worktree seen for the first time is read at once; after that its file watch and the
    // timer keep it current.
    if (key && !gits.has(key)) refreshGit(key);
    const git = key ? gits.get(key) : null;
    const rv = pr ? reviews.get(pr.url) : null, cm = pr ? comments.get(pr.url) : null;
    const launch = key ? launches.get(key) : null;
    const failing = {};
    for (const s of ["github", "youtrack", "reviewable"]) if (sources[s].error) failing[s] = sources[s].error;
    if (git?.error) failing.git = git.error;
    const row = computeRow({
      card, pr, worktree: wt, git: git?.value ?? null,
      preflight: key ? latestRun(runs, key, "preflight") : null, open: key ? openRun(runs, key) : null,
      review: rv?.value ?? null, comments: cm?.value ?? null,
      activity: key ? activityOf(key) : { orcaOk: !sources.orca.error && sources.orca.at > 0, orcaError: sources.orca.error },
      launch, prose: proseFor(card.id), deciders: key ? deciders.filter(d => d.worktree === key) : [],
      ages: { git: git?.at || 0, github: sources.github.at, youtrack: sources.youtrack.at, review: rv?.at || 0, comments: cm?.at || 0, orca: sources.orca.at },
      failing,
    }, now);
    row.key = key;
    row.events = key ? eventsOf(key) : [];
    row.git = git?.value ?? null;
    (review ? inReview : rows).push(row);
  }
  const rank = r => GROUPS.indexOf(r.group) * 100 + orderOf(r);
  rows.sort((a, b) => rank(a) - rank(b) || a.card.localeCompare(b.card, undefined, { numeric: true }));
  rowsNow = rows; inReviewNow = inReview;
  watcher.set([...rows, ...inReview].map(r => r.worktree).filter(Boolean));
  // A decider whose session has gone can never be answered to anyone.
  for (const d of deciders) if (d.session && runs.sessions[d.session]?.endedAt) { dropDecider(d.id); note(d.worktree, `dropped the decider "${d.name}": its session ended`); }
  return { rows, inReview, deciders };
}

function status() {
  const p = proseUsage();
  return {
    pid: process.pid, startedAt, port: PORT, code, title: windowTitle(), codeError, assets, visible: visible(), workerConnected: workerConnected(), orcaPid,
    sources: { ...sources, llm: p }, openRuns: runs.runs.filter(isOpen).length, sessions: Object.values(runs.sessions).filter(s => !s.endedAt).length,
  };
}

let version = 0, stateJson = "", stateNow = null;
const waitingForState = new Set();   // functions to call when the state changes
function buildState() {
  const { rows, inReview, deciders } = buildRows();
  return {
    service: status(), board: remote?.board ?? boardWanted() ?? "", developer: (dev.name || "").split(" ")[0],
    rows, inReview, deciders,
    backForReview: extras.backForReview ?? null, standup: extras.standup ?? null, standupAt: STANDUP,
    staleWorktrees: extras.staleWorktrees?.filter(w => !removedWorktrees.has(norm(w.path))) ?? null,
    tasks: readTasks(dataFile("tasks.json")), checkedAt: sources.gather.at, gathering: sources.gather.running,
  };
}
let recomputeTimer = null;
function recompute() {
  if (recomputeTimer) return;
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    const state = buildState();
    const json = JSON.stringify(state);
    if (json === stateJson) return;
    stateJson = json; stateNow = state; version++;
    const frame = `event: state\ndata: ${JSON.stringify({ version, ...state })}\n\n`;
    for (const c of streams.values()) c.res.write(frame);
    for (const give of [...waitingForState]) give();
    scheduleProse();
  }, 120);
}

// ---- prose -------------------------------------------------------------------------------------
const proseFacts = new Map();   // card -> { digest, facts, since }
let proseBusy = false;
function proseFor(card) {
  const p = proses.get(card);
  if (!p) return null;
  return { ...p, stale: proseFacts.has(card) && proseFacts.get(card).digest !== p.digest };
}
function scheduleProse() {
  if (!config().prose) return;
  const now = Date.now();
  for (const r of [...rowsNow, ...inReviewNow]) {
    const key = r.key;
    const session = key ? sessionsIn(runs, key).sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0))[0] : null;
    const pr = remote?.prs.find(p => p.url === r.pr);
    const facts = {
      card: r.card, title: r.title, cardState: r.ytState, state: r.state, reasons: r.reasons,
      pr: pr ? { title: pr.title, draft: pr.isDraft, mergeable: pr.mergeable, ci: pr.checks || "none", files: pr.changedFiles, additions: pr.additions, deletions: pr.deletions, reviewDecision: pr.reviewDecision || "", reportDecisions: pr.reportDecisions ?? null } : null,
      checkout: r.git ? { commitsBeyondBase: r.git.ahead, commitsBehindBase: r.git.behind, uncommittedFiles: r.git.uncommitted } : null,
      commentsWaiting: comments.get(r.pr)?.value?.texts || [],
      lastAgentMessage: session?.lastMessage || "",
    };
    const digest = digestOf(facts);
    const was = proseFacts.get(r.card);
    if (was?.digest !== digest) proseFacts.set(r.card, { digest, facts, since: now });
  }
  if (proseBusy || !visible()) return;
  const due = [...proseFacts.entries()].find(([card, f]) => proses.get(card)?.digest !== f.digest && now - f.since >= SETTLE_MS && !f.failedAt);
  if (!due) return;
  const [card, f] = due;
  proseBusy = true;
  writeProse(f.facts).then(p => { proses.set(card, p); cacheDirty = true; }, () => { f.failedAt = Date.now(); })
    .finally(() => { proseBusy = false; recompute(); });
}

// ---- progress records --------------------------------------------------------------------------
function readProgressRecords() {
  for (const [key, file] of readProgress()) runsChanged(key, applyProgress(runs, { ...file, worktree: key }));
}
let progressTimer = null;
function watchProgress() {
  fs.mkdirSync(progressDir(), { recursive: true });
  try { fs.watch(progressDir(), { persistent: false }, () => { clearTimeout(progressTimer); progressTimer = setTimeout(readProgressRecords, 200); }); }
  catch (e) { log("could not watch the progress folder: " + e.message); }
}

// ---- the code this process runs ----------------------------------------------------------------
// The branch and commit of the checkout, and when any of its files last changed, for the page's
// service indicator. A change to a module restarts the service onto the new code once that code
// loads (--check-only); a change to a page file reloads the open pages; a change to the plugin
// has Orca reload it.
const code = { branch: "", commit: "", changedAt: 0, dir: repoDir };
async function readCode() {
  const g = (...a) => execFileP("git", ["-C", repoDir, ...a], { windowsHide: true }).then(r => r.stdout.trim(), () => "");
  [code.branch, code.commit] = await Promise.all([g("rev-parse", "--abbrev-ref", "HEAD"), g("rev-parse", "--short", "HEAD")]);
  recompute();
}
let restartTimer = null, restarting = false;
function watchCode() {
  const onChange = (dir, file) => {
    const name = String(file || "").replace(/\\/g, "/");
    if (!name || /(^|\/)(node_modules|\.git)\//.test(name) || /\.test\.mjs$/.test(name) || /~$|\.tmp$/.test(name)) return;
    code.changedAt = Date.now();
    if (/\.(html|css|js|png)$/.test(name)) { assets = Date.now(); recompute(); }
    if (/(^|\/)(plugin|worktree-panel)\//.test(name) || /orca-plugin\.json$/.test(name) || /^(row\.js|dashboard\.css)$/.test(name)) reloadPluginSoon();
    else if (/\.mjs$/.test(name)) { clearTimeout(restartTimer); restartTimer = setTimeout(restartOntoNewCode, 1500); }
  };
  for (const [dir, recursive] of [[dashboardDir, true], [repoDir, false], [path.join(repoDir, "bloom-services"), true]]) {
    try { fs.watch(dir, { recursive, persistent: false }, (e, f) => onChange(dir, f)); } catch (e) { log(`could not watch ${dir}: ${e.message}`); }
  }
}
let pluginTimer = null;
function reloadPluginSoon() {
  clearTimeout(pluginTimer);
  pluginTimer = setTimeout(() => orca("plugin", "dev", "reload").then(() => log("asked Orca to reload its development plugins"), e => log("plugin reload: " + String(e.message).split("\n")[0])), 1500);
}
async function restartOntoNewCode() {
  try {
    await execFileP(process.execPath, [path.join(serviceDir, "service.mjs"), "--check-only"], { windowsHide: true, timeout: 30_000 });
  } catch (e) {
    codeError = String(e.stderr || e.message).split(/\r?\n/).filter(l => l.trim() && !/^\s+at /.test(l)).slice(0, 4).join(" ").slice(0, 400);
    log("the changed code does not load, so the service keeps running the old code: " + codeError);
    recompute();
    return;
  }
  restart("its code changed");
}
function restart(why) {
  if (restarting) return;
  restarting = true;
  log(`restarting: ${why}`);
  saveCache();
  writeJsonFile(dataFile("runs.json"), runs);
  spawn(process.execPath, [path.join(serviceDir, "service.mjs"), "--wait", "20000", "--no-window", ...(orcaPid ? ["--orca", String(orcaPid)] : [])], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (const c of streams.values()) c.res.end();
  server.close();
  setTimeout(() => process.exit(0), 300);
}

// ---- the dashboard window ----------------------------------------------------------------------
// The window's title, which is also how it is found to bring it to the front. Code from a branch
// other than main says so, as the status bar button does, so that its window can be told from
// one that another checkout's dashboard opened.
const windowTitle = () => "Bloom Dashboard" + (code.branch && !["main", "master"].includes(code.branch) ? ` [${code.branch}]` : "");
async function showWindow() {
  if ([...streams.values()].length && process.platform === "win32") {
    try {
      await execFileP("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dashboardDir, "raise-window.ps1"), "-Title", windowTitle()], { windowsHide: true });
      return "raised";
    } catch {}   // exit 1: no window with that title, so open one
  }
  const dirs = process.platform === "win32"
    ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", process.env.LOCALAPPDATA].map(d => path.join(d, "Google", "Chrome", "Application", "chrome.exe"))
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"];
  const chrome = dirs.find(p => fs.existsSync(p));
  if (!chrome) throw new Error("Chrome was not found in " + dirs.join(", "));
  // The developer's own Chrome profile is named, so that the page's links open where they are
  // signed in to GitHub and Reviewable.
  const a = [`--app=${ORIGIN}/`, "--window-size=1280,900"];
  if (process.platform === "win32") a.unshift(`--user-data-dir=${path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data")}`);
  spawn(chrome, a, { detached: true, stdio: "ignore" }).unref();
  return "opened";
}

// ---- actions -----------------------------------------------------------------------------------
const rowOfPath = p => [...rowsNow, ...inReviewNow].find(r => r.key === norm(p)) ?? null;
async function act(b) {
  const action = String(b.action || "");
  if (TASK_ACTIONS.map(a => "task-" + a).includes(action)) return { tasks: changeTask(dataFile("tasks.json"), action.slice(5), b) };
  if (action === "refresh") { await Promise.all([gather(true), readPs()]); for (const r of rowsNow) if (r.key) refreshGit(r.key); dueAll(); return {}; }
  if (action === "restart") { setTimeout(() => restart("the developer asked"), 200); return { message: "Restarting." }; }
  if (action === "show") return { message: await showWindow() };
  if (action === "remove-worktree") return removeStaleWorktree(b);
  if (action === "set-board") { writeJsonFile(dataFile("board.json"), { board: String(b.board || "") }); remote = null; gather(true); return {}; }
  // Everything else acts on a card's worktree, by the rule that set the button's enabled state,
  // run again on what Orca says now.
  await readPs();
  const p = String(b.path || "");
  const row = action === "create" ? [...rowsNow, ...inReviewNow].find(r => r.card === String(b.card || "")) : rowOfPath(p);
  // The panel also acts on worktrees that belong to no card: only opening and typing a prompt.
  const ref = row ? { state: row.state, worktree: row.worktree, card: row.card, offered: row.offered } : { state: "", worktree: p || null, card: "", offered: [] };
  const key = norm(ref.worktree);
  const activity = key ? activityOf(key) : { orcaOk: !sources.orca.error };
  const paneKey = b.paneKey ? String(b.paneKey) : null;
  let message;
  if (action === "prompt") {
    const text = { commit: "commit", "commit-push": "commit and push" }[b.prompt];
    if (!text) throw new Error("not a prompt the panel sends: " + b.prompt);
    if (activity.asking) throw new Error("Claude is asking a question in that worktree; answer it first.");
    if (activity.working) throw new Error("Claude is working in that worktree; wait for it to finish.");
    message = await sendPrompt(ref.worktree, text, paneKey);
  } else {
    const allowed = allowAction(action, ref, activity);
    if (!allowed.ok) throw new Error(allowed.reason);
    if (action === "open") message = await openWorktree(ref.worktree, paneKey);
    else if (action === "vscode") message = await openInVsCode(ref.worktree);
    else if (action === "create") {
      const pr = row?.pr || "";
      const made = await createWorktree({ card: row.card, title: row.title, pr });
      note(norm(made.path), `${row.card}: worktree created from the dashboard at ${made.path}`);
      message = "Created " + made.path;
      gather(false);
    } else if (SKILL_ACTIONS.includes(action)) {
      message = await runSkill(ref.worktree, action, paneKey);
      const at = Date.now();
      launches.set(key, { skill: action, at, failed: false });
      note(key, `${action}: typed into the session (${message})`);
      // The button counts as done when the hook reports that the run began. One that never does
      // is shown as failed, for ten minutes.
      setTimeout(() => {
        const l = launches.get(key);
        if (l?.at !== at) return;
        const began = runs.runs.some(r => r.worktree === key && r.skill === action && r.startedAt >= at - 5000);
        if (began) launches.delete(key);
        else { l.failed = true; note(key, `${action}: typed, but no run began within ${LAUNCH_MS / 1000} s`); setTimeout(() => { if (launches.get(key)?.at === at) { launches.delete(key); recompute(); } }, 10 * 60_000); }
        recompute();
      }, LAUNCH_MS);
    }
  }
  if (b.front && ["open", "create", ...SKILL_ACTIONS].includes(action)) await bringOrcaToFront().catch(e => log("front: " + e.message));
  readPsSoon();
  recompute();
  return { message };
}
async function removeStaleWorktree({ path: p, confirmed = [] }) {
  const w = extras.staleWorktrees?.find(s => norm(s.path) === norm(p));
  if (!w) throw new Error("the dashboard does not list " + p + " as the worktree of a resolved card; press Refresh");
  let dirty;
  try { dirty = (await execFileP("git", ["-C", w.path, "status", "--porcelain"], { windowsHide: true })).stdout.split("\n").filter(Boolean).length; }
  catch (e) { throw new Error("could not read git status in " + w.path + ": " + String(e.message).split("\n")[0]); }
  await readPs();
  const fresh = unconfirmed({ dirty, agents: activityOf(norm(w.path)) }, Array.isArray(confirmed) ? confirmed.map(String) : []);
  if (fresh.length) {
    const what = { uncommitted: `${dirty} uncommitted file${dirty === 1 ? "" : "s"}`, agent: "a Claude session at work" };
    throw new Error(`${w.path} now has ${fresh.map(k => what[k]).join(" and ")}; nothing was removed. Press Refresh and look again`);
  }
  await orca("worktree", "rm", "--worktree", "path:" + w.path, "--delete-branch", ...(dirty ? ["--force"] : []));
  removedWorktrees.add(norm(w.path));
  log(`removed ${w.path} (${w.card}, resolved)`);
  recompute();
  return {};
}

// ---- the timer ---------------------------------------------------------------------------------
// One in-process timer decides what is due. It starts a process only for a read that is due.
const due = { core: 0, full: 0, git: 0, ps: 0, liveness: 0 };
const reviewDue = new Map();   // "kind pr" -> when it was last asked for
function dueAll() { reviewDue.clear(); due.git = 0; }
function tick() {
  const now = Date.now();
  if (now - due.liveness >= LIVENESS_MS) { due.liveness = now; runsChanged(null, checkLiveness(runs, alive)); exitWhenOrcaIsGone(); }
  const looking = visible();
  if (looking && !wasVisible) { due.ps = 0; due.git = 0; reviewDue.clear(); }
  wasVisible = looking;
  // Launches and open runs need Orca's word even when nobody looks, but only as a slow check.
  const psEvery = workerConnected() ? PS_CHECK_MS : looking ? PS_POLL_MS : PS_CHECK_MS;
  if ((looking || runs.runs.some(isOpen)) && now - due.ps >= psEvery) { due.ps = now; readPs(); }
  if (!looking) return;
  if (now - (sources.gather.fullAt || extras.at || 0) >= FULL_MS && !gathering) gather(true);
  else if (now - sources.gather.at >= CORE_MS && !gathering) gather(false);
  if (now - due.git >= GIT_MS) { due.git = now; for (const r of [...rowsNow, ...inReviewNow]) if (r.key) refreshGit(r.key); }
  for (const r of [...rowsNow, ...inReviewNow]) {
    if (!r.pr) continue;
    const ask = (kind, every) => { const k = kind + " " + r.pr; if (now - (reviewDue.get(k) || 0) >= every) { reviewDue.set(k, now); wantReview(kind, r.pr); } };
    const near = ["review", "handoff-ready", "comments", "comments-running", "peer-review"].includes(r.state) || r.ytState === "Has Comments";
    ask("comments", near ? REVIEW_MS : REVIEW_SLOW_MS);
    if (["review", "handoff-ready"].includes(r.state)) ask("review", REVIEW_MS);
  }
  scheduleProse();
}

// ---- HTTP --------------------------------------------------------------------------------------
function send(res, codeNumber, body, type = "application/json") {
  res.writeHead(codeNumber, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(req, limit = 4 << 20) {
  return new Promise(resolve => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > limit) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}
const json = text => { try { return JSON.parse(text || "{}"); } catch { return {}; } };
function page() {
  const html = fs.readFileSync(path.join(dashboardDir, "board.html"), "utf8");
  return html.replace(/<head[^>]*>/i, m => `${m}<script>window.DASHBOARD_TOKEN=${JSON.stringify(TOKEN)};window.DASHBOARD_ASSETS=${assets};</script>`);
}
const STATIC = { ".css": "text/css", ".js": "text/javascript", ".png": "image/png" };

// The newest hook payloads, cut short, for GET /hooks: what a session really sent.
const hookTrace = [];
function onHook(p, pid) {
  // The service's own headless calls (prose.mjs) are sessions too; they are not the developer's work.
  if (p.cwd && norm(p.cwd).startsWith(norm(llmDir()))) return;
  sources.hooks = { at: Date.now(), count: sources.hooks.count + 1 };
  const worktree = worktreeOf(p.cwd || "");
  hookTrace.push({ at: Date.now(), pid, worktree, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : k === "tool_response" ? "…" : v])) });
  if (hookTrace.length > 80) hookTrace.shift();
  runsChanged(worktree, applyHook(runs, p, { worktree, pid }));
  clearTimeout(saveRunsTimer);
  saveRunsTimer = setTimeout(() => { prune(runs); writeJsonFile(dataFile("runs.json"), runs); }, 1000);
  const e = p.hook_event_name;
  if (worktree && (e === "Stop" || e === "PostToolUse" || e === "SessionEnd")) refreshGit(worktree);
  // Orca's plugin pushes agent changes; with no plugin connected, a hook is the next best prompt to look.
  if (!workerConnected() && ["UserPromptSubmit", "Stop", "Notification", "SessionEnd", "SessionStart"].includes(e)) readPsSoon();
  if (e === "Stop" && worktree) { const r = rowOfPath(worktree); if (r?.pr) { reviewDue.delete("comments " + r.pr); } }
  recompute();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const pathname = url.pathname;
  const keyed = req.headers["x-bloom-key"] === KEY;
  try {
    if (req.method === "GET") {
      if (pathname === "/" || pathname === "/index.html") return send(res, 200, page(), "text/html");
      if (pathname === "/status") return send(res, 200, { dashboardService: true, ...status() });
      if (pathname === "/events") {
        const id = url.searchParams.get("id") || crypto.randomUUID();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        streams.set(id, { res, visible: url.searchParams.get("visible") !== "0", at: Date.now() });
        req.on("close", () => { streams.delete(id); });
        res.write(`event: state\ndata: ${JSON.stringify({ version, ...(stateNow ?? buildState()) })}\n\n`);
        tick();
        return;
      }
      if (pathname === "/hooks") return keyed ? send(res, 200, hookTrace) : send(res, 403, { ok: false });
      if (pathname === "/state" || pathname === "/worktree") {
        if (!keyed) return send(res, 403, { ok: false, error: "forbidden" });
        sources.worker.at = Date.now();
        orcaPid = Number(url.searchParams.get("orca")) || orcaPid;
        if (url.searchParams.get("panel") === "1") panelSeenAt = Date.now();
        const since = Number(url.searchParams.get("since") ?? -1);
        if (pathname === "/state" && since === version) {
          await new Promise(resolve => { const give = () => { clearTimeout(t); waitingForState.delete(give); resolve(); }; const t = setTimeout(give, 25_000); waitingForState.add(give); req.on("close", give); });
          sources.worker.at = Date.now();
        }
        const state = stateNow ?? buildState();
        if (pathname === "/state") return send(res, 200, { version, ...state });
        const key = worktreeOf(url.searchParams.get("path") || "") ?? norm(url.searchParams.get("path") || "");
        if (!gits.has(key)) await refreshGit(key);
        const row = [...state.rows, ...state.inReview].find(r => r.key === key) ?? null;
        return send(res, 200, { version, service: state.service, row, git: gits.get(key)?.value ?? null, gitError: gits.get(key)?.error || "", activity: activityOf(key), deciders: state.deciders.filter(d => d.worktree === key) });
      }
      const decide = pathname.match(/^\/decide\/([a-f0-9]+)$/);
      if (decide) { const html = deciderPage(decide[1]); return html ? send(res, 200, html, "text/html") : send(res, 404, "This decider is gone: it was answered, or its session ended.", "text/plain"); }
      const wait = pathname.match(/^\/decider\/([a-f0-9]+)\/wait$/);
      if (wait) {
        if (!keyed) return send(res, 403, { ok: false });
        try { const answers = await waitForAnswers(wait[1], 50_000); if (answers != null) recompute(); return send(res, 200, { answered: answers != null, answers }); }
        catch (e) { return send(res, 404, { ok: false, error: e.message }); }
      }
      const ext = path.extname(pathname);
      const file = path.join(dashboardDir, pathname.slice(1));
      if (STATIC[ext] && !pathname.includes("..") && /^\/(row\.js|dashboard\.css|icons\/icon-\d+\.png)$/.test(pathname) && fs.existsSync(file)) {
        res.writeHead(200, { "content-type": STATIC[ext], "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      return send(res, 404, { ok: false });
    }
    if (req.method !== "POST") return send(res, 404, { ok: false });

    // A form's Send to Claude: the id in its address is its own secret.
    const answers = pathname.match(/^\/decide\/([a-f0-9]+)\/answers$/);
    if (answers) {
      const body = await readBody(req, 1 << 20);
      const ok = answerDecider(answers[1], body);
      if (ok) { note(null, "a decider was answered"); recompute(); }
      return send(res, ok ? 200 : 404, { ok });
    }

    // From local programs, which can read service.key; a web page cannot send the header.
    if (["/hook", "/tell", "/orca", "/decider"].includes(pathname)) {
      if (!keyed) return send(res, 403, { ok: false, error: "forbidden" });
      const b = json(await readBody(req));
      if (pathname === "/hook") { send(res, 200, {}); onHook(b.payload ?? b, b.pid ?? null); return; }
      if (pathname === "/orca") {
        sources.worker.at = Date.now();
        if (b.panelOpen) panelSeenAt = Date.now();
        if (b.event) readPsSoon();
        return send(res, 200, { ok: true });
      }
      if (pathname === "/decider") {
        const worktree = worktreeOf(b.cwd || "");
        const d = addDecider({ name: b.name, topic: b.topic, html: b.html, session: b.session || null, worktree });
        note(worktree, `decider "${b.name}" is waiting for answers`);
        recompute();
        return send(res, 200, { ok: true, id: d.id, url: ORIGIN + d.path });
      }
      // /tell: a skill's script says that something changed.
      if (b.kind === "progress") readProgressRecords();
      else if (b.kind === "card-changed" || b.kind === "pr-changed" || b.kind === "refresh") { sources.gather.at = 0; if (visible()) gather(false); }
      else if (b.kind === "show") return send(res, 200, { ok: true, how: await showWindow() });
      else if (b.kind === "board") { remote = null; extras = {}; cacheDirty = true; gather(true); }
      return send(res, 200, { ok: true });
    }

    if (pathname === "/presence") {
      const b = json(await readBody(req, 1000));
      const c = streams.get(String(b.id || ""));
      if (c) { c.visible = !!b.visible; c.at = Date.now(); }
      // The developer came back to the window, perhaps from reviewing in the browser.
      if (b.focus) dueAll();
      tick();
      return send(res, 200, { ok: true });
    }
    if (pathname === "/action") {
      // The page's own token, or the key when the Orca plugin relays a panel's button.
      if (!keyed && (req.headers["x-dashboard-token"] !== TOKEN || (req.headers.origin && req.headers.origin !== ORIGIN))) return send(res, 403, { ok: false, error: "forbidden" });
      const body = await readBody(req, 1e5);
      log("action " + body.slice(0, 300));
      try { return send(res, 200, { ok: true, ...((await act(json(body))) || {}) }); }
      catch (e) { log("action failed: " + e.message); return send(res, 200, { ok: false, error: String(e.message).split("\n")[0] }); }
    }
    return send(res, 404, { ok: false });
  } catch (e) {
    log(`error on ${pathname}: ${e.stack || e.message}`);
    if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
  }
});

// ---- starting and stopping ---------------------------------------------------------------------
// The port is the lock: a second service finds it taken and exits, unless it was told to wait for
// the one it replaces.
const waitUntil = Date.now() + Number(arg("--wait") ?? 0);
server.on("error", e => {
  if (e.code === "EADDRINUSE" && Date.now() < waitUntil) return void setTimeout(() => server.listen(PORT, "127.0.0.1"), 300);
  if (e.code === "EADDRINUSE") { console.log(`ALREADY_RUNNING on ${ORIGIN}`); process.exit(0); }
  console.log("SERVICE_ERROR " + e.message);
  log("could not listen: " + e.message);
  process.exit(1);
});
server.on("listening", () => {
  writeJsonFile(dataFile("service.json"), { pid: process.pid, port: PORT, startedAt, dir: repoDir });
  log(`listening on ${ORIGIN}, pid ${process.pid}, code in ${repoDir}`);
  console.log(`DASHBOARD_SERVICE ${ORIGIN}/`);
  readCode();
  watchCode();
  watchProgress();
  readProgressRecords();
  readPs();
  for (const key of new Set(runs.runs.filter(r => r.skill === "preflight").map(r => r.worktree))) if (key) refreshGit(key);
  setInterval(tick, 5000);
  setInterval(saveCache, 30_000);
  if (!args.includes("--no-window") && args.includes("--show")) showWindow().catch(e => log("window: " + e.message));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
process.on("uncaughtException", e => { log("uncaught: " + (e.stack || e.message)); });
process.on("unhandledRejection", e => { log("unhandled rejection: " + (e?.stack || e)); });
server.listen(PORT, "127.0.0.1");
