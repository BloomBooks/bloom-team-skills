import test from "node:test";
import assert from "node:assert/strict";
import { allowAction, codeSince, computeRow, groupOf, prRowTitle, prSets, stateOf, wantsRow } from "./rows.mjs";

const card = { id: "BL-1", url: "u", summary: "A card", state: "In Progress", approvedPlan: false, updated: "2026-11-01" };
const pr = { url: "https://github.com/BloomBooks/BloomDesktop/pull/9", isDraft: true, mergeable: "MERGEABLE", checks: "SUCCESS", changedFiles: 3, additions: 10, deletions: 2, report: "https://bloombooks.github.io/dev-process-artifacts/r.html", reportDecisions: 0 };
const worktree = { path: "D:/bloom/BL-1-x", branch: "BL-1-x" };
const git = { head: "h1", tree: "t1", uncommitted: 0, untracked: 0, ahead: 2, behind: 0, base: "master", commitsSince: 0 };
const finished = { skill: "preflight", state: "finished", cause: "", signals: ["typed /preflight"], startedAt: 1, phases: {}, result: { head: "h1", tree: "t1" } };
const reviewed = { files: 3, reviewed: 3, left: [], reviewable: true };
const activity = { working: false, asking: false, orcaOk: true };
const base = { card, pr, worktree, git, preflight: finished, open: null, review: reviewed, comments: { total: 0, from: [] }, activity };
const stateWith = more => stateOf({ ...base, ...more }).state;
const step = (row, id) => row.steps.find(s => s.id === id);

test("with everything done, Request Peer Review is the step on offer", () => {
  const row = computeRow(base);
  assert.equal(row.state, "handoff-ready");
  assert.deepEqual(row.steps.map(s => s.state), ["done", "done", "done", "now", "later"]);
  assert.deepEqual(step(row, "request").buttons.map(b => [b.id, b.enabled]), [["request-peer-review", true]]);
});

test("a card with the Approved Plan tag also offers Merge without Peer Review", () => {
  const row = computeRow({ ...base, card: { ...card, approvedPlan: true } });
  assert.deepEqual(step(row, "request").buttons.map(b => b.id), ["request-peer-review", "merge-without-peer-review"]);
});

test("a commit after preflight makes Preflight the step again, and says why", () => {
  const row = computeRow({ ...base, git: { ...git, head: "h2", tree: "t2", commitsSince: 1 } });
  assert.equal(row.state, "preflight-needed");
  assert.equal(step(row, "preflight").note, "1 commit since preflight");
  assert.equal(step(row, "preflight").buttons[0].enabled, true);
  assert.equal(row.report.old, true);
});

test("the Preflight step carries the commits that its note counts", () => {
  const list = [{ sha: "h3", subject: "Second", body: "", url: null }, { sha: "h2", subject: "First", body: "Why", url: "https://github.com/o/r/commit/h2" }];
  const row = computeRow({ ...base, git: { ...git, head: "h3", tree: "t3", commitsSince: 2, commitsSinceList: list } });
  assert.deepEqual(step(row, "preflight").commits, { text: "2 commits", list });
  const uncommittedOnly = computeRow({ ...base, git: { ...git, uncommitted: 1, commitsSinceList: [] } });
  assert.equal(step(uncommittedOnly, "preflight").commits, null);
});

test("a squash that keeps the tree leaves preflight valid; untracked files do not count", () => {
  assert.equal(stateWith({ git: { ...git, head: "squashed", untracked: 4 } }), "handoff-ready");
});

test("an uncommitted change to a tracked file makes preflight stale", () => {
  assert.deepEqual(codeSince(finished, { ...git, uncommitted: 2 }), { changed: true, why: "uncommitted changes since preflight" });
  assert.equal(codeSince(finished, { ...git, head: "h2", tree: "t2", commitsSince: 3, uncommitted: 1 }).why, "3 commits and uncommitted changes since preflight");
});

test("a conflicting PR or failing CI sends the card back to Preflight", () => {
  assert.deepEqual(stateOf({ ...base, pr: { ...pr, mergeable: "CONFLICTING" } }).reasons, ["PR conflicts with its base branch"]);
  assert.deepEqual(stateOf({ ...base, pr: { ...pr, checks: "FAILURE" } }).reasons, ["CI is failing"]);
});

test("git that cannot be read is said to be unknown, never taken as unchanged", () => {
  const s = stateOf({ ...base, git: null });
  assert.equal(s.state, "preflight-needed");
  assert.match(s.reasons[0], /cannot tell/);
});

test("files left to review make Your review the step; a review that cannot be read offers the hand-off too", () => {
  const row = computeRow({ ...base, review: { files: 3, reviewed: 1, left: ["a", "b"], reviewable: true } });
  assert.equal(row.state, "review");
  assert.equal(step(row, "review").label, "Your review (2 of 3 files left)");
  assert.equal(step(row, "request").state, "later");
  const unknown = computeRow({ ...base, review: null });
  assert.equal(unknown.state, "review");
  assert.equal(step(unknown, "request").state, "now");
});

test("a report with decisions shows Needs your decision and disables the steps", () => {
  const row = computeRow({ ...base, pr: { ...pr, reportDecisions: 2 } });
  assert.equal(row.state, "decision");
  assert.deepEqual({ kind: row.badge.kind, url: row.badge.url }, { kind: "you", url: pr.report });
  assert.equal(row.report.decisions, 2);
  assert.equal(row.steps.flatMap(s => s.buttons || []).some(b => b.enabled), false);
});

test("decisions in a report from before the latest commit do not block: Preflight is next", () => {
  assert.equal(stateWith({ pr: { ...pr, reportDecisions: 2 }, git: { ...git, tree: "t2", head: "h2", commitsSince: 1 } }), "preflight-needed");
});

test("comments waiting on the PR come before preflight and the hand-off; the review stays offered", () => {
  const comments = { total: 4, from: [{ who: "you", you: true, count: 3 }, { who: "Andrew Polk", you: false, count: 1 }] };
  const row = computeRow({ ...base, comments, review: { files: 3, reviewed: 1, left: ["a", "b"], reviewable: true } });
  assert.equal(row.state, "comments");
  assert.equal(step(row, "comments").note, "3 comments from you, 1 from Andrew Polk");
  assert.equal(step(row, "comments").buttons[0].enabled, true);
  assert.equal(step(row, "review").state, "now");
  assert.equal(step(row, "request").state, "later");
});

test("a running preflight shows on its step with the run's start, and only showing the worktree stays enabled", () => {
  const open = { skill: "preflight", state: "waiting", cause: "monitor: poll CI", signals: ["typed /preflight"], startedAt: 5000, phases: { devin: { state: "running" } } };
  const row = computeRow({ ...base, preflight: open, open });
  assert.equal(row.state, "preflight-running");
  assert.deepEqual({ state: step(row, "preflight").state, since: step(row, "preflight").since, note: step(row, "preflight").runningNote }, { state: "running", since: 5000, note: "Waiting on reviewers and CI" });
  assert.deepEqual(row.run.phases, { devin: { state: "running" } });
  assert.deepEqual([row.actions.open.enabled, row.actions.vscode.enabled, row.actions.create.enabled], [true, true, false]);
});

test("a preflight that paused or died is the step to run again, with the cause", () => {
  const died = { ...finished, state: "ended", cause: "the session's process is gone", result: null };
  const row = computeRow({ ...base, preflight: died });
  assert.equal(row.state, "preflight-stopped");
  assert.match(step(row, "preflight").note, /process is gone/);
  assert.equal(step(row, "preflight").buttons[0].enabled, true);
});

test("an agent doing something else shows on Code and disables the steps", () => {
  const row = computeRow({ ...base, activity: { working: true, asking: false, orcaOk: true, since: 77 } });
  assert.equal(step(row, "code").state, "running");
  assert.equal(step(row, "code").since, 77);
  assert.equal(step(row, "request").buttons[0].enabled, false);
});

test("a question in the terminal shows above the steps and disables them", () => {
  const row = computeRow({ ...base, activity: { working: false, asking: true, question: "Which base?", orcaOk: true } });
  assert.deepEqual({ kind: row.badge.kind, question: row.question }, { kind: "asking", question: "Which base?" });
  assert.equal(step(row, "request").buttons[0].enabled, false);
  // The badge and the Orca button open the terminal where the question waits.
  assert.equal(row.actions.open.enabled, true);
});

test("a read of the review or the comments that failed shows on the row, with the time of the last good read", () => {
  const row = computeRow({ ...base, ages: { review: 1000, comments: 2000 }, failing: { review: "GitHub could not be read", comments: "Reviewable could not be read" } });
  assert.deepEqual(row.unknown, [
    { source: "your review", error: "GitHub could not be read", since: 1000 },
    { source: "the PR's comments", error: "Reviewable could not be read", since: 2000 },
  ]);
});

test("a decider form that a session waits on is the decision to answer", () => {
  const row = computeRow({ ...base, deciders: [{ url: "http://127.0.0.1:47600/decide/abc", name: "f", topic: "t" }] });
  assert.equal(row.badge.url, "http://127.0.0.1:47600/decide/abc");
});

test("a card with no PR and no run is on Code, and Preflight is offered once the worktree holds work", () => {
  const fresh = { ...base, pr: null, preflight: null, review: null, comments: null };
  const empty = computeRow({ ...fresh, git: { ...git, ahead: 0 } });
  assert.equal(empty.state, "code");
  assert.equal(step(empty, "preflight").state, "later");
  const worked = computeRow(fresh);
  assert.equal(step(worked, "code").buttons[0].id, "open");
  assert.equal(step(worked, "preflight").buttons[0].enabled, true);
});

test("a card with no worktree offers to create one", () => {
  const row = computeRow({ ...base, pr: null, worktree: null, git: null, preflight: null, review: null, comments: null });
  assert.equal(row.state, "no-worktree");
  assert.deepEqual([step(row, "code").buttons[0].id, step(row, "code").buttons[0].enabled], ["create", true]);
});

test("a card in Ready For Code Review is in peer review, and can still have comments to process", () => {
  const row = computeRow({ ...base, card: { ...card, state: "Ready For Code Review" }, comments: { total: 1, from: [{ who: "Andrew Polk", you: false, count: 1 }] } });
  assert.equal(row.state, "peer-review");
  assert.equal(row.comments.button.enabled, true);
});

test("Has Comments leaves the peer review step as it is on any card", () => {
  const s = step(computeRow({ ...base, card: { ...card, state: "Has Comments" } }), "peer");
  assert.deepEqual([s.label, s.state], ["Peer review", "later"]);
});

test("the rule that enables a button is the rule that allows the action", () => {
  const ref = { state: "handoff-ready", worktree: "D:/x", card: "BL-1", offered: ["request-peer-review"] };
  assert.deepEqual(allowAction("request-peer-review", ref, activity), { ok: true });
  assert.match(allowAction("request-peer-review", ref, { ...activity, working: true }).reason, /working/);
  assert.match(allowAction("request-peer-review", ref, { ...activity, asking: true }).reason, /question/);
  assert.match(allowAction("preflight", ref, activity).reason, /not the next step/);
  assert.match(allowAction("open", ref, { ...activity, orcaOk: false }).reason, /Orca is not answering/);
  assert.deepEqual(allowAction("vscode", ref, { ...activity, orcaOk: false }), { ok: true });
});

test("a button whose run never began is reported, not left spinning", () => {
  const row = computeRow({ ...base, launch: { skill: "request-peer-review", at: 1000, failed: true } }, 60_000);
  assert.match(row.failed, /did not start it/);
  assert.equal(step(row, "request").state, "now");
});

test("groups: no PR, a large PR, a card left untouched with nothing, and the rest", () => {
  assert.equal(groupOf({ card, pr: null, worktree }), "nopr");
  assert.equal(groupOf({ card, pr: { ...pr, changedFiles: 31 }, worktree }), "large");
  assert.equal(groupOf({ card, pr, worktree }), "near");
  assert.equal(groupOf({ card: { ...card, updated: "2025-01-01" }, pr: null, worktree: null }, Date.parse("2026-11-13")), "cleanup");
});

test("the row explains itself: the rule that matched and each fact with its source", () => {
  const row = computeRow({ ...base, ages: { github: 5, git: 6 }, failing: { reviewable: "timeout" } });
  assert.match(row.why[0].text, /^handoff-ready: /);
  assert.deepEqual(row.why.find(w => w.label === "PR").source, "GitHub");
  assert.deepEqual(row.unknown, [{ source: "reviewable", error: "timeout", since: 0 }]);
});

test("a card assigned to someone else gets a row only while the developer has work on it", () => {
  const theirs = { ...card, assignedToDeveloper: false };
  const clean = { ...git, ahead: 0, uncommitted: 0, untracked: 1 };
  assert.equal(wantsRow({ card: theirs, prs: [], gits: [clean, clean] }), false);
  assert.equal(wantsRow({ card: theirs, prs: [pr], gits: [clean] }), true);
  assert.equal(wantsRow({ card: theirs, prs: [], gits: [clean, { ...clean, ahead: 1 }] }), true);
  assert.equal(wantsRow({ card: theirs, prs: [], gits: [{ ...clean, uncommitted: 2 }] }), true);
  assert.equal(wantsRow({ card: theirs, prs: [], gits: [null] }), true);
  assert.equal(wantsRow({ card: { ...card, assignedToDeveloper: true }, prs: [], gits: [] }), true);
});

test("when Request Peer Review is not on offer, its label starts it anyway, and only that skill", () => {
  const row = computeRow({ ...base, git: { ...git, head: "h2", tree: "t2", commitsSince: 1 } });
  const request = step(row, "request");
  assert.deepEqual(request.buttons, []);
  assert.deepEqual([request.labelButton.id, request.labelButton.anyway, request.labelButton.enabled], ["request-peer-review", true, true]);
  const ref = { state: row.state, worktree: worktree.path, card: card.id, offered: row.offered };
  assert.match(allowAction("request-peer-review", ref, activity).reason, /not the next step/);
  assert.deepEqual(allowAction("request-peer-review", ref, activity, true), { ok: true });
  assert.match(allowAction("merge-without-peer-review", ref, activity, true).reason, /not the next step/);
  assert.equal(step(computeRow(base), "request").labelButton, null);
});

test("a PR's row title leaves out the card id and the stack position", () => {
  assert.equal(prRowTitle("BL-17105 (2/3 in stack) Let each table text cell choose which languages it shows"), "Let each table text cell choose which languages it shows");
  assert.equal(prRowTitle("Table overflow marks follow resizing (BL-17110)"), "Table overflow marks follow resizing");
  assert.equal(prRowTitle("BL-1: Fix it (1 of 2)"), "Fix it");
});

const prRow = (id, card, number, head, base, repo = "o/r") => ({ id, card, pr: { number, repo, headRefName: head, baseRefName: base } });

test("a stack across two cards is one set, from the PR on the base branch up", () => {
  const sets = prSets([
    prRow("BL-17078", "BL-17078", 8559, "BL-17078", "BL-16822-Inline-Fixes"),
    prRow("BL-16822", "BL-16822", 8530, "BL-16822-Inline-Fixes", "master"),
    prRow("BL-1", "BL-1", 10, "BL-1-x", "master"),
    { id: "BL-2", card: "BL-2", pr: null },
  ]);
  assert.deepEqual(sets, [{ ids: ["BL-16822", "BL-17078"], cards: ["BL-16822", "BL-17078"], stack: { "BL-16822": { at: 1, of: 2 }, "BL-17078": { at: 2, of: 2 } } }]);
});

test("a card with two PRs that are not stacked is a set, by PR number", () => {
  const sets = prSets([prRow("BL-5#12", "BL-5", 12, "b", "master"), prRow("BL-5#11", "BL-5", 11, "a", "master")]);
  assert.deepEqual(sets, [{ ids: ["BL-5#11", "BL-5#12"], cards: ["BL-5"], stack: {} }]);
});

test("a card with a PR in a stack brings its other PRs into the stack's set, after the stack", () => {
  const sets = prSets([
    prRow("BL-5#20", "BL-5", 20, "lone", "master"),
    prRow("BL-5#21", "BL-5", 21, "top", "bottom"),
    prRow("BL-6", "BL-6", 19, "bottom", "master"),
  ]);
  assert.deepEqual(sets.map(s => [s.ids, s.stack]), [[["BL-6", "BL-5#21", "BL-5#20"], { "BL-6": { at: 1, of: 2 }, "BL-5#21": { at: 2, of: 2 } }]]);
});

test("PRs in different repos with the same branch names are not a stack", () => {
  assert.deepEqual(prSets([prRow("A", "BL-1", 1, "x", "master", "o/one"), prRow("B", "BL-2", 2, "y", "x", "o/two")]), []);
});

test("a row counts its teammates' comments to answer apart from the answered ones", () => {
  const c = (answered, who) => ({ who, text: "t", answered, reply: "", url: "u", file: null, line: null });
  const toAnswer = [c(false, "Andrew Polk")], answered = [c(true, "John Thomson"), c(true, "John Thomson")];
  const both = computeRow({ ...base, card: { ...card, state: "Has Comments" }, comments: { total: 1, from: [], peers: [...answered, ...toAnswer] } });
  assert.deepEqual(both.peerComments, { parts: [{ text: "1 comment to answer", yours: true }, { text: "2 answered", yours: false }], toAnswer, answered });
  assert.deepEqual([step(both, "peer").label, step(both, "peer").state], ["Peer review", "later"]);
  const theirTurn = computeRow({ ...base, comments: { total: 0, from: [], peers: answered } });
  assert.deepEqual(theirTurn.peerComments.parts, [{ text: "2 answered", yours: false }]);
  assert.equal(computeRow(base).peerComments, null);
});
