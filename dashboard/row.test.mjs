// Tests for row.js: how it merges Orca's live agents into a row, and the Process column's rules.
// Run: node --test "dashboard/**/*.test.mjs"
// row.js is a browser script that defines only constants and functions when it loads, so it runs
// here in a vm context with no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DASHBOARD_SKILLS, NEXT_SKILLS, RUN_STEPS as PROGRESS_STEPS } from "./row-facts.mjs";

const source = fs.readFileSync(new URL("./row.js", import.meta.url), "utf8");
const load = () => vm.runInNewContext(source + "\n;({ withLiveAgents, processModel, launched, normPath, SKILL_BUTTON, SKILL_STATUS, RUN_STEPS })", {});
const row = load();

const NOW = Date.parse("2026-11-10T12:00:00Z");
const wt = "D:/BL-1-x";
const merge = (d, live, r = row) => r.withLiveAgents([{ worktree: wt, ...d }], live ? { [r.normPath(wt)]: live } : {}, NOW)[0];

// ---- withLiveAgents --------------------------------------------------------------------------

test("a waiting agent makes the row ask the developer", () => {
  const d = merge({ who: "idle" }, { waiting: true, question: "A or B?" });
  assert.equal(d.who, "asking");
  assert.equal(d.question, "A or B?");
});

test("a working agent takes the skill and the run's showing from the server", () => {
  const d = merge({ who: "you" }, { working: true, skill: "preflight", since: NOW - 60000, tool: "", runShowing: true });
  assert.equal(d.who, "agent");
  assert.equal(d.skill, "preflight");
  assert.equal(d.runShowing, true);
});

test("an idle row with no live agent is left as the session wrote it", () => {
  const d = { worktree: wt, who: "idle", runShowing: true };
  assert.equal(row.withLiveAgents([d], {}, NOW)[0], d);
});

test("a row's worktree path is matched however it is spelled", () => {
  const d = row.withLiveAgents([{ worktree: "D:\\BL-1-x\\" }], { "d:/bl-1-x": { working: true, skill: "" } }, NOW)[0];
  assert.equal(d.who, "agent");
});

test("a clicked skill button shows as that skill for a minute, until Orca reports the agent", () => {
  const r = load();
  r.launched.set(r.normPath(wt), { skill: "preflight", at: NOW - 10000 });
  assert.equal(merge({}, null, r).skill, "preflight");
  assert.equal(merge({}, { working: true, skill: "preflight", since: NOW }, r).who, "agent");
  assert.equal(r.launched.size, 0, "Orca reporting the agent ends the launch");
  r.launched.set(r.normPath(wt), { skill: "preflight", at: NOW - 61000 });
  assert.notEqual(merge({ who: "idle" }, null, r).who, "agent");
});

// ---- processModel ----------------------------------------------------------------------------

const pr = "https://github.com/BloomBooks/BloomDesktop/pull/1";
const model = d => row.processModel({ worktree: wt, who: "idle", ...d });
const review = (files, reviewed) => ({ files, reviewed, left: [] });

test("with no PR and no next skill, Code is next", () => {
  const m = model({});
  assert.equal(m.now, 0);
  assert.deepEqual([...m.states], ["now", "later", "later", "later", "later"]);
});

test("with preflight next, Preflight is next", () => {
  assert.equal(model({ pr, nextSkill: "preflight" }).now, 1);
});

test("after preflight, the developer's review is next until every file is reviewed", () => {
  assert.equal(model({ pr, nextSkill: "request-peer-review", ownReview: review(5, 2) }).now, 2);
  assert.equal(model({ pr, nextSkill: "request-peer-review", ownReview: review(5, 2) }).left, 3);
  assert.equal(model({ pr, nextSkill: "request-peer-review", ownReview: review(5, 5) }).now, 3);
});

test("when the review cannot be read, the review and Request Peer Review are offered together", () => {
  const m = model({ pr, nextSkill: "request-peer-review" });
  assert.equal(m.reviewUnknown, true);
  assert.deepEqual([...m.states], ["done", "done", "now", "now", "later"]);
});

test("a conflict, failing CI or code changed since the run sends the row back to Preflight", () => {
  for (const d of [{ prMergeable: "CONFLICTING" }, { prChecks: "FAILURE" }, { codeChanged: true }]) {
    const m = model({ pr, nextSkill: "request-peer-review", ownReview: review(1, 1), ...d });
    assert.equal(m.now, 1, JSON.stringify(d));
  }
  assert.equal(model({ pr, nextSkill: "request-peer-review", prChecks: "FAILURE" }).broken, true);
});

test("a working agent shows on its skill's step and disables every step", () => {
  const working = skill => model({ pr, nextSkill: "preflight", who: "agent", skill });
  assert.equal(working("preflight").running, 1);
  assert.equal(working("request-peer-review").running, 3);
  assert.equal(working("merge-without-peer-review").running, 3);
  assert.equal(working("youtrack-fix").running, 0);
  assert.equal(working("preflight").states[1], "running");
  assert.equal(working("preflight").enabled, false);
});

test("a decision or a question for the developer blocks the steps", () => {
  for (const who of ["you", "asking"]) {
    const m = model({ pr, nextSkill: "preflight", who });
    assert.equal(m.blocked, true);
    assert.equal(m.enabled, false);
  }
});

test("a card back with comments marks the peer review", () => {
  assert.equal(model({ pr, nextSkill: "preflight", ytState: "Has Comments" }).states[4], "comments");
});

test("a card in Ready For Code Review is at the peer review, whatever the row's next skill says", () => {
  const m = model({ pr, nextSkill: "request-peer-review", ownReview: review(5, 2), codeChanged: true, ytState: "Ready For Code Review" });
  assert.equal(m.now, 4);
  assert.deepEqual([...m.states], ["done", "done", "done", "done", "now"]);
});

test("the report is the old one while Preflight is next, unless it lists decisions", () => {
  assert.equal(model({ pr, nextSkill: "preflight", report: "r" }).oldReport, true);
  assert.equal(model({ pr, nextSkill: "preflight", report: "r", reportDecisions: 2 }).oldReport, false);
  assert.equal(model({ pr, nextSkill: "request-peer-review", report: "r" }).oldReport, false);
});

test("the running time is the run's own start while it shows, else when the agent was first seen", () => {
  const progress = { startedAt: new Date(NOW - 20 * 60000).toISOString() };
  assert.equal(model({ who: "agent", skill: "preflight", since: NOW - 60000, runShowing: true, progress }).since, NOW - 20 * 60000);
  assert.equal(model({ who: "agent", skill: "preflight", since: NOW - 60000, runShowing: false, progress }).since, NOW - 60000);
});

// ---- Process PR Comments and the line under Preflight ----------------------------------------

const waiting = (...from) => ({ total: from.reduce((n, f) => n + f.count, 0), from });
const you = count => ({ who: "you", you: true, count });

test("a row with no comments waiting has no Process PR Comments step", () => {
  assert.equal(model({ pr, nextSkill: "request-peer-review", ownReview: review(1, 1) }).comments, null);
  assert.equal(model({ pr, nextSkill: "request-peer-review", prComments: waiting() }).comments, null);
});

test("comments waiting are the step offered, ahead of Preflight and Request Peer Review", () => {
  const changed = model({ pr, nextSkill: "request-peer-review", codeChanged: true, prComments: waiting(you(3)) });
  assert.deepEqual({ ...changed.comments }, { state: "now", text: "3 comments from you" });
  assert.deepEqual([...changed.states], ["done", "later", "later", "later", "later"]);
  const reviewed = model({ pr, nextSkill: "request-peer-review", ownReview: review(2, 2), prComments: waiting(you(1)) });
  assert.equal(reviewed.comments.text, "1 comment from you");
  assert.deepEqual([...reviewed.states], ["done", "done", "done", "later", "later"]);
});

test("the developer's unfinished review stays offered beside the comments", () => {
  const m = model({ pr, nextSkill: "request-peer-review", ownReview: review(5, 2), prComments: waiting(you(2)) });
  assert.deepEqual([...m.states], ["done", "done", "now", "later", "later"]);
  assert.equal(m.comments.state, "now");
});

test("comments from several people are counted by who wrote them", () => {
  const m = model({ pr, nextSkill: "request-peer-review", prComments: waiting(you(3), { who: "Andrew Polk", you: false, count: 1 }) });
  assert.equal(m.comments.text, "3 comments from you, 1 from Andrew Polk");
});

test("an agent processing the comments shows on that step", () => {
  const m = model({ pr, nextSkill: "request-peer-review", who: "agent", skill: "process-pr-comments" });
  assert.equal(m.comments.state, "running");
  assert.ok(![...m.states].includes("running"));
});

test("the line under Preflight says why it is the next step", () => {
  const next = d => model({ pr, nextSkill: "request-peer-review", ...d }).why;
  assert.equal(next({ codeChanged: true, codeChangedWhy: "1 commit since preflight" }), "1 commit since preflight");
  assert.equal(next({ prMergeable: "CONFLICTING" }), "PR conflicts with its base branch");
  assert.equal(next({ prChecks: "FAILURE", codeChanged: true, codeChangedWhy: "2 commits since preflight" }), "CI is failing; 2 commits since preflight");
  assert.equal(next({ ownReview: review(1, 1) }), "");
  assert.equal(model({ pr, nextSkill: "preflight" }).why, "");
});

// ---- the lists row.js shares with the server -------------------------------------------------

test("row.js has a button and a status for every skill the server runs", () => {
  assert.deepEqual(Object.keys(row.SKILL_BUTTON).sort(), [...DASHBOARD_SKILLS].sort());
  assert.deepEqual(Object.keys(row.SKILL_STATUS).sort(), [...DASHBOARD_SKILLS].sort());
  for (const s of NEXT_SKILLS) assert.ok(row.SKILL_BUTTON[s], s);
});

test("row.js draws every step progress.mjs records, apart from ci", () => {
  const drawn = row.RUN_STEPS.flatMap(([id, , , parts]) => parts ? parts.map(([k]) => k) : [id]);
  assert.deepEqual([...drawn].sort(), PROGRESS_STEPS.filter(s => s !== "ci").sort());
});
