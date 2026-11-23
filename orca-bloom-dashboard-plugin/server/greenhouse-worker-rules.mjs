// The rules that give the Conservative preset its values from this machine's
// history: the plan's readings, the times of the developer's prompts, and the times when an Orca
// bot was at work (greenhouse-worker.mjs records all three in greenhouse-history.jsonl). Plain
// functions of their arguments. Each rule looks at the last WINDOW_DAYS only, so that it follows
// a change in how the developer works, and gives a starting value until it has enough to go on.
import { workHours, VALUE_DEFAULTS, cleanValues } from "./greenhouse-worker-plan.mjs";

export const WINDOW_DAYS = 28;
export const MIN_WORKDAYS = 8;      // recorded workdays before the share kept comes from history
export const MIN_PERIODS = 8;       // recorded 5-hour periods in work hours before their ceiling does
export const MIN_PAUSES = 50;       // pauses between prompts before the time to count as away does
export const MIN_PROMPT_DAYS = 21;  // how far back the prompts must reach before the work week comes from them
export const BUSY_DAY = 20;         // prompts on a day that make it a working day
const MARGIN = 1.25;                // each rule keeps a quarter more than the history shows
const MAX_READING_GAP = 3 * 3_600_000;   // readings further apart than this say nothing about the time between
const BOT_GAP = 15 * 60_000;        // bot activity closer together than this is one run
const BOT_PAD = 5 * 60_000;         // and the run is taken to begin and end this much beyond it
const SESSION_BREAK = 60 * 60_000;  // a longer pause between prompts ends a work session
const FIVE_HOURS = 5 * 3_600_000;
const DAY = 86_400_000;

export const PRESET_RULES = {
  conservative: { whileAtComputer: false, inWorkHoursCap: 0.5 },
};

const sorted = list => [...list].sort((a, b) => a - b);
function quantile(values, q) {
  const s = sorted(values);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
}
const percent = share => `${Math.round(share * 1000) / 10}%`;
const shortDate = date => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const startOfDay = time => { const d = new Date(time); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const overlapsAny = (start, end, spans) => spans.some(s => s.start < end && start < s.end);

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const minutesOf = time => { const d = new Date(time); return d.getHours() * 60 + d.getMinutes(); };
const hhmm = minutes => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const clockText = minutes => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The developer's workdays and work hours, from their prompts in the window before today:
 * { values: { workdays, workStart, workEnd }, sources }. A weekday is a workday when BUSY_DAY or
 * more prompts were sent on at least 3 of its last 4 occurrences. The hours run from a time that 9
 * in 10 of those busy days began after, to one that 9 in 10 ended before, each rounded outward to
 * the half hour. Until the prompts reach back MIN_PROMPT_DAYS, the starting values.
 */
export function workWeek(history, now) {
  const today = startOfDay(now);
  const from = today - WINDOW_DAYS * DAY;
  const all = history.filter(e => e.kind === "prompt");
  const earliest = all.reduce((min, e) => Math.min(min, e.at), Infinity);
  const start = reason => ({
    values: { workdays: VALUE_DEFAULTS.workdays, workStart: VALUE_DEFAULTS.workStart, workEnd: VALUE_DEFAULTS.workEnd },
    sources: { workdays: { from: "start", reason }, workHours: { from: "start", reason } },
  });
  const recordedDays = Number.isFinite(earliest) ? Math.floor((today - startOfDay(earliest)) / DAY) : 0;
  if (recordedDays < MIN_PROMPT_DAYS) return start(`A starting value until ${MIN_PROMPT_DAYS} days of your prompts are recorded (${recordedDays} so far).`);

  const days = new Map();   // the start of each day -> { weekday, count, first, last }
  for (const e of all) {
    if (e.at < from || e.at >= today) continue;
    const key = startOfDay(e.at);
    const d = days.get(key) ?? { weekday: new Date(key).getDay(), count: 0, first: Infinity, last: -Infinity };
    d.count++;
    d.first = Math.min(d.first, minutesOf(e.at));
    d.last = Math.max(d.last, minutesOf(e.at));
    days.set(key, d);
  }
  const busy = [...days.values()].filter(d => d.count >= BUSY_DAY);
  const busyOn = WEEKDAY.map((_, w) => busy.filter(d => d.weekday === w).length);
  const workdays = WEEKDAY.map((_, w) => w).filter(w => busyOn[w] >= 3);
  if (!workdays.length) return start(`A starting value: none of your weekdays had ${BUSY_DAY} or more prompts on 3 of its last 4.`);

  const worked = busy.filter(d => workdays.includes(d.weekday));
  const begin = Math.floor(quantile(worked.map(d => d.first), 0.1) / 30) * 30;
  const end = Math.min(23 * 60 + 59, Math.ceil((quantile(worked.map(d => d.last), 0.9) + 1) / 30) * 30);
  const others = WEEKDAY.map((name, w) => (workdays.includes(w) ? null : `${name} on ${busyOn[w]}`)).filter(Boolean);
  return {
    values: { workdays, workStart: hhmm(begin), workEnd: hhmm(end) },
    sources: {
      workdays: { from: "history", reason: `You sent ${BUSY_DAY} or more prompts on at least 3 of the last 4 of each of these days.` + (others.length ? ` Of the others: ${others.join(", ")}.` : "") },
      workHours: { from: "history", reason: `9 in 10 of your workdays in the last ${WINDOW_DAYS / 7} weeks began after ${clockText(begin)} and ended before ${clockText(end)}.` },
    },
  };
}

/** The spans in which an Orca bot was at work, from its recorded activity. */
export function botRuns(history) {
  const runs = [];
  for (const at of sorted(history.filter(e => e.kind === "bot").map(e => e.at))) {
    const last = runs[runs.length - 1];
    if (last && at - last.end <= BOT_GAP) last.end = at;
    else runs.push({ start: at, end: at });
  }
  return runs.map(r => ({ start: r.start - BOT_PAD, end: r.end + BOT_PAD }));
}

/** The time between each two readings of the plan that are close enough to say something, with the
 * rise in the week's usage between them. A rise across the week's reset is the later reading's
 * usage. `bot` says that a bot was at work in that time, so the rise is not all the developer's. */
function steps(readings, bots) {
  const list = [...readings].sort((a, b) => a.at - b.at);
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (b.at - a.at > MAX_READING_GAP) continue;
    const rise = a.weekResetsAt === b.weekResetsAt ? Math.max(0, b.usage - a.usage) : b.usage;
    out.push({ start: a.at, end: b.at, rise, bot: overlapsAny(a.at, b.at, bots) });
  }
  return out;
}

/**
 * What the developer used on each workday of the window before today: { date, used, complete }.
 * A rise counts on the day in which the time between its two readings is centered. A day is
 * complete when readings without a bot at work cover all of its work hours.
 */
export function dailyUse(history, settings, now) {
  const from = startOfDay(now) - WINDOW_DAYS * DAY;
  const bots = botRuns(history);
  const all = steps(history.filter(e => e.kind === "plan" && e.at >= from), bots);
  const days = workHours(settings, new Date(from), new Date(startOfDay(now) - 1)).filter(d => d.works);
  return days.map(d => {
    const start = d.start.getTime(), end = d.end.getTime();
    const dayStart = startOfDay(start), dayEnd = dayStart + DAY;
    const used = all.filter(s => !s.bot && (s.start + s.end) / 2 >= dayStart && (s.start + s.end) / 2 < dayEnd).reduce((sum, s) => sum + s.rise, 0);
    let covered = start;
    for (const s of all) if (!s.bot && s.start <= covered && s.end > covered) covered = s.end;
    const complete = covered >= end && !all.some(s => s.bot && s.start < end && start < s.end);
    return { date: d.date, used, complete };
  });
}

/** The highest share of each 5-hour period that overlapped the developer's work hours on a
 * workday, with no bot at work in it: { start, end, peak }. */
export function workHourPeriods(history, settings, now) {
  const from = startOfDay(now) - WINDOW_DAYS * DAY;
  const bots = botRuns(history);
  const peaks = new Map();
  for (const e of history) {
    if (e.kind !== "plan" || e.at < from || e.fiveHourUsage == null || !e.fiveHourResetsAt) continue;
    peaks.set(e.fiveHourResetsAt, Math.max(peaks.get(e.fiveHourResetsAt) ?? 0, e.fiveHourUsage));
  }
  return [...peaks].map(([reset, peak]) => ({ start: Date.parse(reset) - FIVE_HOURS, end: Date.parse(reset), peak }))
    .filter(p => p.end <= now.getTime() && !overlapsAny(p.start, p.end, bots))
    .filter(p => workHours(settings, new Date(p.start), new Date(p.end)).some(d => d.works && d.start.getTime() < p.end && p.start < d.end.getTime()))
    .sort((a, b) => a.start - b.start);
}

/** The pauses, in minutes, between two of the developer's prompts that both fell in their work
 * hours on a workday, short enough not to end a work session. */
export function pausesBetweenPrompts(history, settings, now) {
  const from = startOfDay(now) - WINDOW_DAYS * DAY;
  const prompts = sorted(history.filter(e => e.kind === "prompt" && e.at >= from).map(e => e.at));
  const inWork = at => workHours(settings, new Date(at), new Date(at)).some(d => d.works && d.start.getTime() <= at && at <= d.end.getTime());
  const pauses = [];
  for (let i = 1; i < prompts.length; i++) {
    const gap = prompts[i] - prompts[i - 1];
    if (gap > 0 && gap < SESSION_BREAK && inWork(prompts[i - 1]) && inWork(prompts[i])) pauses.push(gap / 60_000);
  }
  return pauses;
}

/**
 * The worker's values for `settings` and what each one comes from:
 * { preset, values, sources: { <name>: { from, reason } }, recorded }. `sources.workHours` is the
 * one source of workStart and workEnd.
 * `from` is "history", "start" (a starting value until enough is recorded), "preset" (a value that
 * the preset sets), or "custom". With the worker off, the values are Conservative's, so that the
 * page can say what the worker could do.
 */
export function workerValues(settings, history, now = new Date()) {
  if (settings.preset === "custom") {
    const values = cleanValues(settings.custom ?? {});
    const sources = Object.fromEntries([...Object.keys(values), "workHours"].map(k => [k, { from: "custom", reason: "" }]));
    return { preset: "custom", values, sources, recorded: recordedSoFar(history, values, now) };
  }
  const week = workWeek(history, now);
  const days = dailyUse(history, week.values, now).filter(d => d.complete);
  const periods = workHourPeriods(history, week.values, now);
  const pauses = pausesBetweenPrompts(history, week.values, now);
  const name = "conservative";
  const rule = PRESET_RULES[name];
  const values = { ...VALUE_DEFAULTS, ...week.values, whileAtComputer: rule.whileAtComputer };
  const sources = {
    ...week.sources,
    whileAtComputer: { from: "preset", reason: "" },
    fiveHourCeilingOtherwise: { from: "preset", reason: "Nothing of yours needs a period that ends before you start work." },
    fiveHourHardStop: { from: "preset", reason: "" },
  };

  if (days.length < MIN_WORKDAYS) {
    sources.keepPerWorkday = { from: "start", reason: `A starting value until ${MIN_WORKDAYS} of your workdays are recorded (${days.length} so far).` };
  } else {
    const heaviest = days.reduce((top, d) => (d.used > top.used ? d : top));
    values.keepPerWorkday = Math.min(1, Math.ceil(heaviest.used * MARGIN * 100) / 100);
    sources.keepPerWorkday = { from: "history", reason: `Your heaviest workday in the last ${WINDOW_DAYS / 7} weeks used ${percent(heaviest.used)}, on ${shortDate(heaviest.date + "T12:00")}. This keeps a quarter more.` };
  }

  if (periods.length < MIN_PERIODS) {
    values.fiveHourCeilingInWorkHours = rule.inWorkHoursCap;
    sources.fiveHourCeilingInWorkHours = { from: "start", reason: `A starting value until ${MIN_PERIODS} of your 5-hour periods in work hours are recorded (${periods.length} so far).` };
  } else {
    const usual = quantile(periods.map(p => p.peak), 0.75);
    values.fiveHourCeilingInWorkHours = Math.max(0.1, Math.min(rule.inWorkHoursCap, Math.floor((1 - usual * MARGIN) * 100) / 100));
    sources.fiveHourCeilingInWorkHours = { from: "history", reason: `In 3 of every 4 of your 5-hour periods during work hours you used ${percent(usual)} or less. The worker leaves you that and a quarter more, and never goes past ${percent(rule.inWorkHoursCap)}.` };
  }

  if (pauses.length < MIN_PAUSES) {
    sources.awayAfterMinutes = { from: "start", reason: `A starting value until ${MIN_PAUSES} pauses between your prompts in work hours are recorded (${pauses.length} so far).` };
  } else {
    const long = quantile(pauses, 0.9);
    values.awayAfterMinutes = Math.max(15, Math.min(60, Math.round(2 * long)));
    sources.awayAfterMinutes = { from: "history", reason: `9 of every 10 pauses between your prompts during work hours lasted ${Math.round(long)} minutes or less. You count as away after twice that, kept between 15 and 60 minutes.` };
  }
  return { preset: name, values, sources, recorded: recordedSoFar(history, week.values, now) };
}

/** How much history there is, for the page's note: since when the plan has been read, and how
 * many of each kind of thing that a rule needs. */
function recordedSoFar(history, week, now) {
  const firstReading = history.filter(e => e.kind === "plan").reduce((min, e) => Math.min(min, e.at), Infinity);
  return {
    since: Number.isFinite(firstReading) ? new Date(firstReading).toISOString() : null,
    workdays: dailyUse(history, week, now).filter(d => d.complete).length,
    periods: workHourPeriods(history, week, now).length,
    pauses: pausesBetweenPrompts(history, week, now).length,
  };
}
