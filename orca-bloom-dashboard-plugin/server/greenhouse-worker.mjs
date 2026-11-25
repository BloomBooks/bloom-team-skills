// The Bloom Greenhouse window's side of the service: the developer's settings for allocating their
// Claude plan to the Greenhouse (greenhouse-worker.json in the data folder), the plan's usage as
// this machine's claude-usage.mjs reports it, the history that the presets learn from, and the
// plan that follows. The Greenhouse worker itself is an Orca bot. This tells it whether it may claim
// an item (workerGate, which greenhouse.mjs's `gate` asks for), starts it through Orca when its hours
// begin and whenever it may work and is not at work, and shuts the machine down after it when the developer chose so (shutDownReason).
//
// The history, greenhouse-history.jsonl in the data folder, holds one JSON object per line:
//   { kind: "plan", at, usage, weekResetsAt, fiveHourUsage, fiveHourResetsAt }  a reading of the
//       plan, at most one an hour, whenever the service runs
//   { kind: "prompt", at }   the developer sent a prompt, in any Claude session on this machine
//   { kind: "bot", at, bot } an Orca bot's session did something, at most once a minute per bot
//   { kind: "seeded", at }   the prompts of the weeks before recording began were taken from the
//       Claude Code transcripts on this machine, once
// `at` is in milliseconds. Lines older than KEEP_DAYS are dropped once a day.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dataFile, readJsonFile, writeJsonFile, log } from "./env.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanSettings, plan, sameValues, shutDownReason, hoursBegan, workerGate, mayWorkBeforeUsage, restartDue } from "./greenhouse-worker-plan.mjs";
import { workerValues } from "./greenhouse-worker-rules.mjs";

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
// and the ETag lets an unchanged answer come back as 304.
const board = { at: 0, etag: null, offers: [] };
const BOARD_MS = 60_000;
/** The share of the week that the developer's worker has used, from the developer's offer on the
 * Greenhouse for the week that resets at `weekResetsAt`. 0 when there is no offer, null when the
 * Greenhouse cannot be read. */
async function workerUsed(weekResetsAt) {
  try {
    if (Date.now() - board.at > BOARD_MS) {
      const url = await greenhouseUrl();
      if (!url) return null;
      const response = await fetch(url + "/api/dashboard", { headers: board.etag ? { "If-None-Match": board.etag } : {}, signal: AbortSignal.timeout(30_000) });
      if (response.status === 200) Object.assign(board, { etag: response.headers.get("etag"), offers: (await response.json()).offers ?? [] });
      else if (response.status !== 304) throw new Error(`HTTP ${response.status}`);
      board.at = Date.now();
    }
    const { developer } = await import("../../developer.mjs");
    const login = (await developer()).github?.toLowerCase();
    const offer = board.offers.find(o => o.developer.toLowerCase() === login && Date.parse(o.week_resets_at) === Date.parse(weekResetsAt));
    return offer?.used ?? 0;
  } catch (error) {
    log(`greenhouse: could not read the worker's use of the week: ${error.message}`);
    return null;
  }
}
// The greenhouse repository's set-claude-token.mjs installs this script, with the plan's token.
const usageScript = () => path.join(os.homedir(), ".config", "claude-usage", "claude-usage.mjs");
// Orca keeps each bot's folder here, so a session whose folder is under it is a bot's.
const botsDir = () => path.join(os.homedir(), ".orca", "bots");
// How old the usage behind the status bar button's number may get. A read is one request to Claude.
const SUMMARY_MS = 15 * 60_000;
const READING_EVERY_MS = 60 * 60_000;
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
    const worker = isGreenhouseWorker(bot);
    if (worker) lastWorkerAt = Date.now();
    if (["Stop", "SessionEnd"].includes(payload.hook_event_name) && worker) checkShutDown("workerStopped");
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
// How long a stop of the worker waits for a chat that it handed work to before it counts as the end.
const HANDOFF_WAIT_MS = 60_000;
let shutDownStarted = false;
let lastCheck = Date.now();
// When the service last started the worker, when a session of the worker last did anything, and
// when the service last looked at starting it again. Each is 0 until it happens in this run of the
// service.
let lastStartAt = 0;
let lastWorkerAt = 0;
let lastRestartCheckAt = 0;
/** Runs once a minute: starts the worker when its hours have just begun or when it may work and is
 * not at work, and shuts the machine down when its hours have just ended. */
function everyMinute() {
  const now = new Date();
  const since = lastCheck;
  lastCheck = now.getTime();
  const settings = savedSettings();
  if (settings && hoursBegan(settings, { now, since })) startIfMayWork("its hours began");
  else if (settings) startIfIdle(now).catch(error => log("greenhouse worker: " + error.message));
  checkShutDown("tick", since);
}

/** Starts the worker when it has not been at work for a while and the gate lets it work. The
 * plan's usage is read only when everything else that the gate checks says yes. */
async function startIfIdle(now) {
  if (!restartDue({ now, lastStartAt, lastWorkerAt, lastCheckAt: lastRestartCheckAt })) return;
  lastRestartCheckAt = now.getTime();
  const { settings, worker } = current();
  const machine = await presence();
  if (!mayWorkBeforeUsage({ ...settings, ...worker.values }, { now, lastPromptAt: lastAt("prompt"), ...machine })) return;
  await startIfMayWork("it was not at work");
}

/** Shuts the machine down when shutDownReason() gives a reason, once for the life of the service.
 * Windows shows its warning for SHUT_DOWN_WARNING_S first, and `shutdown /a` cancels it. */
async function checkShutDown(event, since) {
  if (shutDownStarted) return;
  const settings = savedSettings();
  if (!settings || !settings.shutDownAfterWorker) return;
  const { idleMs } = await presence();
  const now = new Date();
  const reason = shutDownReason(settings, { event, now, since, lastPromptAt: lastAt("prompt"), idleMs });
  if (!reason) return;
  // A chat of the worker that stops may have handed the next work item to a new chat, which is
  // starting while this one ends; the new chat's own stop comes later.
  if (event === "workerStopped") {
    await new Promise(resolve => setTimeout(resolve, HANDOFF_WAIT_MS));
    if (await workerBusy().catch(() => false)) return log("greenhouse worker: a chat of the worker stopped, and another is at work");
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
const orcaJson = async args => JSON.parse((await execFileP(orcaExe(), [...args, "--json"], { windowsHide: true })).stdout).result;
// The states of an automation's run after it has ended. Any other state is a run still under way.
const RUN_ENDED = new Set(["completed", "failed", "cancelled", "canceled", "skipped_precheck", "error", "timed_out"]);
let starting = false;
/** Starts a run of the Greenhouse worker bot when the gate says that it may work now and no run
 * that the service started is still under way. `why` goes in the log. */
async function startIfMayWork(why) {
  if (starting) return;
  starting = true;
  try {
    const gate = await workerGateNow();
    if (!gate.mayWork) return log(`greenhouse worker: not started (${why}): ${gate.reason}`);
    await startWorker(why);
  } catch (error) {
    log(`greenhouse worker: starting the worker failed (${why}): ` + String(error.stderr || error.message).trim());
  } finally {
    starting = false;
  }
}

/** Whether a chat of the worker bot other than its Home Chat is at work. Each chat of the worker
 * hands the next work item to a new chat, so the run that the service started may have ended while
 * the worker carries on in a later chat. */
async function workerBusy() {
  const chats = new Set((await orcaJson(["bot", "chats", "--bot", "Greenhouse Worker"])).chats.filter(c => !c.home && !c.closed).map(c => c.id));
  return (await orcaJson(["agent", "list"])).agents.some(a => chats.has(a.orcaSessionId) && a.state !== "done");
}

/** Starts a run of the Greenhouse worker bot, as an Orca automation that runs once, a few seconds
 * from now, in a chat of its own: in the bot's main chat, where its owner talks to it, an interrupt
 * from the owner would end the run while it holds a claim. A message to the bot (`orca orchestration send`) would need an Orca terminal to send it
 * from, which the service lacks. Orca keeps such an automation after its run, so the one that the
 * last start made is removed first, unless its run is still under way, when nothing is started.
 * Nothing is started either while a chat of the worker is at work. */
async function startWorker(why) {
  if (await workerBusy()) return log(`greenhouse worker: already working (${why})`);
  for (const a of (await orcaJson(["automations", "list"])).automations) {
    if (a.name !== START_NAME) continue;
    const runs = (await orcaJson(["automations", "runs", "--id", a.id])).runs;
    if (runs.some(r => !RUN_ENDED.has(r.status))) return log(`greenhouse worker: already working (${why})`);
    await orcaJson(["automations", "remove", a.id]);
  }
  const prompt = "Work on the Greenhouse as your SOUL.md says: before each claim run `node greenhouse.mjs gate`, and stop when it says that you may not work.";
  const by = new Date(Date.now() + 5_000).toISOString();
  await orcaJson(["automations", "create", "--name", START_NAME, "--bot", "Greenhouse Worker", "--runs-in", "new", "--results-to", "chat", "--once", "--by", by, "--prompt", prompt]);
  lastStartAt = Date.now();
  log(`greenhouse worker: started the worker (${why})`);
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
  const { settings, worker } = current();
  const values = { ...settings, ...worker.values };
  const now = new Date();
  const machine = await presence();
  const p = last.usage ? plan(values, last.usage, now) : null;
  return { ...workerGate(values, p, { now, lastPromptAt: lastAt("prompt"), ...machine }), usage: last.usage, usageError: last.error || null };
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
      if (Date.now() - lastAt("plan") >= READING_EVERY_MS - 5 * 60_000) append({ kind: "plan", at: Date.now(), ...last.usage });
    } catch (e) {
      last.error = String(e.message || e).split("\n")[0];
    } finally {
      last.triedAt = Date.now();
      reading = null;
    }
  })();
  return reading;
}

/**
 * Adds to the history the time of each prompt that the developer typed in the last 28 days, from
 * the Claude Code transcripts on this machine, up to the first prompt that the hooks recorded. A
 * typed prompt is a user line with text that is not a tool's result, a command's output or an
 * interruption. The Orca bots' folders and the service's own prose sessions are skipped. Runs once.
 */
async function seedFromTranscripts() {
  if (readHistory().some(e => e.kind === "seeded")) return;
  const root = path.join(os.homedir(), ".claude", "projects");
  const since = Date.now() - 28 * 86_400_000;
  const until = readHistory().filter(e => e.kind === "prompt").reduce((min, e) => Math.min(min, e.at), Date.now());
  const found = [];
  try {
    for (const dir of fs.readdirSync(root)) {
      if (/orca-bots|bloom-dashboard-llm/i.test(dir)) continue;
      const folder = path.join(root, dir);
      if (!fs.statSync(folder).isDirectory()) continue;
      for (const name of fs.readdirSync(folder)) {
        const file = path.join(folder, name);
        if (!name.endsWith(".jsonl") || fs.statSync(file).mtimeMs < since) continue;
        for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
          if (!line.includes('"type":"user"') || line.includes('"tool_result"') || line.includes('"isMeta":true') || line.includes('"isSidechain":true')) continue;
          let e;
          try { e = JSON.parse(line); } catch { continue; }
          const c = e.message?.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join("") : "";
          const at = Date.parse(e.timestamp);
          if (e.type === "user" && text && !text.startsWith("<") && !text.startsWith("[Request interrupted") && at >= since && at < until) found.push(at);
        }
      }
    }
  } catch (e) {
    log("greenhouse history: reading the transcripts failed: " + e.message);
    return;
  }
  const entries = found.sort((a, b) => a - b).map(at => ({ kind: "prompt", at }));
  entries.push({ kind: "seeded", at: Date.now() });
  readHistory().push(...entries);
  try { fs.appendFileSync(historyFile(), entries.map(e => JSON.stringify(e)).join("\n") + "\n"); } catch (e) { log("greenhouse history: " + e.message); }
  log(`greenhouse history: took ${found.length} prompts from the transcripts`);
}

/** Reads the plan once an hour while the service runs, and drops old history once a day. Does
 * nothing on a machine where the plan cannot be read. */
export function startRecording() {
  prune();
  seedFromTranscripts();
  const tick = () => { if (fs.existsSync(usageScript()) && Date.now() - lastAt("plan") >= READING_EVERY_MS) readUsage(); };
  tick();
  setInterval(tick, 5 * 60_000).unref();
  setInterval(prune, 86_400_000).unref();
  setInterval(everyMinute, 60_000).unref();
}

// ---- what the page and the button show ------------------------------------------------------
function current() {
  const saved = savedSettings();
  const settings = saved ?? cleanSettings();
  const worker = workerValues(settings, readHistory(), new Date());
  return { saved, settings, worker };
}

/** What the page draws. With `read`, the plan's usage is read first (claude-usage.mjs keeps its
 * answer for a minute); without, the last read is used when there is one. */
export async function workerState({ read = true } = {}) {
  if (read || !last.usage) await readUsage();
  const { saved, settings, worker } = current();
  const auto = settings.preset === "custom" ? workerValues({ ...settings, preset: "conservative" }, readHistory(), new Date()).values : worker.values;
  return {
    settings,
    saved: !!saved,
    worker,
    // Whether choosing Auto would lose nothing of the custom values.
    customIsAuto: !!settings.custom && sameValues(settings.custom, auto),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    greenhouseUrl: await greenhouseUrl(),
    usage: last.usage,
    usageAt: last.at || null,
    usageError: last.error,
    plan: last.usage ? plan({ ...settings, ...worker.values }, last.usage, new Date()) : null,
    // The part of the week's usage that the worker used, or null when it is not known.
    workerUsed: last.usage ? await workerUsed(last.usage.weekResetsAt) : null,
  };
}

/** The status bar button's text. Never waits: it shows the last read, and starts a new read in
 * the background when that one is old and the developer allocates anything. */
export function workerSummary() {
  const LABEL = "Bloom Greenhouse";
  const { saved, settings, worker } = current();
  if (!saved) return { text: LABEL };
  if (settings.preset === "off") return { text: `${LABEL} · worker off` };
  if (Date.now() - Math.max(last.at, last.triedAt) > SUMMARY_MS) readUsage();
  if (!last.usage) return { text: LABEL };
  return { text: `${LABEL} · ${Math.round(plan({ ...settings, ...worker.values }, last.usage, new Date()).allocatable * 100)}% allocated` };
}
