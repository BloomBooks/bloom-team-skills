// The Bloom Greenhouse window's side of the service: the developer's settings for allocating their
// Claude plan to the Greenhouse (greenhouse-worker.json in the data folder), the plan's usage as
// this machine's claude-usage.mjs reports it, the history of prompts and bot activity, and the
// plan that follows. The Greenhouse worker itself is an Orca bot. This tells it whether it may claim
// an item (workerGate, which greenhouse.mjs's `gate` asks for), starts its sessions through Orca, one
// work item to a session and up to as many at once as the developer allows (startDecision), and
// shuts the machine down after it when the developer chose so (shutDownReason).
//
// The history, greenhouse-history.jsonl in the data folder, holds one JSON object per line:
//   { kind: "prompt", at }   the developer sent a prompt, in any Claude session on this machine
//   { kind: "bot", at, bot } an Orca bot's session did something, at most once a minute per bot
// Lines of kinds that earlier versions wrote are ignored.
// `at` is in milliseconds. Lines older than KEEP_DAYS are dropped once a day.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dataFile, readJsonFile, writeJsonFile, log } from "./env.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanSettings, withValues, plan, shutDownReason, hoursBegan, restBegan, restWindow, restNow, workerGate, mayWorkBeforeUsage, workToTake, startDecision, startsInFlight, slept } from "./greenhouse-worker-plan.mjs";

const settingsFile = () => dataFile("greenhouse-worker.json");
const historyFile = () => dataFile("greenhouse-history.jsonl");
// The tool server, which says where the Greenhouse runs (GET /greenhouse), so that the address stays
// out of this public repository. greenhouse.mjs in the greenhouse repository asks it the same way.
const TOOL_SERVER = process.env.BLOOM_BOT_WORKER_URL || "https://bloom-bot-tools.sil-language-technology.workers.dev";
let greenhouseAddress = null;
/** The Greenhouse, whose own app the page's Greenhouse Status tab shows: GREENHOUSE_URL when set,
 * otherwise what the tool server says, asked once per run of the service. Null when it cannot say. */
async function greenhouseUrl() {
  if (process.env.GREENHOUSE_URL) return process.env.GREENHOUSE_URL.replace(/\/$/, "");
  if (greenhouseAddress) return greenhouseAddress;
  try {
    const token = await new Promise((resolve, reject) =>
      execFile("gh", ["auth", "token"], { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));
    const response = await fetch(TOOL_SERVER + "/greenhouse", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const answer = response.ok ? await response.json() : null;
    if (answer?.url) greenhouseAddress = answer.url.replace(/\/$/, "");
    else log(`greenhouse: the tool server did not say where the Greenhouse runs (HTTP ${response.status})`);
  } catch (error) {
    log(`greenhouse: could not ask the tool server where the Greenhouse runs: ${error.message}`);
  }
  return greenhouseAddress;
}

// The Greenhouse's last dashboard answer, its ETag and when it was read. Every read of the Greenhouse
// counts against its database's daily limit, so a read within a minute of the last one is not made,
// and the ETag lets an unchanged answer come back as 304. `ok` is false while the latest read failed.
// `queue`, `orders` and `active` say what a new session of the worker could take.
const board = { at: 0, etag: null, offers: [], developerSettings: [], queue: [], orders: [], active: [], ok: false };
const BOARD_MS = 60_000;
// While the worker is not Off, the service reads the Greenhouse this often, so that what the developer
// set from another machine (their standing settings, such as letting the worker use the rest of
// each week) reaches this one.
// An unchanged answer is a 304 that reads two rows.
const BOARD_EVERY_MS = 15 * 60_000;
let login = null;
/** Reads the Greenhouse's dashboard, unless it was read within BOARD_MS. */
async function readBoard() {
  try {
    if (Date.now() - board.at <= BOARD_MS) return;
    const url = await greenhouseUrl();
    if (!url) { board.ok = false; return; }
    if (!login) {
      const { developer } = await import("../../developer.mjs");
      login = (await developer()).github?.toLowerCase() ?? null;
    }
    const response = await fetch(url + "/api/dashboard", { headers: board.etag ? { "If-None-Match": board.etag } : {}, signal: AbortSignal.timeout(30_000) });
    if (response.status === 200) {
      const answer = await response.json();
      Object.assign(board, {
        etag: response.headers.get("etag"), offers: answer.offers ?? [], developerSettings: answer.developerSettings ?? [],
        queue: (answer.queue ?? []).map(w => ({ id: w.id, order_id: w.order_id })),
        orders: (answer.orders ?? []).map(o => ({ id: o.id, status: o.status })),
        active: (answer.active ?? []).map(w => ({ id: w.id, claimed_by: w.claimed_by, machine: w.machine, reported_at: w.reported_at, paused_at: w.paused_at })),
      });
    }
    else if (response.status !== 304) throw new Error(`HTTP ${response.status}`);
    Object.assign(board, { at: Date.now(), ok: true });
  } catch (error) {
    board.ok = false;
    log(`greenhouse: could not read the Greenhouse: ${error.message}`);
  }
}
/** The developer's offer on the Greenhouse, as last read, for the week that resets at `weekResetsAt`,
 * or for the week that has not reset yet when that is not given. */
function ownOffer(weekResetsAt = null) {
  const now = Date.now();
  return board.offers.find(o => o.developer.toLowerCase() === login &&
    (weekResetsAt ? Date.parse(o.week_resets_at) === Date.parse(weekResetsAt) : Date.parse(o.week_resets_at) > now)) ?? null;
}
/** The share of the week that the developer's worker has used, from the developer's offer on the
 * Greenhouse for the week that resets at `weekResetsAt`. 0 when there is no offer, null when the
 * Greenhouse cannot be read. */
async function workerUsed(weekResetsAt) {
  await readBoard();
  return board.ok ? ownOffer(weekResetsAt)?.used ?? 0 : null;
}

/** The developer's standing settings on the Greenhouse, as last read, or null. */
const ownSettings = () => board.developerSettings.find(d => d.developer.toLowerCase() === login) ?? null;
/** When the current week resets: from the plan's usage, or else from the developer's offer. */
const weekResetsAt = () => last.usage?.weekResetsAt ?? ownOffer()?.week_resets_at ?? null;
/** restNow() for the developer's standing settings and the current week. */
const restAt = now => restNow(ownSettings(), weekResetsAt(), now);

/** Saves `changes` ({ useRest?, useRestAt?, restKept? }) to the developer's standing settings on the
 * Greenhouse, so that the worker on any of the developer's machines follows them. Throws with the
 * Greenhouse's reason when it refuses. */
export async function saveDeveloperSettings(changes) {
  const url = await greenhouseUrl();
  if (!url) throw new Error("Bloom's tool server did not say where the Greenhouse runs");
  if (!login) await readBoard();
  if (!login) throw new Error("this machine's GitHub login is not known");
  const token = (await execFileP("gh", ["auth", "token"], { windowsHide: true })).stdout.trim();
  const response = await fetch(`${url}/api/developers/${encodeURIComponent(login)}/settings`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(changes),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `the Greenhouse answered ${response.status}`);
  board.at = 0;
  await readBoard();
  startIfMayWork("the developer changed their settings on the Greenhouse");
}
/** Brings this clone of bloom-team-skills and the worker's instructions up to date, with git and
 * node only, when the clone is on main and behind it (auto-update.mjs --if-behind). A pull that
 * changes this service's code restarts the service, as any change to it does. */
function updateTeamSkills() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "update-team-skills", "auto-update.mjs");
  execFile(process.execPath, [script, "--if-behind"], { windowsHide: true, timeout: 5 * 60_000 }, (error, stdout) => {
    if (error) log("greenhouse: updating bloom-team-skills failed: " + String(error.message).split("\n")[0]);
    else if (stdout.trim()) log("greenhouse: " + stdout.trim().split("\n").at(-1));
  });
}
// The greenhouse repository's set-claude-token.mjs installs this script, with the plan's token.
const usageScript = () => path.join(os.homedir(), ".config", "claude-usage", "claude-usage.mjs");
// Orca keeps each bot's folder here, so a session whose folder is under it is a bot's.
const botsDir = () => path.join(os.homedir(), ".orca", "bots");
// How old the usage behind the status bar button's number may get. A read is one request to Claude.
const SUMMARY_MS = 15 * 60_000;
const KEEP_DAYS = 60;

/** The saved settings, or null when the developer has saved none. */
export function savedSettings() {
  const saved = readJsonFile(settingsFile(), null);
  return saved ? cleanSettings(saved) : null;
}
// The page saves each change as it is made, so the worker is considered once the changes stop.
const SETTLE_MS = 5_000;
let settleTimer = null;
export function saveSettings(input) {
  const settings = cleanSettings(input);
  writeJsonFile(settingsFile(), settings);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => startIfMayWork("its settings changed"), SETTLE_MS);
  return settings;
}

// ---- the history ----------------------------------------------------------------------------
let history = null;   // the parsed lines, read once and then kept in step with each append
function readHistory() {
  if (history) return history;
  history = [];
  try {
    for (const line of fs.readFileSync(historyFile(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { history.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return history;
}
function append(entry) {
  readHistory().push(entry);
  try { fs.appendFileSync(historyFile(), JSON.stringify(entry) + "\n"); } catch (e) { log("greenhouse history: " + e.message); }
}
function prune() {
  const from = Date.now() - KEEP_DAYS * 86_400_000;
  const kept = readHistory().filter(e => e.at >= from);
  if (kept.length === history.length) return;
  history = kept;
  try {
    fs.writeFileSync(historyFile() + ".tmp", kept.map(e => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
    fs.renameSync(historyFile() + ".tmp", historyFile());
  } catch (e) { log("greenhouse history: " + e.message); }
}
const lastAt = kind => readHistory().reduce((max, e) => (e.kind === kind ? Math.max(max, e.at) : max), 0);

const norm = p => path.resolve(p).toLowerCase();
const lastBotAt = new Map();
/** Called with each hook payload that the service receives from a Claude session on this machine. */
export function recordHook(payload) {
  const cwd = payload?.cwd ? norm(payload.cwd) : "";
  if (!cwd) return;
  const bots = norm(botsDir());
  if (cwd.startsWith(bots + path.sep)) {
    const bot = cwd.slice(bots.length + 1).split(path.sep)[0];
    if (isGreenhouseWorker(bot)) {
      lastWorkerAt = Date.now();
      // The tick looks at whether the worker is done, once Orca shows the session that stopped as done.
      if (["Stop", "SessionEnd"].includes(payload.hook_event_name)) workerStoppedAt = Date.now();
    }
    if (Date.now() - (lastBotAt.get(bot) ?? 0) < 60_000) return;
    lastBotAt.set(bot, Date.now());
    append({ kind: "bot", at: Date.now(), bot });
  } else if (payload.hook_event_name === "UserPromptSubmit") {
    append({ kind: "prompt", at: Date.now() });
  }
}

// ---- shutting the machine down after the worker ---------------------------------------------
/** Whether the Orca bot in `folder` under the bots folder is the Greenhouse worker, by the name
 * that its bot.json gives it. */
function isGreenhouseWorker(folder) {
  const bot = readJsonFile(path.join(botsDir(), folder, "bot.json"), null);
  return /^greenhouse worker$/i.test(bot?.name ?? "");
}

const SHUT_DOWN_WARNING_S = 300;
let shutDownStarted = false;
let lastCheck = Date.now();
// When a session of the worker last did anything, and when one last stopped and the service has not
// yet settled whether the worker is done. Each is 0 until it happens in this run of the service.
let lastWorkerAt = 0;
let workerStoppedAt = 0;
let ticking = false;
/** Runs once a minute: starts a session of the worker when startDecision() says so (its hours or the
 * use of the rest of the week may just have begun), and shuts the machine down when its hours have
 * just ended, or when a session of the worker stopped and the worker is done. */
async function everyMinute() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const since = lastCheck;
    lastCheck = now.getTime();
    if (slept(now, since)) noteWake(since);
    const settings = savedSettings();
    if (settings && hoursBegan(settings, { now, since })) await startIfMayWork("its hours began");
    else if (settings && restBegan(settings, restWindow(ownSettings(), weekResetsAt()), { now, since })) await startIfMayWork("the time came to use the rest of the week");
    else if (settings) await startIfMayWork("a session may start");
    await checkShutDown("tick", since);
    if (workerStoppedAt) await checkShutDown("workerStopped", since);
  } catch (error) {
    say("a tick", String(error.message));
  } finally {
    ticking = false;
  }
}

/** Shuts the machine down when shutDownReason() gives a reason, once for the life of the service.
 * Windows shows its warning for SHUT_DOWN_WARNING_S first, and `shutdown /a` cancels it. */
async function checkShutDown(event, since) {
  if (shutDownStarted) return;
  const settings = savedSettings();
  if (!settings || !settings.shutDownAfterWorker) return;
  const now = new Date();
  // While a session that the service knows of without asking Orca is at work, the worker is not done,
  // and nothing else needs asking.
  if (event === "workerStopped" && (await decideStart(now)).atWork > 0) return;
  const { idleMs } = await presence();
  const reason = shutDownReason(settings, { event, now, since, lastPromptAt: lastAt("prompt"), idleMs, rest: restAt(now) });
  if (!reason) { if (event === "workerStopped") workerStoppedAt = 0; return; }
  // A session of the worker that stops may leave others at work, and the service starts another when
  // there is more to take. The worker is done when no session is at work and there is nothing that it
  // could take, or the gate refused it (the 5-hour ceiling, nothing left of the week).
  // Otherwise the next tick looks again.
  if (event === "workerStopped") {
    const decision = await decideStart(now, { orca: true });
    // The gate refused the worker since its last start or claim: to the service, or to the session
    // that stopped, perhaps before it claimed anything.
    const refused = gateNoAt() > Math.max(lastStartAt, ...claimTimes());
    if (decision.atWork > 0 || !(decision.done || refused)) return;
    workerStoppedAt = 0;
  }
  if (process.platform !== "win32") { log(`greenhouse worker: ${reason}, but shutting down is only done on Windows`); return; }
  shutDownStarted = true;
  log(`greenhouse worker: ${reason}; shutting the machine down in ${SHUT_DOWN_WARNING_S / 60} minutes`);
  const message = `Bloom Greenhouse: ${reason}. To keep this machine on, run "shutdown /a" within ${SHUT_DOWN_WARNING_S / 60} minutes.`;
  execFile("shutdown", ["/s", "/t", String(SHUT_DOWN_WARNING_S), "/c", message], { windowsHide: true }, error => {
    if (!error) return;
    shutDownStarted = false;
    log("greenhouse worker: shutdown failed: " + error.message);
  });
}

// ---- starting the worker, and whether it may work ------------------------------------------
const orcaExe = () => {
  const installed = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Orca", "resources", "bin", "orca.exe");
  return fs.existsSync(installed) ? installed : "orca";
};
const execFileP = promisify(execFile);
const START_NAME = "Greenhouse worker's hours";
// The model and effort of every session of the worker, on every developer's machine, whatever that
// machine's own Claude Code settings say. A worker never runs on a model above Opus.
const WORKER_MODEL = "claude-opus-5-5";
const WORKER_EFFORT = "medium";
// An Orca call that has not answered in this long has failed, so that a hung orca.exe cannot stop the
// service's ticks.
const ORCA_TIMEOUT_MS = 60_000;
const orcaJson = async args => JSON.parse((await execFileP(orcaExe(), [...args, "--json"], { windowsHide: true, timeout: ORCA_TIMEOUT_MS })).stdout).result;
// The states of an automation's run after it has ended. Any other state is a run still under way.
const RUN_ENDED = new Set(["completed", "failed", "cancelled", "canceled", "skipped_precheck", "error", "timed_out"]);

// What the service knows of the sessions that it started and of the machine's sleep. Each time is
// in milliseconds, 0 until it happens in this run of the service.
let lastStartAt = 0;
let wokeAt = 0;
let lastGateNoAt = 0;
// The times of the service's starts in the last two hours.
let starts = [];
// The last claim that found nothing (or the offer used up), and the ready work items that the
// dashboard listed when the service learned of it.
let miss = null;
let lastReason = "";
const say = (why, reason) => { if (reason !== lastReason) log(`greenhouse worker: not started (${why}): ${reason}`); lastReason = reason; };

// greenhouse.mjs keeps, for each session of the worker, the work item that it claimed and when,
// whether it paused or finished it, and its Orca chat; and the last claim that found nothing.
const SESSIONS_FILE = () => path.join(os.homedir(), ".claude", "greenhouse-sessions.json");
const CLAIM_MISS_FILE = () => path.join(os.homedir(), ".claude", "greenhouse-claim-miss.json");
// greenhouse.mjs notes here when a session's gate last said no.
const GATE_NO_FILE = () => path.join(os.homedir(), ".claude", "greenhouse-gate-no.json");
/** When the gate last said no, to the service or to a session, in milliseconds, or 0. */
function gateNoAt() {
  const noted = readJsonFile(GATE_NO_FILE(), null);
  return Math.max(lastGateNoAt, noted?.at ? Date.parse(noted.at) || 0 : 0);
}
// A session at work writes its transcript at least this often (greenhouse.mjs's AT_WORK_MS).
const AT_WORK_MS = 60 * 60_000;
/** The worker bot's folder under the bots folder, or null. */
function workerFolder() {
  try { return fs.readdirSync(botsDir()).find(isGreenhouseWorker) ?? null; } catch { return null; }
}
/** When the transcripts of Claude session `session` in the worker's folder last changed, or 0. */
function lastWritten(session) {
  const folder = workerFolder();
  if (!folder) return 0;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects", path.join(botsDir(), folder).replace(/[^a-zA-Z0-9]/g, "-"));
  let latest = 0;
  for (const name of [session + ".jsonl", session]) {
    try {
      const stat = fs.statSync(path.join(projects, name));
      latest = Math.max(latest, stat.mtimeMs);
      if (stat.isDirectory()) for (const f of fs.readdirSync(path.join(projects, name), { recursive: true }))
        if (String(f).endsWith(".jsonl")) latest = Math.max(latest, fs.statSync(path.join(projects, name, String(f))).mtimeMs);
    } catch {}
  }
  return latest;
}
const readSessions = () => Object.entries(readJsonFile(SESSIONS_FILE(), {}) ?? {});
/** The sessions of the worker that hold a work item (claimed, neither paused nor finished it) and
 * wrote their transcripts after `since`. */
const claimingSessions = since => readSessions().filter(([id, s]) => s?.claimed && !s.paused && s.finished !== s.claimed && lastWritten(id) > since);
/** The times when sessions on this machine claimed a work item. */
const claimTimes = () => readSessions().map(([, s]) => (s?.claimedAt ? Date.parse(s.claimedAt) : 0)).filter(Boolean);
/** The machine woke from a sleep that began after `since`. When a session of the worker was at work
 * then, the service waits before it starts another (startDecision). */
function noteWake(since) {
  if (claimingSessions(since - AT_WORK_MS).length) wokeAt = Date.now();
}

/** The worker's chats, other than its Home Chat, that Orca shows at work, by their ids. */
async function liveWorkerChats() {
  const chats = new Set((await orcaJson(["bot", "chats", "--bot", "Greenhouse Worker"])).chats.filter(c => !c.home && !c.closed).map(c => c.id.toLowerCase()));
  return (await orcaJson(["agent", "list"])).agents.filter(a => chats.has(String(a.orcaSessionId).toLowerCase()) && a.state !== "done").map(a => String(a.orcaSessionId).toLowerCase());
}
/** Whether the installed worker counts its tokens by session, without which two of its sessions at
 * once would count each other's tokens. */
function workerNewEnough() {
  const folder = workerFolder();
  try { return !!folder && fs.readFileSync(path.join(botsDir(), folder, ".claude", "skills", "greenhouse-api", "greenhouse.mjs"), "utf8").includes("--this-session"); }
  catch { return false; }
}
/** Whether the worker has used what the gate would allocate it: its share of the week, or, while it
 * may use the rest of the week, nothing short of the whole week (the gate itself checks what is left). */
function offerUsedUp(now) {
  const offer = ownOffer();
  if (!offer) return false;
  if (restAt(now)) return offer.used >= 1;
  return offer.used >= current().settings.values.weekShare;
}

/**
 * startDecision() for this moment, from what the service last read of the Greenhouse, the worker's
 * sessions and greenhouse.mjs's notes, with `atWork` beside it. Reads nothing from the Greenhouse.
 * A session is at work when it holds a work item and wrote within AT_WORK_MS, when the service
 * started it in the last ten minutes and no claim has answered that start yet, or (with `orca`) when
 * Orca shows its chat at work and it holds no work item: a chat whose turn ended while it waits on a
 * command may show as done, and Orca may be slow to show a new chat. Orca is asked only when the rest would start a session,
 * or with `orca`.
 */
async function decideStart(now, { orca = false } = {}) {
  starts = starts.filter(t => now.getTime() - t < 2 * 60 * 60_000);
  const noted = readJsonFile(CLAIM_MISS_FILE(), null);
  const missAt = noted?.at ? Date.parse(noted.at) : 0;
  if (missAt && missAt !== miss?.at && board.ok) miss = { at: missAt, queueIds: board.queue.map(w => w.id) };
  const claiming = claimingSessions(now.getTime() - AT_WORK_MS);
  const flight = startsInFlight({ starts, claims: claimTimes(), now, boardAt: board.at });
  const known = claiming.length + flight.unclaimed;
  const decide = atWork => ({
    atWork,
    ...startDecision({
      now,
      boardOk: board.ok,
      parallelSessions: current().settings.values.parallelSessions,
      newEnough: workerNewEnough(),
      atWork,
      work: workToTake({ board, login, machine: os.hostname(), heldAtWork: claiming.map(([, s]) => s.claimed), miss, now, pendingStarts: flight.pending }),
      offerUsedUp: offerUsedUp(now),
      lastStartAt, wokeAt, lastMissAt: missAt, lastClaimAt: Math.max(0, ...claimTimes()), lastGateNoAt: gateNoAt(), lastWorkerAt,
    }),
  });
  const first = decide(known);
  if (!first.start && !orca) return first;
  // Live chats that hold no work item may be the starts on their way or other sessions (one cleaning
  // up after its report); counting both errs toward a session too many, which only delays a start.
  const holding = new Set(claiming.map(([id, s]) => s.orca ?? id));
  const others = (await liveWorkerChats()).filter(chat => !holding.has(chat)).length;
  return decide(known + others);
}

let starting = false;
/** Starts one session of the Greenhouse worker bot when startDecision() says so and everything that
 * the gate checks lets it work: first what it checks before the plan's usage, then the gate itself.
 * `why` goes in the log, each time the reason not to start changes. Every start goes through here. */
async function startIfMayWork(why) {
  if (starting) return;
  starting = true;
  try {
    const now = new Date();
    const values = withValues(current().settings);
    const context = { now, lastPromptAt: lastAt("prompt"), rest: restAt(now) };
    // The worker's setting, its hours and the developer's last prompt first, which need no process.
    if (!mayWorkBeforeUsage(values, context)) return say(why, "the worker's share, its hours or the developer's last prompt do not allow it");
    const decision = await decideStart(now);
    if (!decision.start) return say(why, decision.reason);
    if (!mayWorkBeforeUsage(values, { ...context, ...(await presence()) })) return say(why, "the power or the developer's presence do not allow it");
    const gate = await workerGateNow();
    if (!gate.mayWork) { lastGateNoAt = Date.now(); return say(why, gate.reason); }
    lastReason = "";
    await startWorker(why);
  } catch (error) {
    say(why, "starting the worker failed: " + String(error.stderr || error.message).trim());
  } finally {
    starting = false;
  }
}

/** Starts a session of the Greenhouse worker bot, as an Orca automation that runs once, a few seconds
 * from now, in a chat of its own: in the bot's main chat, where its owner talks to it, an interrupt
 * from the owner would end the run while it holds a claim. A message to the bot (`orca orchestration
 * send`) would need an Orca terminal to send it from, which the service lacks. Each start has an
 * automation of its own, named START_NAME and the time; Orca keeps such an automation after its run,
 * so the ones whose runs have ended are removed. */
async function startWorker(why) {
  for (const a of (await orcaJson(["automations", "list"])).automations) {
    if (!a.name.startsWith(START_NAME)) continue;
    const runs = (await orcaJson(["automations", "runs", "--id", a.id])).runs;
    if (runs.length && runs.every(r => RUN_ENDED.has(r.status))) await orcaJson(["automations", "remove", a.id]);
  }
  const prompt = "Work on the Greenhouse as your SOUL.md says: before each claim run `node greenhouse.mjs gate`, and stop when it says that you may not work.";
  const by = new Date(Date.now() + 5_000).toISOString();
  await orcaJson(["automations", "create", "--name", `${START_NAME} ${new Date().toISOString()}`, "--bot", "Greenhouse Worker", "--runs-in", "new", "--results-to", "chat", "--model", WORKER_MODEL, "--effort", WORKER_EFFORT, "--once", "--by", by, "--prompt", prompt]);
  lastStartAt = Date.now();
  starts.push(lastStartAt);
  workerStoppedAt = 0;
  log(`greenhouse worker: started a session of the worker (${why})`);
}

/** Milliseconds since the last keyboard or mouse input and whether the machine is on AC power, as
 * presence.ps1 reports them; both null when they cannot be read. */
async function presence() {
  if (process.platform !== "win32") return { idleMs: null, onAc: null };
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(path.dirname(fileURLToPath(import.meta.url)), "presence.ps1")], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      try { if (error) throw error; const p = JSON.parse(stdout); resolve({ idleMs: p.idleMs ?? null, onAc: p.onAc ?? null }); }
      catch (e) { log("greenhouse worker: presence: " + (e.message || e)); resolve({ idleMs: null, onAc: null }); }
    });
  });
}

/** The answer to the worker's `gate`: workerGate() for this moment, with the usage read now. */
export async function workerGateNow() {
  await readUsage();
  const { settings } = current();
  const values = withValues(settings);
  const now = new Date();
  const machine = await presence();
  const p = last.usage ? plan(values, last.usage, now) : null;
  return { ...workerGate(values, p, { now, lastPromptAt: lastAt("prompt"), rest: restAt(now), ...machine }), usage: last.usage, usageError: last.error || null };
}

// ---- the plan's usage -----------------------------------------------------------------------
// The last usage that could be read, when it was read, and why the latest read failed if it did.
const last = { usage: null, at: 0, error: "", triedAt: 0 };
let reading = null;
function readUsage() {
  reading ??= (async () => {
    try {
      if (!fs.existsSync(usageScript())) throw new Error(`${usageScript()} is missing. /update-team-skills installs it with the Greenhouse worker.`);
      const { readWeeklyUsage } = await import(pathToFileURL(usageScript()).href);
      last.usage = await readWeeklyUsage();
      last.at = Date.now();
      last.error = "";
    } catch (e) {
      last.error = String(e.message || e).split("\n")[0];
    } finally {
      last.triedAt = Date.now();
      reading = null;
    }
  })();
  return reading;
}

/** Drops old history once a day, reads the Greenhouse on a machine where the developer saved
 * settings for the worker, and checks once a minute whether to start the worker or shut the machine
 * down. The read goes on while the worker's share is 0, since the developer may turn on the use of
 * the rest of the week from another machine. */
export function startRecording() {
  prune();
  const readIfWorking = () => {
    if (!savedSettings()) return;
    readBoard();
    updateTeamSkills();
  };
  readIfWorking();
  setInterval(readIfWorking, BOARD_EVERY_MS).unref();
  setInterval(prune, 86_400_000).unref();
  setInterval(everyMinute, 60_000).unref();
}

// ---- what the page and the button show ------------------------------------------------------
function current() {
  const saved = savedSettings();
  return { saved, settings: saved ?? cleanSettings() };
}

/** What the page draws. With `read`, the plan's usage is read first (claude-usage.mjs keeps its
 * answer for a minute); without, the last read is used when there is one. */
export async function workerState({ read = true } = {}) {
  if (read || !last.usage) await readUsage();
  const { saved, settings } = current();
  return {
    settings,
    saved: !!saved,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    greenhouseUrl: await greenhouseUrl(),
    usage: last.usage,
    usageAt: last.at || null,
    usageError: last.error,
    plan: last.usage ? plan(withValues(settings), last.usage, new Date()) : null,
    // The part of the week's usage that the worker used, or null when it is not known.
    workerUsed: last.usage ? await workerUsed(last.usage.weekResetsAt) : null,
    // The developer's standing settings on the Greenhouse ({ use_rest, use_rest_at, rest_kept }), or
    // null when they have saved none or the Greenhouse cannot be read, and when this week's use of
    // the rest of the week begins.
    developerSettings: ownSettings(),
    restFrom: restWindow(ownSettings(), last.usage?.weekResetsAt)?.from.toISOString() ?? null,
  };
}

/** The status bar button's text. Never waits: it shows the last read, and starts a new read in
 * the background when that one is old and the developer allocates anything. */
export function workerSummary() {
  const LABEL = "Bloom Greenhouse";
  const { saved, settings } = current();
  if (!saved) return { text: LABEL };
  if (settings.values.weekShare <= 0 && !ownSettings()?.use_rest) return { text: `${LABEL} · worker off` };
  if (Date.now() - Math.max(last.at, last.triedAt) > SUMMARY_MS) readUsage();
  if (!last.usage) return { text: LABEL };
  return { text: `${LABEL} · ${Math.round(plan(withValues(settings), last.usage, new Date()).allocatable * 100)}% allocated` };
}
