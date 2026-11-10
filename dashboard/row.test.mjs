// Tests for how row.js merges Orca's live agents into a row. Run: node --test "dashboard/*.test.mjs"
// row.js is a browser script that defines only constants and functions when it loads, so it runs
// here in a vm context with no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./row.js", import.meta.url), "utf8");
const { withLiveAgents } = vm.runInNewContext(source + "\n;({ withLiveAgents })", {});

const wt = "D:/BL-1-x";
const minutes = n => new Date(Date.now() - n * 60000).toISOString();
// A preflight run that reached Discover and never recorded its end.
const unendedRun = updatedMinutesAgo => ({
  startedAt: minutes(updatedMinutesAgo), updatedAt: minutes(updatedMinutesAgo),
  steps: { discover: { state: "running" } },
});
const merge = (progress, agent) =>
  withLiveAgents([{ worktree: wt, progress }], { [wt.toLowerCase()]: { working: true, ...agent } })[0];

test("an agent on request-peer-review keeps its skill when an older preflight run never ended", () => {
  const row = merge(unendedRun(14 * 60), { skill: "request-peer-review", since: Date.now() - 60000 });
  assert.equal(row.skill, "request-peer-review");
});

test("an agent on merge-without-peer-review keeps its skill when an older preflight run never ended", () => {
  const row = merge(unendedRun(14 * 60), { skill: "merge-without-peer-review", since: Date.now() - 60000 });
  assert.equal(row.skill, "merge-without-peer-review");
});

test("request-peer-review that hands the work back to preflight shows as preflight", () => {
  const row = merge(unendedRun(1), { skill: "request-peer-review", since: Date.now() - 10 * 60000 });
  assert.equal(row.skill, "preflight");
});

test("an agent started some other way shows as preflight while a run is recording", () => {
  const row = merge(unendedRun(14 * 60), { skill: "youtrack-fix", since: Date.now() - 60000 });
  assert.equal(row.skill, "preflight");
});

test("an ended run leaves the agent's skill alone", () => {
  const run = { ...unendedRun(30), endedAt: minutes(20) };
  const row = merge(run, { skill: "request-peer-review", since: Date.now() - 60000 });
  assert.equal(row.skill, "request-peer-review");
});
