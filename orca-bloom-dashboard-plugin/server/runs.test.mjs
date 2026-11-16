import test from "node:test";
import assert from "node:assert/strict";
import { applyHook, applyInterrupt, applyProgress, checkLiveness, emptyState, latestRun, openRun } from "./runs.mjs";

const WT = "d:/bloom/bl-1-x";
const hook = (state, name, more = {}, at = 1000, session = "s1") =>
  applyHook(state, { session_id: session, cwd: "D:/bloom/BL-1-x", hook_event_name: name, ...more }, { worktree: WT, now: at });
const preflightTyped = (state, at = 1000, session = "s1") => {
  hook(state, "UserPromptExpansion", { command_name: "preflight" }, at, session);
  hook(state, "UserPromptSubmit", { prompt: "/preflight" }, at, session);
};

test("typing /preflight opens a run, without reading the prompt", () => {
  const s = emptyState();
  hook(s, "UserPromptExpansion", { command_name: "preflight" });
  assert.equal(openRun(s, WT).skill, "preflight");
  assert.equal(openRun(s, WT).state, "working");
});

test("the model calling the Skill tool opens a run, as when preflight is asked for in words", () => {
  const s = emptyState();
  hook(s, "UserPromptSubmit", { prompt: "please get this ready for review" });
  assert.equal(openRun(s, WT), null);
  hook(s, "PreToolUse", { tool_name: "Skill", tool_input: { skill: "preflight" } });
  assert.equal(openRun(s, WT).skill, "preflight");
});

test("a typed command and the Skill tool in one session are one run", () => {
  const s = emptyState();
  preflightTyped(s);
  hook(s, "PreToolUse", { tool_name: "Skill", tool_input: { skill: "preflight" } }, 2000);
  assert.equal(s.runs.length, 1);
});

test("a skill that is not one of Bloom's process skills opens nothing", () => {
  const s = emptyState();
  hook(s, "PreToolUse", { tool_name: "Skill", tool_input: { skill: "papercut" } });
  assert.equal(s.runs.length, 0);
});

test("a turn that ends with tasks in flight leaves preflight waiting; a new turn sets it working", () => {
  const s = emptyState();
  preflightTyped(s);
  hook(s, "Stop", { background_tasks: [{ type: "monitor", description: "poll CI" }], session_crons: [] }, 2000);
  assert.equal(openRun(s, WT).state, "waiting");
  assert.match(openRun(s, WT).cause, /poll CI/);
  hook(s, "UserPromptSubmit", { prompt: "(monitor woke the session)" }, 3000);
  assert.equal(openRun(s, WT).state, "working");
});

test("a turn that ends with nothing in flight and no end recorded pauses preflight", () => {
  const s = emptyState();
  preflightTyped(s);
  hook(s, "Stop", { background_tasks: [], session_crons: [] }, 2000);
  assert.equal(openRun(s, WT).state, "paused");
});

test("progress end finishes the run with the commit and tree it ended on", () => {
  const s = emptyState();
  preflightTyped(s);
  applyProgress(s, { worktree: WT, startedAt: new Date(1500).toISOString(), steps: { discover: { state: "done" } } }, { now: 1600 });
  assert.deepEqual(latestRun(s, WT, "preflight").phases, { discover: { state: "done" } });
  applyProgress(s, { worktree: WT, startedAt: new Date(1500).toISOString(), steps: {}, endedAt: new Date(5000).toISOString(), head: "abc", tree: "def" }, { now: 5000 });
  const run = latestRun(s, WT, "preflight");
  assert.equal(run.state, "finished");
  assert.deepEqual({ head: run.result.head, tree: run.result.tree }, { head: "abc", tree: "def" });
  assert.equal(s.runs.length, 1);
  // The Stop that follows the run's last message changes nothing.
  hook(s, "Stop", { background_tasks: [] }, 6000);
  assert.equal(latestRun(s, WT, "preflight").state, "finished");
});

test("a session that ends takes its unfinished run with it", () => {
  const s = emptyState();
  preflightTyped(s);
  hook(s, "SessionEnd", { reason: "exit" }, 2000);
  assert.equal(openRun(s, WT), null);
  assert.equal(latestRun(s, WT, "preflight").state, "ended");
});

test("a session whose process is gone ends its run, and a late progress end does not revive it", () => {
  const s = emptyState();
  applyHook(s, { session_id: "s1", cwd: WT, hook_event_name: "SessionStart" }, { worktree: WT, pid: 4242, now: 500 });
  preflightTyped(s);
  applyProgress(s, { worktree: WT, startedAt: new Date(1500).toISOString(), steps: {} }, { now: 1600 });
  assert.deepEqual(checkLiveness(s, () => true, { now: 2000 }), []);
  checkLiveness(s, pid => pid !== 4242, { now: 3000 });
  assert.equal(latestRun(s, WT, "preflight").state, "ended");
  assert.match(latestRun(s, WT, "preflight").cause, /process is gone/);
  applyProgress(s, { worktree: WT, startedAt: new Date(1500).toISOString(), steps: {}, endedAt: new Date(9000).toISOString(), head: "a", tree: "t" }, { now: 9000 });
  assert.equal(latestRun(s, WT, "preflight").state, "ended");
});

test("a session with no known process ends when Orca shows no agent in its worktree", () => {
  const s = emptyState();
  preflightTyped(s);
  checkLiveness(s, () => true, { agentWorktrees: new Set([WT]), now: 2000 });
  assert.equal(openRun(s, WT).state, "working");
  checkLiveness(s, () => true, { agentWorktrees: new Set(), now: 3000 });
  assert.equal(openRun(s, WT), null);
});

test("an interrupt that Orca reports pauses a working run", () => {
  const s = emptyState();
  preflightTyped(s);
  applyInterrupt(s, WT, { now: 2000 });
  assert.equal(openRun(s, WT).state, "paused");
  assert.equal(openRun(s, WT).cause, "you interrupted it");
});

test("an API failure pauses the run", () => {
  const s = emptyState();
  preflightTyped(s);
  hook(s, "StopFailure", { error_type: "overloaded" }, 2000);
  assert.equal(openRun(s, WT).state, "paused");
});

test("request-peer-review finishes when its turn ends, and closes a preflight left paused", () => {
  const s = emptyState();
  preflightTyped(s);
  hook(s, "Stop", { background_tasks: [] }, 2000);
  hook(s, "UserPromptExpansion", { command_name: "request-peer-review" }, 3000);
  assert.equal(latestRun(s, WT, "preflight").state, "ended");
  assert.equal(openRun(s, WT).skill, "request-peer-review");
  hook(s, "Stop", { background_tasks: [] }, 4000);
  assert.equal(openRun(s, WT), null);
  assert.equal(latestRun(s, WT, "request-peer-review").state, "finished");
});

test("the dashboard's comments prompt opens a process-pr-comments run", () => {
  const s = emptyState();
  hook(s, "UserPromptSubmit", { prompt: "Process the PR comments: read every unresolved discussion" });
  assert.equal(openRun(s, WT).skill, "process-pr-comments");
});

test("a progress record with no hook before it opens a run; one already ended arrives finished", () => {
  const s = emptyState();
  applyProgress(s, { worktree: WT, startedAt: new Date(1000).toISOString(), steps: {}, endedAt: new Date(2000).toISOString(), head: "a", tree: "t" }, { now: 5000 });
  assert.equal(latestRun(s, WT, "preflight").state, "finished");
  const other = "d:/bloom/bl-2-y";
  applyProgress(s, { worktree: other, startedAt: new Date(1000).toISOString(), steps: {} }, { now: 5000 });
  assert.equal(latestRun(s, other, "preflight").state, "paused");
  assert.equal(latestRun(s, other, "preflight").cause, "no session is running it");
});

test("a second preflight in the worktree is a new run, and the first keeps its result", () => {
  const s = emptyState();
  preflightTyped(s);
  applyProgress(s, { worktree: WT, startedAt: new Date(1500).toISOString(), steps: {}, endedAt: new Date(2000).toISOString(), head: "a", tree: "t1" }, { now: 2000 });
  preflightTyped(s, 10_000);
  assert.equal(s.runs.length, 2);
  assert.equal(openRun(s, WT).state, "working");
  assert.equal(s.runs[0].result.tree, "t1");
});
