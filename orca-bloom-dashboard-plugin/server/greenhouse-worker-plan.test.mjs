import test from "node:test";
import assert from "node:assert/strict";
import { cleanSettings, cleanValues, plan, sameValues, shutDownReason, hoursBegan, restBegan, useRestUntil, workerGate, mayWorkBeforeUsage, restartDue, REST_KEPT, DEFAULTS, VALUE_DEFAULTS } from "./greenhouse-worker-plan.mjs";

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
  const s = cleanSettings({ preset: "sometimes", wakeForWorkerHours: "no", workerHours: { days: [6, 6, 8], start: "19:00", end: "19:00" }, custom: { workdays: [5, 1, 1, 9, "2"], workStart: "19:00", workEnd: "07:00", weekShare: 3, awayAfterMinutes: "45" } });
  assert.equal(s.preset, DEFAULTS.preset);
  assert.equal(s.wakeForWorkerHours, DEFAULTS.wakeForWorkerHours);
  assert.deepEqual(s.workerHours, { days: [6], start: DEFAULTS.workerHours.start, end: DEFAULTS.workerHours.end });
  assert.deepEqual(s.custom.workdays, [1, 2, 5]);
  assert.equal(s.custom.workStart, VALUE_DEFAULTS.workStart);
  assert.equal(s.custom.workEnd, VALUE_DEFAULTS.workEnd);
  assert.equal(s.custom.weekShare, 1);
  assert.equal(s.custom.awayAfterMinutes, 45);
});

test("settings saved by earlier versions of the page keep their choices", () => {
  assert.equal(cleanSettings({ mode: "away" }).preset, "conservative");
  assert.equal(cleanSettings({ mode: "always" }).preset, "conservative");
  assert.equal(cleanSettings({ preset: "anytime" }).preset, "conservative");
  assert.equal(cleanSettings({ mode: "off" }).preset, "off");
  const earlier = cleanSettings({ preset: "custom", workdays: [1, 2, 3, 4, 5, 6], workStart: "06:00", workEnd: "18:00", custom: { weekShare: 0.1 } });
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
  const auto = { ...VALUE_DEFAULTS, weekShare: 0.07, awayAfterMinutes: null };
  const copied = { ...auto, weekShare: 7.000000000000001 / 100, awayAfterMinutes: 20 };
  assert.equal(sameValues(copied, auto), true);
  assert.equal(sameValues({ ...copied, weekShare: 0.08 }, auto), false);
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

test("in its hours, with the developer away and something to allocate, the worker may work", () => {
  const g = workerGate(gated(), planAt(at(19, 19)), { now: at(19, 19), ...away });
  assert.equal(g.mayWork, true);
  assert.ok(g.allocatable > 0);
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
  assert.equal(mayWorkBeforeUsage(gated({ preset: "off" }), { now: at(19, 19), ...away }), false);
});

// The week in planAt() resets at(26, 15), with 70% of it left.
const restOffer = from => ({ week_resets_at: at(26, 15).toISOString(), use_rest_from: from?.toISOString() ?? null });

test("from the time that the developer chose until the week resets, the worker may use all but REST_KEPT of what is left, outside its hours", () => {
  const offer = restOffer(at(19, 17));
  assert.equal(useRestUntil(offer, at(19, 16)), null);
  const until = useRestUntil(offer, at(20, 2));
  assert.equal(until, at(26, 15).toISOString());
  const g = workerGate(gated(), planAt(at(20, 2)), { now: at(20, 2), ...away, useRestUntil: until });
  assert.equal(g.mayWork, true);
  assert.equal(g.useRest, true);
  near(g.allocatable, 0.7 - REST_KEPT);
  assert.equal(g.until, until);
  assert.equal(useRestUntil(offer, at(26, 15)), null);
});

test("using the rest of the week still stops for Off, battery, the developer at the machine and the 5-hour ceiling", () => {
  const now = at(20, 2), until = at(26, 15).toISOString(), p = planAt(now);
  assert.equal(workerGate(gated({ preset: "off" }), p, { now, ...away, useRestUntil: until }).mayWork, false);
  assert.equal(workerGate(gated(), p, { now, idleMs: away.idleMs, onAc: false, useRestUntil: until }).mayWork, false);
  assert.equal(workerGate(gated(), p, { now, idleMs: 60_000, onAc: true, useRestUntil: until }).mayWork, false);
  assert.equal(workerGate(gated(), planAt(now, { fiveHourUsage: 0.95 }), { now, ...away, useRestUntil: until }).mayWork, false);
});

test("a setting to use the rest of an earlier week does not apply to the week after it", () => {
  const now = at(20, 2);
  assert.equal(workerGate(gated(), planAt(now), { now, ...away, useRestUntil: at(19, 15).toISOString() }).mayWork, false);
  assert.equal(workerGate(gated(), planAt(now), { now, ...away, useRestUntil: at(27, 15).toISOString() }).useRest, false);
});

test("with less than REST_KEPT of the week left, the worker using the rest of the week stops", () => {
  const now = at(20, 2), until = at(26, 15).toISOString();
  const g = workerGate(gated(), plan(gated(), week(1 - REST_KEPT / 2, at(26, 15)), now), { now, ...away, useRestUntil: until });
  assert.equal(g.mayWork, false);
});

test("the worker is started once, at the first check after the time to use the rest of the week, and the machine stays on until the week resets", () => {
  const offer = restOffer(at(19, 23));
  assert.equal(restBegan(gated(), offer, { now: at(19, 23, 1), since: ms(at(19, 23)) - 60_000 }), true);
  assert.equal(restBegan(gated(), offer, { now: at(19, 23, 2), since: ms(at(19, 23, 1)) }), false);
  assert.equal(restBegan(gated({ preset: "off" }), offer, { now: at(19, 23, 1), since: ms(at(19, 23)) - 60_000 }), false);
  const until = useRestUntil(offer, at(20, 3));
  assert.equal(shutDownReason(shutting(), { event: "workerStopped", now: at(20, 19), useRestUntil: useRestUntil(offer, at(20, 19)) }), null);
  assert.equal(shutDownReason(shutting(), { event: "tick", now: at(20, 21, 1), since: ms(at(20, 20, 59)), useRestUntil: until }), null);
});
