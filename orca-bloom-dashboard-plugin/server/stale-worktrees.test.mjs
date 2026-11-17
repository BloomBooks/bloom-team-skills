import { test } from "node:test";
import assert from "node:assert/strict";
import { removalWarnings, statusEntries, unconfirmed } from "./stale-worktrees.mjs";

const clean = { modified: [], untracked: 0, hasUpstream: true, upstreamBranch: "BL-1-x", unpushed: 0, ownCommits: [] };
const merged = { url: "https://github.com/BloomBooks/BloomDesktop/pull/8400" };
const kinds = ws => ws.map(w => w.kind);

test("a clean worktree whose PR merged has no warnings", () => {
  assert.deepEqual(removalWarnings({ ...clean, ownCommits: ["a1 squashed away"] }, { branchPr: merged, afterMerge: 0 }), []);
});

test("uncommitted and untracked files count together and say they are lost", () => {
  const [w] = removalWarnings({ ...clean, modified: ["a.ts", "b.ts"], untracked: 1 }, { branchPr: merged, afterMerge: 0 });
  assert.equal(w.kind, "uncommitted");
  assert.match(w.text, /^3 uncommitted files, which removing/);
});

test("unpushed commits, and a branch never pushed", () => {
  assert.deepEqual(kinds(removalWarnings({ ...clean, unpushed: 2 }, { branchPr: merged, afterMerge: 0 })), ["unpushed"]);
  const never = removalWarnings({ ...clean, hasUpstream: false, upstreamBranch: null, ownCommits: ["a", "b"] });
  assert.deepEqual(kinds(never), ["unpushed"]);
  assert.equal(never[0].text, "branch never pushed, with 2 commits");
});

test("a branch that GitHub deleted after its PR merged is not 'never pushed'", () => {
  const gone = { ...clean, hasUpstream: false, unpushed: -1, ownCommits: ["a squashed"] };
  assert.deepEqual(removalWarnings(gone, { branchPr: merged, afterMerge: 0 }), []);
  assert.deepEqual(kinds(removalWarnings(gone)), ["unmerged"]);
});

test("activity in Orca more than a day after the card was resolved", () => {
  const resolvedAt = "2026-10-10T12:00:00.000Z";
  assert.deepEqual(removalWarnings({ ...clean, lastActivity: "2026-10-11T06:00:00.000Z" }, { branchPr: merged, resolvedAt }), []);
  const [w] = removalWarnings({ ...clean, lastActivity: "2026-11-12T06:00:00.000Z" }, { branchPr: merged, resolvedAt });
  assert.equal(w.kind, "used");
  assert.equal(w.text, "used in Orca on 2026-11-12, after the card was resolved on 2026-10-10");
});

test("commits after the branch's PR merged", () => {
  const [w] = removalWarnings(clean, { branchPr: merged, afterMerge: 1 });
  assert.equal(w.text, "1 commit made after PR 8400 merged");
  assert.equal(w.url, merged.url);
});

test("pushed commits with no PR at all", () => {
  assert.deepEqual(kinds(removalWarnings({ ...clean, ownCommits: ["a"] })), ["unmerged"]);
});

test("an open PR from the branch is named once, as an open PR", () => {
  const pr = { url: "https://github.com/BloomBooks/BloomDesktop/pull/8500", title: "Fix it", headRefName: "BL-1-x", author: "someone", isDraft: true };
  const ws = removalWarnings({ ...clean, ownCommits: ["a"] }, { prs: [pr] });
  assert.deepEqual(kinds(ws), ["open-pr"]);
  assert.equal(ws[0].text, "open PR 8500 (draft) by someone: Fix it");
});

test("agents: working wins over waiting; done says nothing", () => {
  assert.deepEqual(removalWarnings(clean, { branchPr: merged, agents: [{ state: "done" }] }), []);
  assert.equal(removalWarnings(clean, { branchPr: merged, agents: [{ state: "waiting" }, { state: "working" }] })[0].text, "Claude is working here");
});

test("statusEntries reads git status -z, keeping the leading space and a rename's old name", () => {
  assert.deepEqual(statusEntries(" M src/a b.ts\0R  new.ts\0old.ts\0?? notes/\0?? x.txt\0"), [
    { status: " M", file: "src/a b.ts" },
    { status: "R ", file: "new.ts", from: "old.ts" },
    { status: "??", file: "notes/" },
    { status: "??", file: "x.txt" },
  ]);
  assert.deepEqual(statusEntries(null), []);
});

test("the uncommitted warning lists each file; an untracked folder opens nothing", () => {
  const changes = statusEntries(" M a.ts\0?? notes/\0");
  const [w] = removalWarnings({ ...clean, modified: ["a.ts"], untracked: 1, changes }, { branchPr: merged, afterMerge: 0 });
  assert.deepEqual(w.details, [{ text: "a.ts", status: "modified", file: "a.ts" }, { text: "notes/", status: "new folder" }]);
});

test("commit warnings list their commits, at most 25 and a line saying how many more", () => {
  const [w] = removalWarnings({ ...clean, unpushed: 1, unpushedCommits: ["abc1234 Fix the thing"] }, { branchPr: merged, afterMerge: 0 });
  assert.deepEqual(w.details, [{ text: "abc1234 Fix the thing", commit: "abc1234" }]);
  const many = Array.from({ length: 30 }, (_, i) => `c${i} commit ${i}`);
  const [after] = removalWarnings(clean, { branchPr: merged, afterMerge: 30, afterMergeCommits: many });
  assert.equal(after.details.length, 26);
  assert.deepEqual(after.details.at(-1), { text: "and 5 more" });
});

test("a waiting agent's question is the agent warning's detail", () => {
  const [w] = removalWarnings(clean, { branchPr: merged, agents: [{ state: "waiting", question: "Which one?" }] });
  assert.equal(w.open, true);
  assert.deepEqual(w.details, [{ text: "Which one?" }]);
});

test("unconfirmed names what appeared since the page was drawn", () => {
  assert.deepEqual(unconfirmed({ dirty: 0, agents: {} }, []), []);
  assert.deepEqual(unconfirmed({ dirty: 2, agents: { working: true } }, ["uncommitted"]), ["agent"]);
  assert.deepEqual(unconfirmed({ dirty: 2, agents: undefined }, []), ["uncommitted"]);
  assert.deepEqual(unconfirmed({ dirty: 0, agents: { working: false, waiting: true } }, []), ["agent"]);
});
