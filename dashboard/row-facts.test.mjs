// Tests for row-facts.mjs, the rules that the dashboard server, the gather, progress.mjs and the
// Worktree panel's worker share. Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOf, checksState, countDecisions, norm, questionOf, REPORT_HOME as REPORT, reportDecisions, reportOf, reportReadable } from "./row-facts.mjs";

test("norm makes one key of the ways a worktree path is spelled", () => {
  assert.equal(norm("D:\\BL-1-x\\"), "d:/bl-1-x");
  assert.equal(norm("D:/BL-1-x/"), norm("d:/bl-1-x"));
  assert.equal(norm(undefined), "");
});

test("cardOf reads the card from the branch, then the path", () => {
  assert.equal(cardOf("refs/heads/JohnThomson/bl-123-fix", "D:/other"), "BL-123");
  assert.equal(cardOf("main", "D:/BL-456-thing"), "BL-456");
  assert.equal(cardOf("main", "D:/bloom"), null);
});

test("questionOf strips Orca's answer: prefix and ignores agents that are not waiting", () => {
  assert.equal(questionOf({ state: "waiting", programStatus: { kind: "question", message: "answer: Which one?" } }), "Which one?");
  assert.equal(questionOf({ state: "working", programStatus: { kind: "question", message: "x" } }), "");
});

test("checksState: a failure wins, then pending, and Reviewable's status is left out", () => {
  const run = (status, conclusion) => ({ __typename: "CheckRun", status, conclusion });
  assert.equal(checksState([run("COMPLETED", "SUCCESS"), run("COMPLETED", "FAILURE"), run("IN_PROGRESS", null)]), "FAILURE");
  assert.equal(checksState([run("COMPLETED", "SUCCESS"), run("QUEUED", null)]), "PENDING");
  assert.equal(checksState([run("COMPLETED", "SUCCESS"), { __typename: "StatusContext", context: "code-review/reviewable", state: "PENDING" }]), "SUCCESS");
  assert.equal(checksState([]), "");
});

test("reportOf finds the report link in a PR description, and countDecisions counts its Leave as is options", () => {
  assert.equal(reportOf("text\nPreflight report: [here](https://claude.ai/artifact/abc) more"), "https://claude.ai/artifact/abc");
  assert.equal(reportOf("no report"), null);
  assert.equal(countDecisions("<label>Fix it</label><label> Leave as is </label><p>x</p><label>Leave as is</label>"), 2);
});

// ---- the code since preflight --------------------------------------------------------------------

test("only a report that preflight published is fetched, and a redirect is not followed", async () => {
  assert.equal(reportReadable(REPORT + "deciders/x.html"), true);
  assert.equal(reportReadable("https://intranet.example/x"), false);
  assert.equal(reportReadable("https://bloombooks.github.io/other/x.html"), false);
  assert.equal(reportReadable(REPORT + "../../x"), false);
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, opts) => { asked.push([url, opts.redirect]); return new Response("<b>Leave as is</b>"); };
  try {
    assert.equal(await reportDecisions("https://10.0.0.1/admin"), null);
    assert.equal(await reportDecisions(REPORT + "deciders/x.html"), 1);
    assert.deepEqual(asked, [[REPORT + "deciders/x.html", "error"]]);
  } finally { globalThis.fetch = realFetch; }
});
