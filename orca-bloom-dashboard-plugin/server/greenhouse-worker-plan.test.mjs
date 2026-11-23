import test from "node:test";
import assert from "node:assert/strict";
import { cleanSettings, cleanValues, plan, sameValues, shutDownReason, hoursBegan, workerGate, DEFAULTS, VALUE_DEFAULTS } from "./greenhouse-worker-plan.mjs";

// November 2026: the 19th and the 26th are Thursdays. Times are local, as the plan's are.
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);
// The work week and the worker's values together, as plan() takes them.
const settings = (workdays, keepPerWorkday) => ({ ...cleanSettings(), ...cleanValues({ workdays, keepPerWorkday }) });
const everyDay = settings([0, 1, 2, 3, 4, 5, 6], 0.14);
const weekdays = settings([1, 2, 3, 4, 5], 0.15);
const week = (usage, resetsAt, extra = {}) => ({ usage, weekResetsAt: resetsAt.toISOString(), ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("just after the reset, nearly the whole week is kept for a developer who works every day", () => {
  // Thursday 18:00, reset next Thursday 15:00: six full days and 7 of Thursday's 10 work hours.
  const p = plan(everyDay, week(0.02, at(26, 15)), at(19, 18));
  near(p.workdaysAhead, 6.7);
  near(p.kept, 6.7 * 0.14);
  near(p.lendable, 0.98 - 6.7 * 0.14);
});

test("the night before the reset, what the developer did not use is lendable", () => {
  const p = plan(everyDay, week(0.5, at(26, 15)), at(25, 22));
  near(p.workdaysAhead, 0.7);
  near(p.lendable, 0.5 - 0.7 * 0.14);
});

test("a day that is partly over counts as the part of its work hours that remains", () => {
  // Monday 13:00 of an 8:00 to 18:00 day, reset Tuesday 9:00: half of Monday, a tenth of Tuesday.
  const p = plan(weekdays, week(0.6, at(24, 9)), at(23, 13));
  near(p.workdaysAhead, 0.6);
  assert.deepEqual(p.days.map(d => d.date), ["2026-11-23", "2026-11-24"]);
});

test("a weekend counts for nothing for a developer who works Monday to Friday", () => {
  // Friday 18:00, reset Tuesday 9:00: Monday and a tenth of Tuesday.
  const p = plan(weekdays, week(0.6, at(24, 9)), at(20, 18));
  near(p.workdaysAhead, 1.1);
  near(p.lendable, 0.4 - 1.1 * 0.15);
  assert.deepEqual(p.days.filter(d => !d.works).map(d => d.date), ["2026-11-21", "2026-11-22"]);
});

test("a developer with less left than they keep lends nothing, and the plan says how much is short", () => {
  const p = plan(everyDay, week(0.9, at(26, 15)), at(24, 8));
  assert.equal(p.lendable, 0);
  near(p.kept, 0.1);
  near(p.short, 2.7 * 0.14 - 0.1);
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
  ...cleanValues({ workdays: [0, 1, 2, 3, 4, 5, 6], workStart: "05:30", workEnd: "21:00", keepPerWorkday: 0.1, ...values }),
});

test("the worker's hours are not work hours, so a workday counts only the work hours outside them", () => {
  // Thursday 18:00, reset next Thursday 15:00, the worker given 16:00 to 18:00 of 8:00 to 18:00:
  // six full days, and 7 of Thursday's 8 own hours.
  const p = plan(withWorker("16:00", "18:00", { workStart: "08:00", workEnd: "18:00" }), week(0.02, at(26, 15)), at(19, 18));
  near(p.workdaysAhead, 6 + 7 / 8);
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
  const s = cleanSettings({ preset: "sometimes", wakeForWorkerHours: "no", workerHours: { days: [6, 6, 8], start: "19:00", end: "19:00" }, custom: { workdays: [5, 1, 1, 9, "2"], workStart: "19:00", workEnd: "07:00", keepPerWorkday: 3, awayAfterMinutes: "45" } });
  assert.equal(s.preset, DEFAULTS.preset);
  assert.equal(s.wakeForWorkerHours, DEFAULTS.wakeForWorkerHours);
  assert.deepEqual(s.workerHours, { days: [6], start: DEFAULTS.workerHours.start, end: DEFAULTS.workerHours.end });
  assert.deepEqual(s.custom.workdays, [1, 2, 5]);
  assert.equal(s.custom.workStart, VALUE_DEFAULTS.workStart);
  assert.equal(s.custom.workEnd, VALUE_DEFAULTS.workEnd);
  assert.equal(s.custom.keepPerWorkday, 1);
  assert.equal(s.custom.awayAfterMinutes, 45);
});

test("settings saved by earlier versions of the page keep their choices", () => {
  assert.equal(cleanSettings({ mode: "away" }).preset, "conservative");
  assert.equal(cleanSettings({ mode: "always" }).preset, "conservative");
  assert.equal(cleanSettings({ preset: "anytime" }).preset, "conservative");
  assert.equal(cleanSettings({ mode: "off" }).preset, "off");
  const earlier = cleanSettings({ preset: "custom", workdays: [1, 2, 3, 4, 5, 6], workStart: "06:00", workEnd: "18:00", custom: { keepPerWorkday: 0.1 } });
  assert.deepEqual(earlier.custom.workdays, [1, 2, 3, 4, 5, 6]);
  assert.equal(earlier.custom.workStart, "06:00");
  assert.equal(cleanSettings({ wakeAfterWork: true }).wakeForWorkerHours, true);
});

test("Custom without values gets the default values", () => {
  assert.deepEqual(cleanSettings({ preset: "custom" }).custom, VALUE_DEFAULTS);
  assert.equal(cleanSettings({ preset: "conservative" }).custom, null);
});

// The worker given 18:00 to 21:00 every day, with the machine to be shut down after it.
const shutting = (changes = {}) => ({ ...cleanSettings({ preset: "conservative", shutDownAfterWorker: true, workerHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "21:00" }, ...changes }) });
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

test("nothing shuts down when the developer chose not to, turned the worker off, or is at the machine", () => {
  const stopped = { event: "workerStopped", now: at(19, 19) };
  assert.equal(shutDownReason(shutting({ shutDownAfterWorker: false }), stopped), null);
  assert.equal(shutDownReason(shutting({ preset: "off" }), stopped), null);
  assert.equal(shutDownReason(shutting(), { ...stopped, lastPromptAt: ms(at(19, 18, 45)) }), null);
  assert.equal(shutDownReason(shutting(), { ...stopped, lastPromptAt: ms(at(19, 18, 30)) }), "the Greenhouse worker stopped");
});

test("sameValues sees custom values copied from Auto as Auto's, and an edited one as different", () => {
  const auto = { ...VALUE_DEFAULTS, keepPerWorkday: 0.07, awayAfterMinutes: null };
  const copied = { ...auto, keepPerWorkday: 7.000000000000001 / 100, awayAfterMinutes: 20 };
  assert.equal(sameValues(copied, auto), true);
  assert.equal(sameValues({ ...copied, keepPerWorkday: 0.08 }, auto), false);
  assert.equal(sameValues({ ...copied, workdays: [1, 2, 3] }, auto), false);
});

test("a developer at the keyboard keeps the machine on after the worker stops", () => {
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(19, 19), idleMs: 60_000 }), null);
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(19, 19), idleMs: 30 * 60_000 }), "the Greenhouse worker stopped");
});

test("the worker is started once, at the first check after its hours begin", () => {
  assert.equal(hoursBegan(shutting(), { now: at(19, 18, 1), since: ms(at(19, 17, 59)) }), true);
  assert.equal(hoursBegan(shutting(), { now: at(19, 18, 2), since: ms(at(19, 18, 1)) }), false);
  assert.equal(hoursBegan(shutting(), { now: at(19, 20), since: ms(at(19, 17)) }), false);
  assert.equal(hoursBegan(shutting({ preset: "off" }), { now: at(19, 18, 1), since: ms(at(19, 17, 59)) }), false);
});

/** The gate's settings: the worker's hours 18:00 to 21:00, Auto's starting values. */
const gated = (changes = {}) => ({ ...shutting(), ...cleanValues({ workdays: [1, 2, 3, 4, 5], ...changes }), ...("preset" in changes ? { preset: changes.preset } : {}) });
const planAt = (now, extra = {}) => plan(gated(), week(0.3, at(26, 15), { fiveHourUsage: 0.1, fiveHourResetsAt: at(19, 22).toISOString(), ...extra }), now);
const away = { idleMs: 60 * 60_000, onAc: true };

test("in its hours, with the developer away and something to lend, the worker may work", () => {
  const g = workerGate(gated(), planAt(at(19, 19)), { now: at(19, 19), ...away });
  assert.equal(g.mayWork, true);
  assert.ok(g.lendable > 0);
  assert.equal(g.until, at(19, 21).toISOString());
});

test("the worker may not work outside its hours, when Off, or on battery", () => {
  assert.equal(workerGate(gated(), planAt(at(19, 17)), { now: at(19, 17), ...away }).mayWork, false);
  assert.equal(workerGate(gated({ preset: "off" }), planAt(at(19, 19)), { now: at(19, 19), ...away }).mayWork, false);
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
