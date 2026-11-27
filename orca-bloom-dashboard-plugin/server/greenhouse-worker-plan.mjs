// What the developer's Greenhouse worker may use of their Claude plan: the settings that the Bloom
// Greenhouse window edits, and the plan that follows from the worker's values and the plan's usage.
// Plain functions of their arguments. Days and work hours are in the machine's own time zone.

// The developer's preferences. The worker is off while its share of the week (`values.weekShare`)
// is 0 and the developer's standing setting to use the rest of the week is off.
export const DEFAULTS = {
  // The only hours when the worker may have this machine: on these weekdays, from `start` to `end`,
  // which runs past midnight when it is earlier than `start`. The developer does not work in them.
  workerHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "21:00" },
  wakeForWorkerHours: false,         // wake the machine from sleep when the worker's hours begin
  shutDownAfterWorker: false,        // shut the machine down when the worker's hours end or the worker stops in them
};
// The values that the developer sets for how the worker uses their plan. The work week serves the
// 5-hour ceilings only: a period that is still running when the developer's work hours begin gets
// the lower one.
export const VALUE_DEFAULTS = {
  workdays: [1, 2, 3, 4, 5],         // Date.getDay() numbers
  workStart: "08:00",
  workEnd: "18:00",
  whileAtComputer: false,            // run while the developer is using this machine
  weekShare: 0,                      // the share of each week that the worker may use
  awayAfterMinutes: 20,              // without input or another Claude session, before the developer counts as away
  fiveHourCeilingInWorkHours: 0.5,   // for a 5-hour period that reaches into the developer's work hours
  fiveHourCeilingOtherwise: 0.9,
  fiveHourHardStop: 0.8,             // stop even during a work item at this share of the 5-hour period
  parallelSessions: 2,               // how many sessions of the worker may be at work at once, 1 to 4
};
// What the first version of the page saved as `mode`.
const OLD_MODES = { off: "off", away: "on", always: "on" };
// The presets that earlier versions saved and that let the worker work.
const ON_PRESETS = ["on", "custom", "conservative", "anytime"];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function between(value, low, high, fallback) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
}
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const weekdays = (value, fallback) => (Array.isArray(value) ? [...new Set(value.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : fallback);

function cleanWorkerHours(input) {
  const d = DEFAULTS.workerHours;
  const h = input && typeof input === "object" ? input : {};
  const hours = HHMM.test(h.start) && HHMM.test(h.end) && h.start !== h.end;
  return { days: weekdays(h.days, d.days), start: hours ? h.start : d.start, end: hours ? h.end : d.end };
}

/** Values that every reader can trust: each one of `input` that is of the right kind and in
 * range, and the default for each one that is not. */
export function cleanValues(input = {}) {
  const d = VALUE_DEFAULTS;
  const hours = HHMM.test(input.workStart) && HHMM.test(input.workEnd) && input.workStart < input.workEnd;
  return {
    workdays: weekdays(input.workdays, d.workdays),
    workStart: hours ? input.workStart : d.workStart,
    workEnd: hours ? input.workEnd : d.workEnd,
    whileAtComputer: bool(input.whileAtComputer, d.whileAtComputer),
    weekShare: between(input.weekShare, 0, 1, d.weekShare),
    awayAfterMinutes: between(input.awayAfterMinutes, 1, 240, d.awayAfterMinutes),
    fiveHourCeilingInWorkHours: between(input.fiveHourCeilingInWorkHours, 0, 1, d.fiveHourCeilingInWorkHours),
    fiveHourCeilingOtherwise: between(input.fiveHourCeilingOtherwise, 0, 1, d.fiveHourCeilingOtherwise),
    fiveHourHardStop: between(input.fiveHourHardStop, 0, 1, d.fiveHourHardStop),
    parallelSessions: Math.round(between(input.parallelSessions, 1, 4, d.parallelSessions)),
  };
}

/** Settings that every reader can trust, as cleanValues does for values; `values` is always there.
 * Earlier versions saved a `preset` (or a `mode`) that turned the worker off whatever its share, kept
 * the developer's values as `custom` and the work week beside the preset, and called the wake choice
 * `wakeAfterWork`. A worker that such a setting turned off gets a share of 0, and each of the others
 * is carried to where it belongs now. */
export function cleanSettings(input = {}) {
  const d = DEFAULTS;
  const old = input.preset !== undefined ? (ON_PRESETS.includes(input.preset) ? "on" : "off") : OLD_MODES[input.mode];
  const given = [input.values, input.custom].find(v => v && typeof v === "object") ?? {};
  const week = { workdays: input.workdays, workStart: input.workStart, workEnd: input.workEnd };
  const values = cleanValues({ ...week, ...given });
  if (old === "off") values.weekShare = 0;
  return {
    workerHours: cleanWorkerHours(input.workerHours),
    wakeForWorkerHours: bool(input.wakeForWorkerHours ?? input.wakeAfterWork, d.wakeForWorkerHours),
    shutDownAfterWorker: bool(input.shutDownAfterWorker, d.shutDownAfterWorker),
    values,
  };
}

/** The worker's share of the week, from settings with or without their values beside them. */
const shareOf = settings => settings.values?.weekShare ?? settings.weekShare;

/** The settings with their values beside them, as the plan and the gate read them. */
export const withValues = settings => ({ ...settings, ...settings.values });

const two = n => String(n).padStart(2, "0");
const dateOf = day => `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
function timeOn(day, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

/** Each calendar day from `from` to `to` with its work hours: { date, start, end, works }.
 * `works` is false on a weekday that the developer does not work. */
export function workHours(settings, from, to) {
  const days = [];
  for (let day = new Date(from.getFullYear(), from.getMonth(), from.getDate()); day <= to; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const date = dateOf(day);
    days.push({ date, start: timeOn(day, settings.workStart), end: timeOn(day, settings.workEnd), works: settings.workdays.includes(day.getDay()) });
  }
  return days;
}

const dayAfter = day => new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

/** The spans of the worker's hours that overlap `from` to `to`: [{ start, end }]. */
export function workerSpans(settings, from, to) {
  const h = settings.workerHours;
  const spans = [];
  // A span that began the day before `from` may still be running.
  for (let day = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1); day <= to; day = dayAfter(day)) {
    if (!h.days.includes(day.getDay())) continue;
    const start = timeOn(day, h.start);
    const end = timeOn(h.end > h.start ? day : dayAfter(day), h.end);
    if (end > from && start < to) spans.push({ start, end });
  }
  return spans;
}

// How soon after the worker's hours end the machine may still be shut down for them. A machine that
// slept through the end and wakes later is being woken by a person.
export const HOURS_ENDED_GRACE_MS = 5 * 60_000;
// A prompt from the developer, or keyboard or mouse input, this recently means that they are at the machine.
export const PRESENT_MS = 20 * 60_000;

/**
 * Why the machine should shut down now, or null. `event` is "tick" (the service's regular check,
 * whose previous run was at `since`, in milliseconds) or "workerStopped" (the Greenhouse worker's
 * session ended a turn or ended). The machine shuts down only when the developer chose that, the
 * worker has a share of the week, and the developer neither sent a prompt (`lastPromptAt`) nor touched the
 * keyboard or mouse (`idleMs`, null when unknown) in the last PRESENT_MS:
 * - at a tick, when one of the worker's spans ended after `since` and no longer than
 *   HOURS_ENDED_GRACE_MS ago;
 * - when the worker stopped inside one of its spans, because workerGate said no (nothing left to
 *   allocate, the 5-hour ceiling) or the Greenhouse had nothing for it.
 * Never while the worker may use the rest of the week (`rest`, as for workerGate).
 */
export function shutDownReason(settings, { event, now, since = now.getTime(), lastPromptAt = 0, idleMs = null, rest = null }) {
  if (!settings.shutDownAfterWorker || shareOf(settings) <= 0) return null;
  if (restInEffect(rest, null, now)) return null;
  const t = now.getTime();
  if (t - lastPromptAt < PRESENT_MS || (idleMs != null && idleMs < PRESENT_MS)) return null;
  if (event === "workerStopped") {
    return workerSpans(settings, now, now).some(s => s.start <= t && t < s.end) ? "the Greenhouse worker stopped" : null;
  }
  const ended = workerSpans(settings, new Date(since), now).some(s => s.end > since && s.end <= t && t - s.end <= HOURS_ENDED_GRACE_MS);
  return ended ? "the Greenhouse worker's hours ended" : null;
}

/** The worker's span that `now` lies in, or undefined. */
function spanAt(settings, now) {
  const t = now.getTime();
  return workerSpans(settings, now, new Date(t + 1)).find(s => s.start <= t && t < s.end);
}

/** Whether one of the worker's spans began after `since` and no longer than HOURS_ENDED_GRACE_MS
 * ago, so that the service starts the worker once at the start of each span, and not when a machine
 * that slept through the start wakes much later. */
/** Whether everything that the gate checks before the plan's usage lets the worker work: its
 * setting, its hours, the machine's power and the developer's absence. Reading the usage is a
 * request to Claude, so the service asks this first. */
export const mayWorkBeforeUsage = (settings, context) => workerGate(settings, null, context).reason === NO_USAGE;

// The service starts no session of the worker within this long of its last start, so that each
// start sees the session that the one before it started.
export const START_GAP_MS = 2 * 60_000;
// A tick of the service this long after the one before means that the machine slept.
export const SLEPT_MS = 5 * 60_000;
// After the machine wakes with sessions of the worker that were at work when it slept, the service
// starts no session for this long, so that they write again and their work items stay theirs.
export const WAKE_WAIT_MS = 25 * 60_000;
// A session that found nothing to claim, or found the offer used up, or a start that led to no claim
// at all, keeps the service from starting another for this long, unless the Greenhouse shows a work
// item that was not ready before. Each start is a chat that costs tokens.
export const MISS_WAIT_MS = 60 * 60_000;
// After the gate said no, the service asks it again only after this long, since asking reads the
// plan's usage from Claude.
export const GATE_AGAIN_MS = 5 * 60_000;
// A claim of this machine that nobody has reported on for this long, and that no session at work
// holds, is one that a new session would resume.
export const QUIET_CLAIM_MS = 60 * 60_000;
// An installed worker that hands each next work item to a new chat itself (one older than counting
// its tokens by session) is started only after it has done nothing for this long, so that the
// service does not start a chat beside the one that it handed to.
export const OLD_WORKER_QUIET_MS = 10 * 60_000;

/**
 * How many work items a new session of the worker on this machine could take, from the Greenhouse's
 * last dashboard answer `board` ({ at, queue, orders, active }), read at `board.at`: the ready work
 * items of open orders, and the work items that `login`'s worker holds on `machine` that are paused or
 * quiet for QUIET_CLAIM_MS and that no session at work holds (`heldAtWork`), less `pendingStarts`,
 * the sessions started that the answer cannot know of yet. After the last claim that found nothing
 * (`miss`, { at, queueIds }, with the ready work items listed when the service learned of it), only
 * a ready work item that is new since then counts, until MISS_WAIT_MS has passed; an answer older
 * than the miss counts nothing.
 */
export function workToTake({ board, login, machine, heldAtWork = [], miss = null, now, pendingStarts = 0 }) {
  const t = now.getTime();
  if (miss && miss.at >= board.at) return 0;
  const recentMiss = miss && t - miss.at < MISS_WAIT_MS ? new Set(miss.queueIds ?? []) : null;
  const open = new Set((board.orders ?? []).filter(o => o.status === "open").map(o => o.id));
  const ready = (board.queue ?? []).filter(w => open.has(w.order_id) && !recentMiss?.has(w.id)).length;
  const held = new Set(heldAtWork);
  const resumable = recentMiss ? 0 : (board.active ?? []).filter(w =>
    String(w.claimed_by ?? "").toLowerCase() === login && w.machine === machine && !held.has(w.id) &&
    (w.paused_at || !w.reported_at || t - Date.parse(w.reported_at) >= QUIET_CLAIM_MS)).length;
  return Math.max(0, ready + resumable - pendingStarts);
}

/**
 * Whether the service should start another session of the worker now, before it asks the gate:
 * { start, reason, done }. `done` says that no session is at work and the worker has nothing more to
 * do for now (no work to take, or the offer used up), which lets the machine shut down after it.
 *
 * `atWork` counts the sessions at work; `parallelSessions` is how many the developer allows, and
 * `newEnough` whether the installed worker counts its tokens by session (without that, one at a
 * time, and only once it has been quiet for OLD_WORKER_QUIET_MS since `lastWorkerAt`). `work` is
 * workToTake(). `offerUsedUp` says that the worker has used what the gate would allocate it.
 * `lastStartAt`, `wokeAt` (0 unless the machine woke with sessions at work), `lastMissAt`,
 * `lastClaimAt` (the latest claim by any session on this machine), `lastGateNoAt` and `lastWorkerAt`
 * are times in milliseconds, 0 when unknown.
 */
export function startDecision({ now, boardOk, parallelSessions, newEnough, atWork, work, offerUsedUp, lastStartAt = 0, wokeAt = 0, lastMissAt = 0, lastClaimAt = 0, lastGateNoAt = 0, lastWorkerAt = 0 }) {
  const t = now.getTime();
  const no = (reason, done = false) => ({ start: false, reason, done: done && atWork === 0 });
  if (!boardOk) return no("the Greenhouse has not been read since the service started");
  const allowed = newEnough ? parallelSessions : 1;
  if (atWork >= allowed) return no(`${atWork} session${atWork === 1 ? " is" : "s are"} at work, of ${allowed} allowed`);
  if (offerUsedUp) return no("the offer is used up", true);
  if (work <= 0) return no("the Greenhouse has nothing for this machine", true);
  if (t - lastStartAt < START_GAP_MS) return no("a session was started less than two minutes ago");
  if (t - wokeAt < WAKE_WAIT_MS) return no("the machine woke with sessions at work, which report first");
  if (!newEnough && t - lastWorkerAt < OLD_WORKER_QUIET_MS) return no("the installed worker starts its own next session, and was at work less than ten minutes ago");
  // A start that led to no claim, and that no claim's miss explains (the chat stopped at the gate,
  // or failed before it claimed), is not repeated for an hour.
  if (lastStartAt > lastClaimAt && lastMissAt < lastStartAt && atWork === 0 && t - lastStartAt < MISS_WAIT_MS)
    return no("the last session that the service started claimed nothing");
  if (t - lastGateNoAt < GATE_AGAIN_MS) return no("the gate said no less than five minutes ago");
  return { start: true, reason: "", done: false };
}

/**
 * Of the times when the service started a session (`starts`) and the times when sessions on this
 * machine claimed a work item (`claims`), each claim answering the earliest start before it that no
 * other claim answered: { unclaimed, pending }. `unclaimed` counts the starts of the last
 * `recentMs` that no claim answered, sessions that are presumably still starting; `pending` counts
 * the sessions that a dashboard answer read at `boardAt` cannot know of: every start after it, and
 * the unclaimed recent starts before it.
 */
export function startsInFlight({ starts, claims, now, boardAt, recentMs = 10 * 60_000 }) {
  const open = [...claims].sort((a, b) => a - b);
  const unanswered = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const i = open.findIndex(c => c >= start);
    if (i >= 0) open.splice(i, 1);
    else unanswered.push(start);
  }
  const recent = unanswered.filter(start => now.getTime() - start < recentMs);
  return { unclaimed: recent.length, pending: starts.filter(start => start > boardAt).length + recent.filter(start => start <= boardAt).length };
}

/** Whether a tick at `now`, after the one at `since`, comes after the machine slept. */
export const slept = (now, since) => now.getTime() - since >= SLEPT_MS;

export function hoursBegan(settings, { now, since }) {
  if (shareOf(settings) <= 0) return false;
  const t = now.getTime();
  return workerSpans(settings, new Date(since), now).some(s => s.start > since && s.start <= t && t - s.start <= HOURS_ENDED_GRACE_MS);
}

/** Whether `rest` ({ from, until, kept }, or null) lets the worker use the rest of the week at
 * `now`: from `from` until `until`, and only for the week that `p` (when known) is about. */
function restInEffect(rest, p, now) {
  const t = now.getTime();
  if (!rest || t < rest.from.getTime() || t >= Date.parse(rest.until)) return false;
  return !p || Date.parse(p.weekResetsAt) === Date.parse(rest.until);
}

/**
 * For the developer's standing settings from the Greenhouse ({ use_rest, use_rest_day, use_rest_at,
 * rest_kept }), when the worker may use the rest of the week that resets at `weekResetsAt`:
 * { from, until, kept }. `from` is the last time that the weekday `use_rest_day` (0 for Sunday; null
 * for the day before the reset) and `use_rest_at` (HH:MM) come before the reset, in this machine's
 * time zone; `until` is the reset and `kept` the share of the week that the worker leaves to the
 * developer. The setting stays on from week to week, so each week gets its own window. Null when
 * the setting is off or the reset is not known. The greenhouse app's restLabel works it out the same way.
 */
export function restWindow(setting, weekResetsAt) {
  if (!setting?.use_rest || !weekResetsAt || !HHMM.test(setting.use_rest_at ?? "")) return null;
  const reset = new Date(weekResetsAt);
  const day = Number.isInteger(setting.use_rest_day) ? setting.use_rest_day : (reset.getDay() + 6) % 7;
  let from = timeOn(new Date(reset.getFullYear(), reset.getMonth(), reset.getDate() - ((reset.getDay() - day + 7) % 7)), setting.use_rest_at);
  if (from >= reset) from = timeOn(new Date(from.getFullYear(), from.getMonth(), from.getDate() - 7), setting.use_rest_at);
  return { from, until: reset.toISOString(), kept: between(setting.rest_kept, 0, 1, 0.02) };
}

/** restWindow() when `now` lies in it, and null otherwise. */
export function restNow(setting, weekResetsAt, now) {
  const w = restWindow(setting, weekResetsAt);
  return w && restInEffect(w, null, now) ? w : null;
}

/** Whether the worker's time to use the rest of the week (`rest`, from restWindow()) began after
 * `since` and no longer than HOURS_ENDED_GRACE_MS ago, so that the service starts the worker then. */
export function restBegan(settings, rest, { now, since }) {
  if (!rest) return false;
  const from = rest.from.getTime(), t = now.getTime();
  return from > since && from <= t && t - from <= HOURS_ENDED_GRACE_MS && t < Date.parse(rest.until);
}

const percentOf = share => `${Math.round(share * 1000) / 10}%`;

/**
 * Whether the Greenhouse worker may claim a work item now, for `settings` (with the worker's
 * values), `p` (plan() for the usage just read, or null when it could not be read) and what the
 * machine reports: `idleMs` since the last keyboard or mouse input (null when unknown),
 * `lastPromptAt` (the developer's last prompt in a Claude session that is not a bot's) and `onAc`
 * (false on battery, null when unknown).
 *
 * { mayWork, reason, allocatable, weekShare, weekResetsAt, until, stopNow }. `reason` says why not.
 * `weekShare` is the share of the week that the developer gives the worker, and `allocatable` that
 * share or what is left of the week, whichever is less. The worker's own use so far is the
 * Greenhouse's to count: greenhouse.mjs sets the offer to the smaller of `weekShare` and what the
 * worker used plus what is left of the week. `until` is when the worker's
 * hours end. `stopNow` asks a worker in the middle of a work item to pause it, because the 5-hour
 * period has reached fiveHourHardStop. Anything else lets a work item in progress finish.
 */
const NO_USAGE = "The plan's usage could not be read.";
/**
 * `rest` is restNow() for the developer's standing settings: { from, until, kept } while the worker
 * may use the rest of the week, and null otherwise. Until `until` (when the week resets) the
 * worker's hours do not apply, and the worker may use all of what is left of the week but `kept`
 * (`useRest` true in the answer).
 */
export function workerGate(settings, p, { now, idleMs = null, lastPromptAt = 0, onAc = null, rest: window = null }) {
  const rest = restInEffect(window, p, now);
  const span = spanAt(settings, now);
  const f = p?.fiveHour;
  const stopNow = !!f && f.usage >= settings.fiveHourHardStop;
  const allocatable = !p ? 0 : rest ? Math.max(0, p.left - window.kept) : Math.max(0, p.allocatable);
  const until = rest ? window.until : span ? span.end.toISOString() : null;
  const answer = { allocatable, weekShare: p?.weekShare ?? null, weekResetsAt: p?.weekResetsAt ?? null, until, stopNow, useRest: rest };
  const no = reason => ({ mayWork: false, reason, ...answer });
  if (!rest && settings.weekShare <= 0) return no("The worker's share of the week is 0%.");
  if (!span && !rest) return no("It is outside the worker's hours on this machine.");
  if (onAc === false) return no("The machine is on battery.");
  if (!settings.whileAtComputer) {
    const away = settings.awayAfterMinutes * 60_000;
    if (idleMs != null && idleMs < away) return no(`The developer used the keyboard or mouse ${Math.round(idleMs / 60_000)} minutes ago.`);
    if (now.getTime() - lastPromptAt < away) return no(`The developer sent a prompt ${Math.round((now.getTime() - lastPromptAt) / 60_000)} minutes ago.`);
  }
  if (!p) return no(NO_USAGE);
  if (allocatable <= 0) return no(rest ? `Only the ${percentOf(window.kept)} of this week that the worker leaves to you is left.` : "Nothing of this week's plan is left.");
  if (f && f.usage >= f.ceiling) return no(`The 5-hour period is at ${percentOf(f.usage)}, and the worker stops at ${percentOf(f.ceiling)}.`);
  return { mayWork: true, reason: "", ...answer };
}

/** One day of workHours() less the worker's hours: the spans of it that are the developer's own. */
function ownSpans(settings, day) {
  let spans = [{ start: day.start, end: day.end }];
  for (const w of workerSpans(settings, day.start, day.end)) {
    spans = spans.flatMap(s => [
      { start: s.start, end: new Date(Math.min(s.end, w.start)) },
      { start: new Date(Math.max(s.start, w.end)), end: s.end },
    ]).filter(s => s.end > s.start);
  }
  return spans;
}

/**
 * The week as it stands at `now`, for `settings` (the work week and the worker's values together)
 * and `usage` as claude-usage.mjs reports it
 * ({ usage, weekResetsAt, fiveHourUsage, fiveHourResetsAt }, shares from 0 to 1):
 *
 *   allocatable = the smaller of weekShare and (1 - usage)
 *
 * `fiveHour` is null when the usage carries no 5-hour numbers. Its `ceiling` is the lower one when
 * the period ends after the developer's next work hours begin, since the worker's use would then
 * count against the developer's own. The worker's hours are not work hours. `workerHours` is the
 * worker's span that is under way, or else the next one, or null when the developer gives the
 * worker no hours.
 */
export function plan(settings, usage, now = new Date()) {
  const left = Math.max(0, 1 - usage.usage);
  const next = workHours(settings, now, new Date(now.getTime() + 14 * 86_400_000))
    .flatMap(d => (d.works ? ownSpans(settings, d) : [])).find(s => s.end > now);
  const inWorkHours = !!next && next.start <= now;
  const nextWorkStart = next ? (inWorkHours ? now : next.start) : null;
  let fiveHour = null;
  if (usage.fiveHourUsage != null && usage.fiveHourResetsAt) {
    const reachesWorkHours = nextWorkStart !== null && new Date(usage.fiveHourResetsAt) > nextWorkStart;
    const ceiling = reachesWorkHours ? settings.fiveHourCeilingInWorkHours : settings.fiveHourCeilingOtherwise;
    fiveHour = { usage: usage.fiveHourUsage, resetsAt: usage.fiveHourResetsAt, reachesWorkHours, ceiling, room: Math.max(0, ceiling - usage.fiveHourUsage) };
  }
  const span = workerSpans(settings, now, new Date(now.getTime() + 8 * 86_400_000))[0];
  return {
    weekUsage: usage.usage,
    weekResetsAt: usage.weekResetsAt,
    left,
    weekShare: settings.weekShare,
    allocatable: Math.min(left, settings.weekShare),
    inWorkHours,
    nextWorkStart: nextWorkStart ? nextWorkStart.toISOString() : null,
    fiveHour,
    workerHours: span ? { now: span.start <= now, start: span.start.toISOString(), end: span.end.toISOString() } : null,
  };
}
