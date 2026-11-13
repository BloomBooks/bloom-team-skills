// Tests for row-facts.mjs, the rules that the dashboard server, the gather, progress.mjs and the
// Worktree panel's worker share. Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentEventLines, agentStates, cardOf, changeSincePreflight, checksState, codeChangedSincePreflight, countDecisions, enrichRows, liveAgents,
  nextFromFacts, norm, panelRow, questionOf, readRowFiles, REPORT_HOME as REPORT, reportDecisions, reportOf, reportReadable,
  rowOfWorktree, rowProblems, RUN_FRESH_MS, runShowing, skillOf,
} from "./row-facts.mjs";
import { COMMENTS_PROMPT } from "../orca-worktrees.mjs";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const ago = minutes => new Date(NOW - minutes * 60000).toISOString();
// A preflight run that reached Discover and has not recorded its end.
const openRun = minutesAgo => ({ worktree: "d:/bl-1-x", startedAt: ago(minutesAgo), updatedAt: ago(minutesAgo), steps: { discover: { state: "running" } } });
const endedRun = extra => ({ ...openRun(30), endedAt: ago(20), ...extra });

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

test("skillOf reads a slash command, also as Git Bash rewrites it", () => {
  assert.equal(skillOf({ prompt: "/preflight thorough" }), "preflight");
  assert.equal(skillOf({ prompt: "C:/Program Files/Git/request-peer-review" }), "request-peer-review");
  assert.equal(skillOf({ prompt: "fix the bug" }), "");
  assert.equal(skillOf(null), "");
});

test("questionOf strips Orca's answer: prefix and ignores agents that are not waiting", () => {
  assert.equal(questionOf({ state: "waiting", programStatus: { kind: "question", message: "answer: Which one?" } }), "Which one?");
  assert.equal(questionOf({ state: "working", programStatus: { kind: "question", message: "x" } }), "");
});

test("agent events: a change of state, a new worktree and a worktree that went away", () => {
  const before = new Map([["D:/a", { card: "BL-1", s: "working" }], ["D:/gone", { card: "BL-2", s: "done" }], ["D:/quiet", { card: "BL-3", s: "none" }]]);
  const after = new Map([["D:/a", { card: "BL-1", s: "waiting" }], ["D:/new", { card: "BL-4", s: "working" }]]);
  assert.deepEqual(agentEventLines(before, after), [
    "BL-1 D:/a: working -> waiting",
    "BL-4 D:/new: none -> working",
    "BL-2 D:/gone: done -> worktree gone",
  ]);
  assert.equal(agentStates([{ state: "working", workingMode: "monitoring" }, { state: "waiting" }]), "done+waiting");
  assert.equal(agentStates([]), "none");
});

// ---- the preflight run -------------------------------------------------------------------------

test("a run with no end shows for RUN_FRESH_MS after it last wrote, then goes stale", () => {
  assert.equal(runShowing(openRun(10), null, NOW), true);
  assert.equal(runShowing(openRun(RUN_FRESH_MS / 60000 + 1), null, NOW), false);
});

test("an ended run, or none, never shows", () => {
  assert.equal(runShowing(endedRun(), null, NOW), false);
  assert.equal(runShowing(null, null, NOW), false);
  assert.equal(runShowing({ startedAt: ago(1) }, null, NOW), false);
});

test("a working agent keeps a stale run showing, unless it is a review-request agent that started after the run's last write", () => {
  const stale = openRun(14 * 60);
  assert.equal(runShowing(stale, { skill: "preflight", since: NOW - 60000 }, NOW), true);
  assert.equal(runShowing(stale, { skill: "youtrack-fix", since: NOW - 60000 }, NOW), true);
  assert.equal(runShowing(stale, { skill: "request-peer-review", since: NOW - 60000 }, NOW), false);
  assert.equal(runShowing(stale, { skill: "merge-without-peer-review", since: NOW - 60000 }, NOW), false);
  // request-peer-review handed the work back to preflight, which wrote after it started.
  assert.equal(runShowing(openRun(1), { skill: "request-peer-review", since: NOW - 10 * 60000 }, NOW), true);
});

// ---- liveAgents ---------------------------------------------------------------------------------

const worktree = (...agents) => ({ path: "D:/BL-1-x", agents });
const agent = (prompt, extra) => ({ paneKey: "t:1", prompt, state: "working", ...extra });

test("an agent on request-peer-review keeps its skill when an older preflight run never ended", () => {
  const seen = new Map([["d:/bl-1-x", { id: "t:1|/request-peer-review", since: NOW - 60000 }]]);
  const live = liveAgents(worktree(agent("/request-peer-review")), openRun(14 * 60), seen, NOW);
  assert.equal(live.skill, "request-peer-review");
  assert.equal(live.runShowing, false);
});

test("any agent working while a run is recording counts as preflight", () => {
  const live = liveAgents(worktree(agent("make it so")), openRun(2), new Map(), NOW);
  assert.equal(live.skill, "preflight");
  assert.equal(live.runShowing, true);
});

test("a preflight agent waiting on its Monitor counts as working until the run ends", () => {
  const monitoring = agent("/preflight", { workingMode: "monitoring" });
  const going = liveAgents(worktree(monitoring), openRun(5), new Map(), NOW);
  assert.equal(going.working, true);
  assert.equal(going.tool, "Waiting on reviewers and CI");
  assert.equal(liveAgents(worktree(monitoring), endedRun(), new Map(), NOW).working, false);
});

test("liveAgents keeps the time it first saw an agent on a prompt, and starts again on a new one", () => {
  const seen = new Map();
  assert.equal(liveAgents(worktree(agent("/preflight")), null, seen, NOW).since, NOW);
  assert.equal(liveAgents(worktree(agent("/preflight")), null, seen, NOW + 5000).since, NOW);
  assert.equal(liveAgents(worktree(agent("again")), null, seen, NOW + 9000).since, NOW + 9000);
  assert.equal(liveAgents(worktree(), null, seen, NOW + 9000).since, 0);
  assert.equal(seen.size, 0);
});

test("a waiting agent's question reaches the page", () => {
  const live = liveAgents(worktree({ state: "waiting", programStatus: { kind: "question", message: "answer: A or B?" } }), null, new Map(), NOW);
  assert.deepEqual([live.waiting, live.working, live.question], [true, false, "A or B?"]);
});

// ---- GitHub -------------------------------------------------------------------------------------

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

test("a squash that keeps the tree leaves preflight done; a change to the content does not", () => {
  const run = endedRun({ head: "aaa", tree: "t1" });
  assert.equal(codeChangedSincePreflight(run, { head: "bbb", tree: "t1", uncommitted: 0 }), false);
  assert.equal(codeChangedSincePreflight(run, { head: "bbb", tree: "t2", uncommitted: 0 }), true);
  assert.equal(codeChangedSincePreflight(run, { head: "aaa", tree: "t1", uncommitted: 2 }), true);
});

test("a run recorded without its tree compares the commit, and one without either compares times", () => {
  assert.equal(codeChangedSincePreflight(endedRun({ head: "aaa" }), { head: "bbb", tree: "t1", uncommitted: 0 }), true);
  assert.equal(codeChangedSincePreflight(endedRun(), { head: "x", headTime: ago(30), uncommitted: 0 }), false);
  assert.equal(codeChangedSincePreflight(endedRun(), { head: "x", headTime: ago(5), uncommitted: 0 }), true);
});

test("the code never counts as changed while a run is going or with nothing to compare", () => {
  assert.equal(codeChangedSincePreflight(openRun(1), { head: "x", uncommitted: 3 }), false);
  assert.equal(codeChangedSincePreflight(endedRun({ head: "a" }), null), false);
});

test("changeSincePreflight counts the commits and names uncommitted changes", () => {
  const run = endedRun({ head: "aaa", tree: "t1" });
  const why = checkout => changeSincePreflight(run, { head: "bbb", tree: "t2", uncommitted: 0, ...checkout });
  assert.equal(why({ commitsSince: 1 }), "1 commit since preflight");
  assert.equal(why({ commitsSince: 3, uncommitted: 2 }), "3 commits and uncommitted changes since preflight");
  assert.equal(why({ commitsSince: null }), "code changed since preflight");
  assert.equal(why({ tree: "t1", commitsSince: 1, uncommitted: 2 }), "uncommitted changes since preflight", "a squash that kept the tree is no commit");
  assert.equal(why({ tree: "t1", commitsSince: 1 }), "");
});

test("the prompt of the Process PR Comments button counts as the skill process-pr-comments", () => {
  assert.equal(skillOf({ prompt: COMMENTS_PROMPT }), "process-pr-comments");
  assert.equal(skillOf({ prompt: "Process the report" }), "");
});

test("enrichRows adds the comments waiting on the PR and how the code changed", () => {
  const rows = [{ card: "BL-1", worktree: "D:/BL-1-x", pr: pr.url }];
  const runs = new Map([["d:/bl-1-x", endedRun({ head: "aaa", tree: "t1" })]]);
  const checkouts = new Map([["d:/bl-1-x", { head: "bbb", tree: "t2", uncommitted: 0, commitsSince: 2 }]]);
  const waiting = { total: 1, from: [{ who: "you", you: true, count: 1 }] };
  const [r] = enrichRows(rows, null, new Map(), runs, checkouts, NOW, new Map([[pr.url, waiting]]));
  assert.equal(r.prComments, waiting);
  assert.equal(r.codeChangedWhy, "2 commits since preflight");
});

// ---- the rows the session writes -----------------------------------------------------------------

const goodRow = { card: "BL-1", group: "near", who: "idle", nextSkill: "preflight", pr: "https://github.com/BloomBooks/BloomDesktop/pull/8551", worktree: "D:/BL-1-x" };

test("a row as SKILL.md describes it has no problems", () => {
  assert.deepEqual(rowProblems(goodRow), []);
});

test("rowProblems names what would make a row draw wrong or not at all", () => {
  assert.match(rowProblems({ ...goodRow, group: "nearly" }).join(), /in no table/);
  assert.match(rowProblems({ ...goodRow, who: "agent" }).join(), /who "agent"/);
  assert.match(rowProblems({ ...goodRow, nextSkill: "merge-without-peer-review" }).join(), /nextSkill/);
  assert.match(rowProblems({ ...goodRow, pr: "8551" }).join(), /not a GitHub PR URL/);
  assert.match(rowProblems({ ...goodRow, codeChanged: true }).join(), /works out itself/);
  assert.deepEqual(rowProblems([1]), ["is not a JSON object"]);
});

test("readRowFiles reports a file that is not JSON and keeps the rows that are, read past a byte-order mark", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rows-test-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const dir = path.join(home, ".claude", "bloom-dashboard", "rows");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "BL-1.json"), "\uFEFF" + JSON.stringify(goodRow));
    fs.writeFileSync(path.join(dir, "BL-2.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "BL-3.json"), JSON.stringify({ ...goodRow, card: "BL-3", group: "later" }));
    const { rows, problems } = readRowFiles();
    assert.deepEqual(rows.map(r => r.card).sort(), ["BL-1", "BL-3"]);
    assert.ok(rows.every(r => r.updated));
    assert.deepEqual(problems.map(p => p.card), ["BL-2", "BL-3"]);
    assert.match(problems[0].problem, /not valid JSON/);
  } finally {
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("rowOfWorktree matches by path however it is spelled, then by the branch's card", () => {
  const rows = [{ card: "BL-9", worktree: "D:\\BL-1-x\\" }, { card: "BL-2" }];
  assert.equal(rowOfWorktree(rows, "d:/bl-1-x", "BL-1").card, "BL-9");
  assert.equal(rowOfWorktree(rows, "D:/BL-2-y", "BL-2").card, "BL-2");
  assert.equal(rowOfWorktree(rows, "D:/BL-3-z", "BL-3"), null);
});

// ---- the panel's own row --------------------------------------------------------------------------

const pr = { url: "https://github.com/BloomBooks/BloomDesktop/pull/101", report: "https://claude.ai/r", reportDecisions: 0 };
const unchanged = { head: "aaa", tree: "t1", uncommitted: 0 };

test("a clean ended run with the code unchanged makes request-peer-review next", () => {
  assert.equal(nextFromFacts(pr, endedRun({ head: "aaa", tree: "t1" }), unchanged).nextSkill, "request-peer-review");
});

test("a run that ended with a failed step leaves preflight next", () => {
  const failed = endedRun({ head: "aaa", tree: "t1", steps: { local: { state: "failed" } } });
  assert.equal(nextFromFacts(pr, failed, unchanged).nextSkill, "preflight");
});

test("a report that lists decisions waits on the developer", () => {
  const n = nextFromFacts({ ...pr, reportDecisions: 2 }, endedRun({ head: "aaa", tree: "t1" }), unchanged);
  assert.equal(n.who, "you");
  assert.equal(n.nextSkill, "preflight");
  assert.match(n.next, /2 decisions/);
});

test("no PR means no next skill", () => {
  assert.equal(nextFromFacts(null, null, null).nextSkill, null);
});

test("the panel keeps the session's row while its PR is the live one", () => {
  const row = { card: "BL-1", status: "Waiting on CI", pr: pr.url, nextSkill: "request-peer-review", who: "idle" };
  const d = panelRow({ row, cardId: "BL-1", pr, run: null, checkout: null, worktree: "D:/BL-1-x" });
  assert.equal(d.nextSkill, "request-peer-review");
  assert.equal(d.worktree, "D:/BL-1-x");
});

test("the panel takes a replaced PR's link, report and next step from the live PR", () => {
  const row = { card: "BL-1", status: "PR 100 waits", pr: "https://github.com/BloomBooks/BloomDesktop/pull/100", report: "https://old", nextSkill: "request-peer-review", who: "you", next: "Pick A or B" };
  const d = panelRow({ row, cardId: "BL-1", pr, run: null, checkout: null, worktree: "D:/BL-1-x" });
  assert.equal(d.pr, pr.url);
  assert.equal(d.report, pr.report);
  assert.equal(d.nextSkill, "preflight");
  assert.equal(d.who, "idle");
  assert.equal(d.next, undefined);
  assert.equal(d.status, "PR 100 waits");
});

// ---- enrichRows -----------------------------------------------------------------------------------

test("enrichRows finds the run and checkout of a row whose path has a trailing slash", () => {
  const rows = [{ card: "BL-1", worktree: "D:\\BL-1-x\\", nextSkill: "request-peer-review", pr: pr.url }];
  const runs = new Map([["d:/bl-1-x", endedRun({ head: "aaa", tree: "t1" })]]);
  const checkouts = new Map([["d:/bl-1-x", { head: "bbb", tree: "t2", uncommitted: 0 }]]);
  const facts = { prs: [{ url: pr.url, isDraft: true, mergeable: "MERGEABLE", checks: "SUCCESS" }], cards: [{ id: "BL-1", approvedPlan: true }] };
  const [r] = enrichRows(rows, facts, new Map(), runs, checkouts, NOW);
  assert.equal(r.codeChanged, true);
  assert.equal(r.prState, "draft");
  assert.equal(r.approvedPlan, true);
  assert.equal(r.runShowing, false);
});

test("enrichRows takes a newer preflight report from the facts over the one in the session's row", () => {
  const url = "https://github.com/BloomBooks/BloomDesktop/pull/7";
  const row = extra => [{ card: "BL-7", pr: url, report: REPORT + "old.html", reportDecisions: 0, ...extra }];
  const facts = report => ({ prs: [{ url, isDraft: false, ...report }] });
  const [newer] = enrichRows(row(), facts({ report: REPORT + "new.html", reportDecisions: 2 }), new Map(), new Map(), new Map(), NOW);
  assert.deepEqual([newer.report, newer.reportDecisions], [REPORT + "new.html", 2]);
  const [same] = enrichRows(row(), facts({ report: REPORT + "old.html", reportDecisions: 1 }), new Map(), new Map(), new Map(), NOW);
  assert.equal(same.reportDecisions, 1);
  const [none] = enrichRows(row(), facts({ report: null }), new Map(), new Map(), new Map(), NOW);
  assert.equal(none.report, REPORT + "old.html");
});

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

test("enrichRows shows a fresh run with no agent, and not a stale one", () => {
  const rows = () => [{ card: "BL-1", worktree: "D:/BL-1-x" }];
  assert.equal(enrichRows(rows(), null, new Map(), new Map([["d:/bl-1-x", openRun(5)]]), new Map(), NOW)[0].runShowing, true);
  assert.equal(enrichRows(rows(), null, new Map(), new Map([["d:/bl-1-x", openRun(60)]]), new Map(), NOW)[0].runShowing, false);
});
