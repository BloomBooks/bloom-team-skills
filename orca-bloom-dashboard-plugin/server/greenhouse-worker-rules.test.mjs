import test from "node:test";
import assert from "node:assert/strict";
import { cleanSettings, cleanValues, VALUE_DEFAULTS } from "./greenhouse-worker-plan.mjs";
import { dailyUse, workHourPeriods, pausesBetweenPrompts, botRuns, workWeek, workerValues, PRESET_RULES, MIN_WORKDAYS } from "./greenhouse-worker-rules.mjs";

// November 2026, local time. The 23rd is a Monday; "now" is Monday Nov 30 at 7:00.
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const now = new Date(at(30, 7));
// Auto-Conservative, and a Monday to Friday week for the functions that take one.
const weekdays = { ...cleanSettings({ preset: "conservative" }), ...cleanValues({ workdays: [1, 2, 3, 4, 5] }) };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const RESET = "2026-12-03T22:00:00.000Z";

/** Hourly readings over a day from 7:00 to 19:00, with the week's usage rising by `used` evenly
 * through work hours from `before`. */
function readingsFor(day, before, used, extra = {}) {
  const out = [];
  for (let h = 7; h <= 19; h++) {
    const share = Math.min(1, Math.max(0, (h - 8) / 10));
    out.push({ kind: "plan", at: at(day, h), usage: before + used * share, weekResetsAt: RESET, ...extra });
  }
  return out;
}

test("a workday's use is the rise in the week's usage across it", () => {
  const days = dailyUse(readingsFor(23, 0.2, 0.08), weekdays, now);
  const monday = days.find(d => d.date === "2026-11-23");
  near(monday.used, 0.08);
  assert.equal(monday.complete, true);
});

test("a workday with a gap in its readings is not complete", () => {
  const readings = readingsFor(23, 0.2, 0.08).filter(r => r.at < at(23, 10) || r.at > at(23, 14));
  assert.equal(dailyUse(readings, weekdays, now).find(d => d.date === "2026-11-23").complete, false);
});

test("a rise across the week's reset counts the usage after the reset", () => {
  const readings = [
    { kind: "plan", at: at(23, 7), usage: 0.9, weekResetsAt: "2026-11-23T16:00:00.000Z" },
    { kind: "plan", at: at(23, 9), usage: 0.95, weekResetsAt: "2026-11-23T16:00:00.000Z" },
    { kind: "plan", at: at(23, 11), usage: 0.03, weekResetsAt: RESET },
  ];
  near(dailyUse(readings, weekdays, now).find(d => d.date === "2026-11-23").used, 0.05 + 0.03);
});

test("what rises while a bot is at work is not the developer's, and the day is not complete", () => {
  const history = [...readingsFor(23, 0.2, 0.08), { kind: "bot", at: at(23, 12, 10) }, { kind: "bot", at: at(23, 12, 20) }];
  const monday = dailyUse(history, weekdays, now).find(d => d.date === "2026-11-23");
  assert.equal(monday.complete, false);
  assert.ok(monday.used < 0.08);
});

test("bot activity close together is one run, padded on both sides", () => {
  const runs = botRuns([{ kind: "bot", at: at(23, 1) }, { kind: "bot", at: at(23, 1, 10) }, { kind: "bot", at: at(23, 3) }]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].end - runs[0].start, 20 * 60_000);
});

test("weekends do not count as workdays for a Monday to Friday developer", () => {
  const dates = dailyUse([], weekdays, now).map(d => new Date(d.date + "T12:00").getDay());
  assert.ok(dates.every(day => day >= 1 && day <= 5));
});

/** Ten recorded workdays, using the given shares. */
function tenWorkdays(uses) {
  const days = [16, 17, 18, 19, 20, 23, 24, 25, 26, 27];
  return days.flatMap((day, i) => readingsFor(day, 0.1, uses[i]));
}

test("before enough workdays are recorded, a preset keeps its starting value and says so", () => {
  const v = workerValues(weekdays, tenWorkdays([0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]).filter(r => r.at > at(23, 0)), now);
  assert.equal(v.values.weekShare, VALUE_DEFAULTS.weekShare);
  assert.equal(v.sources.weekShare.from, "start");
  assert.equal(v.recorded.workdays < MIN_WORKDAYS, true);
});

test("Conservative gives the worker what a week of the heaviest recorded workday, and a quarter more, leaves", () => {
  // The heaviest workday used 8%; five such days and a quarter more are 50% of the week.
  const v = workerValues(weekdays, tenWorkdays([0.05, 0.06, 0.04, 0.08, 0.05, 0.06, 0.05, 0.07, 0.04, 0.05]), now);
  assert.equal(v.sources.weekShare.from, "history");
  assert.equal(v.values.weekShare, 0.5);
});

test("5-hour periods in work hours give a ceiling that leaves the developer their usual peak", () => {
  const history = [];
  for (const day of [16, 17, 18, 19, 20, 23, 24, 25, 26, 27]) {
    const reset = new Date(at(day, 14)).toISOString();
    history.push({ kind: "plan", at: at(day, 10), usage: 0.3, weekResetsAt: RESET, fiveHourUsage: 0.1, fiveHourResetsAt: reset });
    history.push({ kind: "plan", at: at(day, 13), usage: 0.3, weekResetsAt: RESET, fiveHourUsage: 0.4, fiveHourResetsAt: reset });
  }
  assert.equal(workHourPeriods(history, weekdays, now).length, 10);
  const v = workerValues(weekdays, history, now);
  assert.equal(v.sources.fiveHourCeilingInWorkHours.from, "history");
  assert.equal(v.values.fiveHourCeilingInWorkHours, 0.5);   // 1 - 0.4 x 1.25 = 0.5, within the cap
  const heavy = history.map(e => (e.fiveHourUsage === 0.4 ? { ...e, fiveHourUsage: 0.6 } : e));
  assert.equal(workerValues(weekdays, heavy, now).values.fiveHourCeilingInWorkHours, 0.25);
});

test("a 5-hour period that lies outside work hours does not count", () => {
  const night = [{ kind: "plan", at: at(24, 1), usage: 0.3, weekResetsAt: RESET, fiveHourUsage: 0.5, fiveHourResetsAt: new Date(at(24, 3)).toISOString() }];
  assert.equal(workHourPeriods(night, weekdays, now).length, 0);
});

test("the time to count as away is twice the long pauses between prompts in work hours", () => {
  // Each day, 20 pauses: four of every five last 4 minutes, the fifth 10 minutes.
  const history = [];
  for (const day of [23, 24, 25, 26, 27]) {
    let t = at(day, 9);
    for (let i = 0; i <= 20; i++) { history.push({ kind: "prompt", at: t }); t += (i % 5 === 4 ? 10 : 4) * 60_000; }
  }
  assert.equal(pausesBetweenPrompts(history, weekdays, now).length, 100);
  const v = workerValues(weekdays, history, now);
  assert.equal(v.sources.awayAfterMinutes.from, "history");
  assert.equal(v.values.awayAfterMinutes, 20);   // 9 in 10 pauses last 10 minutes or less; twice that
});

test("a pause long enough to end a work session is not a pause", () => {
  const history = [{ kind: "prompt", at: at(23, 9) }, { kind: "prompt", at: at(23, 11) }];
  assert.equal(pausesBetweenPrompts(history, weekdays, now).length, 0);
});

/** Prompts on each day of the 4 weeks before `now`: `count` of them, evenly from `first` to `last`
 * o'clock, on the weekdays in `on`. */
function promptsOver(on, count, first, last) {
  const out = [];
  for (let day = 2; day <= 29; day++) {
    if (!on.includes(new Date(2026, 10, day).getDay())) continue;
    for (let i = 0; i < count; i++) out.push({ kind: "prompt", at: at(day, first) + Math.round(((last - first) * 3_600_000 * i) / (count - 1)) });
  }
  return out;
}

test("the work week is the weekdays with many prompts, and the hours they span", () => {
  // Busy Monday to Saturday from 6:00 to 17:40; a few prompts on Sundays.
  const history = [...promptsOver([1, 2, 3, 4, 5, 6], 30, 6, 17 + 40 / 60), ...promptsOver([0], 5, 8, 9)];
  const week = workWeek(history, now);
  assert.deepEqual(week.values.workdays, [1, 2, 3, 4, 5, 6]);
  assert.equal(week.values.workStart, "06:00");
  assert.equal(week.values.workEnd, "18:00");
  assert.equal(week.sources.workdays.from, "history");
});

test("until the prompts reach back three weeks, the work week is the starting one", () => {
  const recent = promptsOver([1, 2, 3, 4, 5, 6], 30, 6, 18).filter(e => e.at >= at(16, 0));
  const week = workWeek(recent, now);
  assert.deepEqual(week.values.workdays, VALUE_DEFAULTS.workdays);
  assert.equal(week.sources.workdays.from, "start");
});

test("an Auto preset's values follow the work week from the prompts", () => {
  const history = promptsOver([1, 2, 3, 4, 5, 6], 30, 6, 17.5);
  const v = workerValues(weekdays, history, now);
  assert.deepEqual(v.values.workdays, [1, 2, 3, 4, 5, 6]);
  assert.equal(v.values.workStart, "06:00");
});

test("Custom gives the developer's own values, and Off gives Conservative's", () => {
  const custom = cleanSettings({ preset: "custom", custom: { weekShare: 0.2, whileAtComputer: true } });
  const v = workerValues(custom, [], now);
  assert.equal(v.values.weekShare, 0.2);
  assert.equal(v.sources.weekShare.from, "custom");
  const off = workerValues(cleanSettings({ preset: "off" }), [], now);
  assert.equal(off.preset, "conservative");
  assert.equal(off.values.fiveHourCeilingInWorkHours, PRESET_RULES.conservative.inWorkHoursCap);
});
