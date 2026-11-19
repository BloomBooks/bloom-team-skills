// Tests for comment-runs.mjs, which moves a card in peer review while an agent processes its PR's
// comments. Run: node --test "orca-bloom-dashboard-plugin/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentRunSteps, unchanged } from "./comment-runs.mjs";

const run = (over = {}) => ({ skill: "process-pr-comments", worktree: "d:/wt", state: "working", ...over });
const steps = (runs, state) => commentRunSteps({ runs }, wt => wt === "d:/wt" ? { card: "BL-1", state } : null).map(s => s.step);

test("an open run on a card in Ready For Code Review or Has Comments starts", () => {
  assert.deepEqual(steps([run()], "Ready For Code Review"), ["start"]);
  assert.deepEqual(steps([run({ state: "waiting" })], "Has Comments"), ["start"]);
  const [s] = commentRunSteps({ runs: [run()] }, () => ({ card: "BL-1", state: "Has Comments" }));
  assert.equal(s.card, "BL-1");
  assert.equal(s.from, "Has Comments");
});

test("a run on a card In Progress, a run with no row, and other skills do nothing", () => {
  assert.deepEqual(steps([run()], "In Progress"), []);
  assert.deepEqual(commentRunSteps({ runs: [run()] }, () => null), []);
  assert.deepEqual(steps([run({ skill: "preflight" })], "Ready For Code Review"), []);
});

test("a run that closed before the card was moved does nothing", () => {
  assert.deepEqual(steps([run({ state: "finished" })], "Ready For Code Review"), []);
  assert.deepEqual(steps([run({ state: "ended" })], "Ready For Code Review"), []);
});

test("a run that moved its card finishes or leaves it once, and waits while a move is under way", () => {
  const moved = { card: "BL-1", from: "Ready For Code Review", before: { head: "a", changes: "x" } };
  assert.deepEqual(steps([run({ cardMove: moved })], "In Progress"), []);
  assert.deepEqual(steps([run({ state: "finished", cardMove: moved })], "In Progress"), ["finish"]);
  assert.deepEqual(steps([run({ state: "ended", cardMove: moved })], "In Progress"), ["leave"]);
  assert.deepEqual(steps([run({ state: "finished", cardMove: { ...moved, pending: true } })], "In Progress"), []);
  assert.deepEqual(steps([run({ state: "finished", cardMove: { ...moved, settled: true } })], "In Progress"), []);
});

test("the checkout is unchanged only with the same HEAD and the same uncommitted changes", () => {
  assert.equal(unchanged({ head: "a", changes: "x" }, { head: "a", changes: "x" }), true);
  assert.equal(unchanged({ head: "a", changes: "x" }, { head: "b", changes: "x" }), false);
  assert.equal(unchanged({ head: "a", changes: "x" }, { head: "a", changes: "y" }), false);
  assert.equal(unchanged(null, { head: "a", changes: "x" }), false);
  assert.equal(unchanged({ head: "a", changes: "x" }, null), false);
});
