// What the developer's Greenhouse worker may use of their Claude plan: the settings that the Bloom
// Greenhouse window edits, and the plan that follows from the worker's values and the plan's usage.
// Plain functions of their arguments. Days and work hours are in the machine's own time zone.

// off: the worker uses nothing. conservative: Auto-Conservative, whose values all come from the developer's history (greenhouse-worker-rules.mjs). custom: the
// values in `custom`, which start as the Auto values and which the developer then edits.
export const PRESETS = ["off", "conservative", "custom"];
// The developer's preferences, which no history can tell, and which they set in every mode.
export const DEFAULTS = {
  preset: "off",
  // The only hours when the worker may have this machine: on these weekdays, from `start` to `end`,
  // which runs past midnight when it is earlier than `start`. The developer does not work in them.
  workerHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "21:00" },
  wakeForWorkerHours: false,         // wake the machine from sleep when the worker's hours begin
  shutDownAfterWorker: false,        // shut the machine down when the worker's hours end or the worker stops in them
  custom: null,                      // the developer's own values, kept until they choose an Auto preset
};
// The values that an Auto preset works out and that Custom lets the developer set.
export const VALUE_DEFAULTS = {
  workdays: [1, 2, 3, 4, 5],         // Date.getDay() numbers
  workStart: "08:00",
  workEnd: "18:00",
  whileAtComputer: false,            // run while the developer is using this machine
  weekShare: 0.3,                    // the share of each week that the worker may use
  awayAfterMinutes: 20,              // without input or another Claude session, before the developer counts as away
  fiveHourCeilingInWorkHours: 0.5,   // for a 5-hour period that reaches into the developer's work hours
  fiveHourCeilingOtherwise: 0.9,
  fiveHourHardStop: 0.8,             // stop even during a work item at this share of the 5-hour period
};
// What the first version of the page saved as `mode`.
const OLD_MODES = { off: "off", away: "conservative", always: "conservative" };

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
  };
}

/** Whether two sets of values are the same once cleaned, with shares compared to a hundredth of a
 * percent, since the page's percent fields carry them through a division by 100. */
export function sameValues(a, b) {
  const x = cleanValues(a), y = cleanValues(b);
  return Object.keys(x).every(k => (typeof x[k] === "number" ? Math.abs(x[k] - y[k]) < 1e-4 : JSON.stringify(x[k]) === JSON.stringify(y[k])));
}

/** Settings that every reader can trust, as cleanValues does for values. Custom always has values.
 * Earlier versions kept the work week beside the preset, and called the wake choice
 * `wakeAfterWork`; those are carried to where they belong now. */
export function cleanSettings(input = {}) {
  const d = DEFAULTS;
  // Auto-Any time, a preset that ran while the developer used the machine, is now Auto-Conservative.
  const preset = PRESETS.includes(input.preset) ? input.preset : input.preset === "anytime" ? "conservative" : OLD_MODES[input.mode] ?? d.preset;
  const given = input.custom && typeof input.custom === "object" ? input.custom : null;
  const week = { workdays: input.workdays, workStart: input.workStart, workEnd: input.workEnd };
  const custom = given ? cleanValues({ ...week, ...given }) : preset === "custom" ? cleanValues(week) : null;
  return {
    preset,
    workerHours: cleanWorkerHours(input.workerHours),
    wakeForWorkerHours: bool(input.wakeForWorkerHours ?? input.wakeAfterWork, d.wakeForWorkerHours),
    shutDownAfterWorker: bool(input.shutDownAfterWorker, d.shutDownAfterWorker),
    custom,
  };
}

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
 * worker is not Off, and the developer neither sent a prompt (`lastPromptAt`) nor touched the
 * keyboard or mouse (`idleMs`, null when unknown) in the last PRESENT_MS:
 * - at a tick, when one of the worker's spans ended after `since` and no longer than
 *   HOURS_ENDED_GRACE_MS ago;
 * - when the worker stopped inside one of its spans, because workerGate said no (nothing left to
 *   allocate, the 5-hour ceiling) or the Greenhouse had nothing for it.
 * Never while the developer lets the worker use the rest of the week (`useRestUntil`, as for workerGate).
 */
export function shutDownReason(settings, { event, now, since = now.getTime(), lastPromptAt = 0, idleMs = null, useRestUntil = null }) {
  if (!settings.shutDownAfterWorker || settings.preset === "off") return null;
  if (restInEffect(useRestUntil, null, now)) return null;
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

// A worker that is not at work is started again this long after it was last active.
export const RESTART_AFTER_MS = 10 * 60_000;
// A start that the worker ended within this time found nothing that it could do: no work item
// ready, or its owner's offer used up. The next start then waits longer, since each start is a
// chat that costs tokens.
export const SHORT_RUN_MS = 5 * 60_000;
export const RESTART_AFTER_SHORT_RUN_MS = 60 * 60_000;
// How often the service looks at whether to start the worker again.
export const RESTART_CHECK_MS = 5 * 60_000;
/**
 * Whether the service should now look at starting a worker that is not at work. Each chat of the
 * worker starts the next one, so a chat that ends without doing so (it crashed, or its owner spoke
 * to it and it answered) would otherwise leave the worker stopped until its hours next begin.
 * `lastStartAt` is the service's last start of the worker, `lastWorkerAt` the last time that a
 * session of the worker did anything, and `lastCheckAt` the last time this answered yes; each is 0
 * when unknown.
 */
export function restartDue({ now, lastStartAt = 0, lastWorkerAt = 0, lastCheckAt = 0 }) {
  const t = now.getTime();
  if (t - lastCheckAt < RESTART_CHECK_MS) return false;
  if (lastStartAt > 0 && lastWorkerAt - lastStartAt < SHORT_RUN_MS) return t - lastStartAt >= RESTART_AFTER_SHORT_RUN_MS;
  return t - Math.max(lastStartAt, lastWorkerAt) >= RESTART_AFTER_MS;
}

export function hoursBegan(settings, { now, since }) {
  if (settings.preset === "off") return false;
  const t = now.getTime();
  return workerSpans(settings, new Date(since), now).some(s => s.start > since && s.start <= t && t - s.start <= HOURS_ENDED_GRACE_MS);
}

/** Whether the developer's setting to let the worker use the rest of the week is in effect at `now`:
 * `useRestUntil` is set, is still ahead, and is the reset of the week that `p` (when known) is about. */
function restInEffect(useRestUntil, p, now) {
  if (!useRestUntil || now.getTime() >= Date.parse(useRestUntil)) return false;
  return !p || Date.parse(p.weekResetsAt) === Date.parse(useRestUntil);
}

/** For an offer from the Greenhouse ({ week_resets_at, use_rest_from }), when the week resets if the
 * developer's setting to let the worker use the rest of it is in effect at `now`, and null otherwise. */
export function useRestUntil(offer, now) {
  if (!offer?.use_rest_from) return null;
  const t = now.getTime();
  return Date.parse(offer.use_rest_from) <= t && t < Date.parse(offer.week_resets_at) ? offer.week_resets_at : null;
}

/** Whether the time that the developer chose for the worker to begin using the rest of the week came
 * after `since` and no longer than HOURS_ENDED_GRACE_MS ago, so that the service starts the worker then. */
export function restBegan(settings, offer, { now, since }) {
  if (settings.preset === "off" || !offer?.use_rest_from) return false;
  const from = Date.parse(offer.use_rest_from), t = now.getTime();
  return from > since && from <= t && t - from <= HOURS_ENDED_GRACE_MS && t < Date.parse(offer.week_resets_at);
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
// The share of the week that the worker leaves to the developer when it uses the rest of the week.
export const REST_KEPT = 0.02;
/**
 * `useRestUntil` is when the week resets, while the developer's setting to let the worker use the
 * rest of the week is in effect (from the time they chose until that reset), and null otherwise.
 * Until then the worker's hours do not apply, and the worker may use all of what is left of the
 * week but REST_KEPT (`useRest` true in the answer).
 */
export function workerGate(settings, p, { now, idleMs = null, lastPromptAt = 0, onAc = null, useRestUntil = null }) {
  const rest = restInEffect(useRestUntil, p, now);
  const span = spanAt(settings, now);
  const f = p?.fiveHour;
  const stopNow = !!f && f.usage >= settings.fiveHourHardStop;
  const allocatable = !p ? 0 : rest ? Math.max(0, p.left - REST_KEPT) : Math.max(0, p.allocatable);
  const until = rest ? useRestUntil : span ? span.end.toISOString() : null;
  const answer = { allocatable, weekShare: p?.weekShare ?? null, weekResetsAt: p?.weekResetsAt ?? null, until, stopNow, useRest: rest };
  const no = reason => ({ mayWork: false, reason, ...answer });
  if (settings.preset === "off") return no("The worker is Off on this machine.");
  if (!span && !rest) return no("It is outside the worker's hours on this machine.");
  if (onAc === false) return no("The machine is on battery.");
  if (!settings.whileAtComputer) {
    const away = settings.awayAfterMinutes * 60_000;
    if (idleMs != null && idleMs < away) return no(`The developer used the keyboard or mouse ${Math.round(idleMs / 60_000)} minutes ago.`);
    if (now.getTime() - lastPromptAt < away) return no(`The developer sent a prompt ${Math.round((now.getTime() - lastPromptAt) / 60_000)} minutes ago.`);
  }
  if (!p) return no(NO_USAGE);
  if (!rest && p.weekShare <= 0) return no("The worker's share of the week is 0%.");
  if (allocatable <= 0) return no(rest ? `Only the ${percentOf(REST_KEPT)} of this week that the worker leaves to you is left.` : "Nothing of this week's plan is left.");
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
