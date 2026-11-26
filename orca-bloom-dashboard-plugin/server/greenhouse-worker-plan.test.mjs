import test from "node:test";
import assert from "node:assert/strict";
import { cleanSettings, cleanValues, plan, shutDownReason, hoursBegan, restBegan, restWindow, restNow, workerGate, mayWorkBeforeUsage, restartDue, DEFAULTS, VALUE_DEFAULTS } from "./greenhouse-worker-plan.mjs";

// November 2026: the 19th and the 26th are Thursdays. Times are local, as the plan's are.
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);
// The work week and the worker's values together, as plan() takes them.
const settings = (workdays, weekShare) => ({ ...cleanSettings(), ...cleanValues({ workdays, weekShare }) });
const everyDay = settings([0, 1, 2, 3, 4, 5, 6], 0.14);
const week = (usage, resetsAt, extra = {}) => ({ usage, weekResetsAt: resetsAt.toISOString(), ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("the worker gets its share of the week, whatever the developer has used", () => {
  const p = plan(settings([1, 2, 3, 4, 5], 0.06), week(0.37, at(26, 15)), at(24, 9));
  near(p.weekShare, 0.06);
  near(p.allocatable, 0.06);
  near(p.left, 0.63);
});

test("when less of the week is left than the worker's share, the worker gets what is left", () => {
  const p = plan(everyDay, week(0.95, at(26, 15)), at(25, 22));
  near(p.allocatable, 0.05);
});

test("a fully used week leaves the worker nothing", () => {
  assert.equal(plan(everyDay, week(1, at(26, 15)), at(25, 22)).allocatable, 0);
});

test("a 5-hour period that ends before the next work hours gets the higher ceiling", () => {
  // Thursday 20:00; the period ends at 01:00, and work starts at 8:00.
  const p = plan(everyDay, week(0.3, at(26, 15), { fiveHourUsage: 0.2, fiveHourResetsAt: at(20, 1).toISOString() }), at(19, 20));
  assert.equal(p.inWorkHours, false);
  assert.equal(p.fiveHour.ceiling, VALUE_DEFAULTS.fiveHourCeilingOtherwise);
  near(p.fiveHour.room, 0.7);
});

test("a 5-hour period that reaches into the next work hours gets the lower ceiling", () => {
  // Friday 5:00; the period ends at 10:00, two hours into the workday.
  const p = plan(everyDay, week(0.3, at(26, 15), { fiveHourUsage: 0.2, fiveHourResetsAt: at(20, 10).toISOString() }), at(20, 5));
  assert.equal(p.fiveHour.reachesWorkHours, true);
  assert.equal(p.fiveHour.ceiling, VALUE_DEFAULTS.fiveHourCeilingInWorkHours);
});

test("during work hours the 5-hour period gets the lower ceiling, and none of it is left above the ceiling", () => {
  const p = plan(everyDay, week(0.3, at(26, 15), { fiveHourUsage: 0.6, fiveHourResetsAt: at(20, 14).toISOString() }), at(20, 11));
  assert.equal(p.inWorkHours, true);
  assert.equal(p.fiveHour.ceiling, VALUE_DEFAULTS.fiveHourCeilingInWorkHours);
  assert.equal(p.fiveHour.room, 0);
});

/** Every day from 5:30 to 21:00, with the worker given `start` to `end` every day. */
const withWorker = (start, end, values = {}) => ({
  ...cleanSettings({ workerHours: { days: [0, 1, 2, 3, 4, 5, 6], start, end } }),
  ...cleanValues({ workdays: [0, 1, 2, 3, 4, 5, 6], workStart: "05:30", workEnd: "21:00", weekShare: 0.1, ...values }),
});

test("a 5-hour period that ends inside the worker's hours does not reach into work hours", () => {
  // Work hours end at 21:00, but 18:00 to 21:00 is the worker's; the period ends at 23:30.
  const p = plan(withWorker("18:00", "21:00"), week(0.3, at(26, 15), { fiveHourUsage: 0.1, fiveHourResetsAt: at(19, 23, 30).toISOString() }), at(19, 18, 30));
  assert.equal(p.inWorkHours, false);
  assert.equal(p.fiveHour.reachesWorkHours, false);
  assert.equal(p.fiveHour.ceiling, VALUE_DEFAULTS.fiveHourCeilingOtherwise);
  assert.deepEqual(p.workerHours, { now: true, start: at(19, 18).toISOString(), end: at(19, 21).toISOString() });
});

test("the worker's hours may run past midnight", () => {
  const overnight = withWorker("22:00", "06:00", { workStart: "08:00" });
  assert.deepEqual(plan(overnight, week(0.3, at(26, 15)), at(20, 2)).workerHours, { now: true, start: at(19, 22).toISOString(), end: at(20, 6).toISOString() });
  assert.deepEqual(plan(overnight, week(0.3, at(26, 15)), at(20, 7)).workerHours, { now: false, start: at(20, 22).toISOString(), end: at(21, 6).toISOString() });
});

test("without days for the worker, the plan has no worker's hours", () => {
  const none = { ...withWorker("18:00", "21:00"), workerHours: cleanSettings({ workerHours: { days: [], start: "18:00", end: "21:00" } }).workerHours };
  assert.equal(plan(none, week(0.3, at(26, 15)), at(19, 12)).workerHours, null);
});

test("usage without 5-hour numbers gives a plan without them", () => {
  assert.equal(plan(everyDay, week(0.3, at(26, 15)), at(20, 11)).fiveHour, null);
});

test("cleanSettings keeps what is valid and puts the default in place of what is not", () => {
  const s = cleanSettings({ wakeForWorkerHours: "no", workerHours: { days: [6, 6, 8], start: "19:00", end: "19:00" }, values: { workdays: [5, 1, 1, 9, "2"], workStart: "19:00", workEnd: "07:00", weekShare: 3, awayAfterMinutes: "45" } });
  assert.equal(s.wakeForWorkerHours, DEFAULTS.wakeForWorkerHours);
  assert.deepEqual(s.workerHours, { days: [6], start: DEFAULTS.workerHours.start, end: DEFAULTS.workerHours.end });
  assert.deepEqual(s.values.workdays, [1, 2, 5]);
  assert.equal(s.values.workStart, VALUE_DEFAULTS.workStart);
  assert.equal(s.values.workEnd, VALUE_DEFAULTS.workEnd);
  assert.equal(s.values.weekShare, 1);
  assert.equal(s.values.awayAfterMinutes, 45);
});

test("settings saved by earlier versions of the page keep their choices, and a worker that they turned off gets a share of 0", () => {
  for (const preset of ["on", "custom", "conservative", "anytime"]) near(cleanSettings({ preset, values: { weekShare: 0.2 } }).values.weekShare, 0.2);
  near(cleanSettings({ mode: "away", values: { weekShare: 0.2 } }).values.weekShare, 0.2);
  assert.equal(cleanSettings({ preset: "off", values: { weekShare: 0.2 } }).values.weekShare, 0);
  assert.equal(cleanSettings({ mode: "off", values: { weekShare: 0.2 } }).values.weekShare, 0);
  assert.equal("preset" in cleanSettings({ preset: "on" }), false);
  const earlier = cleanSettings({ preset: "custom", workdays: [1, 2, 3, 4, 5, 6], workStart: "06:00", workEnd: "18:00", custom: { weekShare: 0.1 } });
  assert.deepEqual(earlier.values.workdays, [1, 2, 3, 4, 5, 6]);
  assert.equal(earlier.values.workStart, "06:00");
  near(earlier.values.weekShare, 0.1);
  assert.equal(cleanSettings({ wakeAfterWork: true }).wakeForWorkerHours, true);
});

test("settings without values get the default values, in which the worker's share is 0", () => {
  assert.deepEqual(cleanSettings({}).values, VALUE_DEFAULTS);
  assert.equal(VALUE_DEFAULTS.weekShare, 0);
});

// The worker given 30% of the week and 18:00 to 21:00 every day, with the machine to be shut down after it.
const shutting = (changes = {}) => ({ ...cleanSettings({ values: { weekShare: 0.3 }, shutDownAfterWorker: true, workerHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "21:00" }, ...changes }) });
const ms = date => date.getTime();

test("the machine shuts down at the first check after the worker's hours end", () => {
  assert.equal(shutDownReason(shutting(), { event: "tick", now: at(19, 21, 1), since: ms(at(19, 20, 59)) }), "the Greenhouse worker's hours ended");
  assert.equal(shutDownReason(shutting(), { event: "tick", now: at(19, 20, 59), since: ms(at(19, 20, 58)) }), null);
  assert.equal(shutDownReason(shutting(), { event: "tick", now: at(19, 21, 3), since: ms(at(19, 21, 2)) }), null);
});

test("a machine that slept through the end of the worker's hours does not shut down when it wakes", () => {
  assert.equal(shutDownReason(shutting(), { event: "tick", now: at(20, 7), since: ms(at(19, 20, 30)) }), null);
});

test("the machine shuts down when the worker stops inside its hours, and not outside them", () => {
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(19, 19) }), "the Greenhouse worker stopped");
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(19, 17) }), null);
});

test("nothing shuts down when the developer chose not to, gave the worker 0% of the week, or is at the machine", () => {
  const stopped = { event: "workerStopped", now: at(19, 19) };
  assert.equal(shutDownReason(shutting({ shutDownAfterWorker: false }), stopped), null);
  assert.equal(shutDownReason(shutting({ values: { weekShare: 0 } }), stopped), null);
  assert.equal(shutDownReason(shutting(), { ...stopped, lastPromptAt: ms(at(19, 18, 45)) }), null);
  assert.equal(shutDownReason(shutting(), { ...stopped, lastPromptAt: ms(at(19, 18, 30)) }), "the Greenhouse worker stopped");
});

test("a developer at the keyboard keeps the machine on after the worker stops", () => {
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(19, 19), idleMs: 60_000 }), null);
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(19, 19), idleMs: 30 * 60_000 }), "the Greenhouse worker stopped");
});

test("the worker is started once, at the first check after its hours begin", () => {
  assert.equal(hoursBegan(shutting(), { now: at(19, 18, 1), since: ms(at(19, 17, 59)) }), true);
  assert.equal(hoursBegan(shutting(), { now: at(19, 18, 2), since: ms(at(19, 18, 1)) }), false);
  assert.equal(hoursBegan(shutting(), { now: at(19, 20), since: ms(at(19, 17)) }), false);
  assert.equal(hoursBegan(shutting({ values: { weekShare: 0 } }), { now: at(19, 18, 1), since: ms(at(19, 17, 59)) }), false);
});

/** The gate's settings: the worker's hours 18:00 to 21:00, 30% of the week, the default values for the rest. */
const gated = (changes = {}) => ({ ...shutting(), ...cleanValues({ workdays: [1, 2, 3, 4, 5], weekShare: 0.3, ...changes }) });
const planAt = (now, extra = {}) => plan(gated(), week(0.3, at(26, 15), { fiveHourUsage: 0.1, fiveHourResetsAt: at(19, 22).toISOString(), ...extra }), now);
const away = { idleMs: 60 * 60_000, onAc: true };

test("in its hours, with the developer away and something to allocate, the worker may work", () => {
  const g = workerGate(gated(), planAt(at(19, 19)), { now: at(19, 19), ...away });
  assert.equal(g.mayWork, true);
  assert.ok(g.allocatable > 0);
  assert.equal(g.until, at(19, 21).toISOString());
});

test("the worker may not work outside its hours, with 0% of the week, or on battery", () => {
  assert.equal(workerGate(gated(), planAt(at(19, 17)), { now: at(19, 17), ...away }).mayWork, false);
  assert.equal(workerGate(gated({ weekShare: 0 }), planAt(at(19, 19)), { now: at(19, 19), ...away }).mayWork, false);
  assert.equal(workerGate(gated(), planAt(at(19, 19)), { now: at(19, 19), idleMs: away.idleMs, onAc: false }).mayWork, false);
});

test("the worker waits while the developer uses the machine, unless it may run then", () => {
  const recent = { now: at(19, 19), idleMs: 60_000, onAc: true };
  assert.equal(workerGate(gated(), planAt(at(19, 19)), recent).mayWork, false);
  assert.equal(workerGate(gated(), planAt(at(19, 19)), { ...away, now: at(19, 19), lastPromptAt: ms(at(19, 18, 55)) }).mayWork, false);
  assert.equal(workerGate(gated({ whileAtComputer: true }), planAt(at(19, 19)), recent).mayWork, true);
});

test("the 5-hour ceiling stops new items, and the hard stop hands back the one in progress", () => {
  const atCeiling = workerGate(gated(), planAt(at(19, 19), { fiveHourUsage: 0.9 }), { now: at(19, 19), ...away });
  assert.equal(atCeiling.mayWork, false);
  assert.equal(atCeiling.stopNow, true);
  const belowHardStop = workerGate(gated(), planAt(at(19, 19), { fiveHourUsage: 0.5 }), { now: at(19, 19), ...away });
  assert.equal(belowHardStop.stopNow, false);
});

test("without the plan's usage the worker may not work", () => {
  assert.equal(workerGate(gated(), null, { now: at(19, 19), ...away }).mayWork, false);
});

test("a worker that stopped without starting its next chat is started again ten minutes after it was last active", () => {
  const started = ms(at(19, 18));
  const lastWorkerAt = ms(at(19, 19));
  assert.equal(restartDue({ now: at(19, 19, 9), lastStartAt: started, lastWorkerAt }), false);
  assert.equal(restartDue({ now: at(19, 19, 10), lastStartAt: started, lastWorkerAt }), true);
  // The service looked two minutes ago, and looks again only after five.
  assert.equal(restartDue({ now: at(19, 19, 12), lastStartAt: started, lastWorkerAt, lastCheckAt: ms(at(19, 19, 10)) }), false);
  assert.equal(restartDue({ now: at(19, 19, 15), lastStartAt: started, lastWorkerAt, lastCheckAt: ms(at(19, 19, 10)) }), true);
  // A service that has just begun knows of no start and no activity.
  assert.equal(restartDue({ now: at(19, 19) }), true);
});

test("a worker whose last start ended within five minutes is started again only after an hour", () => {
  const started = ms(at(19, 18));
  const found = { lastStartAt: started, lastWorkerAt: ms(at(19, 18, 2)) };
  assert.equal(restartDue({ now: at(19, 18, 30), ...found }), false);
  assert.equal(restartDue({ now: at(19, 19), ...found }), true);
  // A start after which the worker did nothing at all counts the same.
  assert.equal(restartDue({ now: at(19, 18, 30), lastStartAt: started, lastWorkerAt: ms(at(19, 17)) }), false);
});

test("the plan's usage is read for a start only when the worker's hours, the power and the developer's absence allow one", () => {
  assert.equal(mayWorkBeforeUsage(gated(), { now: at(19, 19), ...away }), true);
  assert.equal(mayWorkBeforeUsage(gated(), { now: at(19, 12), ...away }), false);
  assert.equal(mayWorkBeforeUsage(gated(), { now: at(19, 19), idleMs: 60_000, onAc: true }), false);
  assert.equal(mayWorkBeforeUsage(gated({ weekShare: 0 }), { now: at(19, 19), ...away }), false);
});

// The week in planAt() resets at(26, 15), a Thursday, with 70% of it left.
const RESET = at(26, 15).toISOString();
const standing = (changes = {}) => ({ use_rest: 1, use_rest_day: null, use_rest_at: "17:00", rest_kept: 0.02, ...changes });

test("the worker begins to use the rest of the week at the last time that the weekday and time that the developer chose come before the week resets", () => {
  // Friday 17:00 comes last on the Friday before; Thursday 9:00, on the morning of the reset; Thursday 17:00, a week before it.
  assert.deepEqual(restWindow(standing({ use_rest_day: 5 }), RESET), { from: at(20, 17), until: RESET, kept: 0.02 });
  assert.equal(restWindow(standing({ use_rest_day: 4, use_rest_at: "09:00" }), RESET).from.getTime(), at(26, 9).getTime());
  assert.equal(restWindow(standing({ use_rest_day: 4 }), RESET).from.getTime(), at(19, 17).getTime());
  assert.equal(restWindow(standing({ use_rest: 0 }), RESET), null);
  assert.equal(restWindow(standing(), null), null);
});

test("without a weekday, the worker begins on the day before the week resets", () => {
  assert.equal(restWindow(standing(), RESET).from.getTime(), at(25, 17).getTime());
  assert.equal(restWindow(standing({ use_rest_at: "09:00" }), RESET).from.getTime(), at(25, 9).getTime());
});

test("the setting stays on, so the next week gets its own window from the same weekday and time", () => {
  const next = restWindow(standing({ use_rest_day: 5 }), at(33, 15).toISOString());
  assert.equal(next.from.getTime(), at(27, 17).getTime());
});

test("in that time the worker may use all of what is left of the week but the share that the developer keeps, outside its hours", () => {
  assert.equal(restNow(standing(), RESET, at(25, 16)), null);
  const now = at(26, 2), rest = restNow(standing({ rest_kept: 0.1 }), RESET, now);
  const g = workerGate(gated(), planAt(now), { now, ...away, rest });
  assert.equal(g.mayWork, true);
  assert.equal(g.useRest, true);
  near(g.allocatable, 0.7 - 0.1);
  assert.equal(g.until, RESET);
  assert.equal(restNow(standing(), RESET, at(26, 15)), null);
});

test("the worker uses the rest of the week with 0% of each week, and still stops for battery, the developer at the machine and the 5-hour ceiling", () => {
  const now = at(26, 2), p = planAt(now), rest = restNow(standing(), RESET, now);
  assert.equal(workerGate(gated({ weekShare: 0 }), p, { now, ...away, rest }).mayWork, true);
  assert.equal(workerGate(gated(), p, { now, idleMs: away.idleMs, onAc: false, rest }).mayWork, false);
  assert.equal(workerGate(gated(), p, { now, idleMs: 60_000, onAc: true, rest }).mayWork, false);
  assert.equal(workerGate(gated(), planAt(now, { fiveHourUsage: 0.95 }), { now, ...away, rest }).mayWork, false);
});

test("a window worked out for another week does not apply to this one", () => {
  const now = at(26, 2);
  const other = restWindow(standing(), at(27, 15).toISOString());
  assert.equal(workerGate(gated(), planAt(now), { now, ...away, rest: other }).useRest, false);
});

test("with less of the week left than the developer keeps, the worker using the rest of the week stops", () => {
  const now = at(26, 2), rest = restNow(standing(), RESET, now);
  assert.equal(workerGate(gated(), plan(gated(), week(0.99, at(26, 15)), now), { now, ...away, rest }).mayWork, false);
});

test("the worker is started once, at the first check after its time to use the rest of the week, and the machine stays on until the week resets", () => {
  const w = restWindow(standing(), RESET);
  assert.equal(restBegan(gated(), w, { now: at(25, 17, 1), since: ms(at(25, 17)) - 60_000 }), true);
  assert.equal(restBegan(gated(), w, { now: at(25, 17, 2), since: ms(at(25, 17, 1)) }), false);
  assert.equal(restBegan(gated({ weekShare: 0 }), w, { now: at(25, 17, 1), since: ms(at(25, 17)) - 60_000 }), true);
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(25, 19), rest: w }), null);
  assert.equal(shutDownReason(shutting(), { event: "tick", now: at(25, 21, 1), since: ms(at(25, 20, 59)), rest: w }), null);
});
