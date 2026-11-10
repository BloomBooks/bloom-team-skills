// Tests for diff-facts.mjs, which turns two gathers into the fact lines of events.log.
// Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFacts } from "./diff-facts.mjs";

const card = (id, state, extra) => ({ id, state, assignedToDeveloper: true, ...extra });
const pr = (url, cardId, extra) => ({ url, card: cardId, isDraft: true, mergeable: "MERGEABLE", reviewDecision: "", checks: "PENDING", baseRefName: "master", report: null, reportDecisions: null, reviewRequests: [], ...extra });
const wt = (path, cardId, extra) => ({ path, card: cardId, branch: cardId + "-x", ownCommits: ["a1 one"], unpushed: 0, ...extra });
const facts = ({ cards = [], prs = [], worktrees = [] }) => ({ cards, prs, worktrees });
const URL1 = "https://github.com/BloomBooks/BloomDesktop/pull/1";

test("no earlier gather means nothing to report", () => {
  assert.deepEqual(diffFacts(null, facts({})), []);
});

test("a card's State changing, a new In Progress card, and a card that left", () => {
  const prev = facts({ cards: [card("BL-1", "In Progress"), card("BL-3", "Has Comments")] });
  const next = facts({ cards: [card("BL-1", "Ready For Code Review"), card("BL-2", "In Progress")] });
  assert.deepEqual(diffFacts(prev, next), [
    "BL-1 card: State In Progress -> Ready For Code Review",
    "BL-2 card: new, State In Progress",
    "BL-3 card: no longer listed (resolved, reassigned or moved to another board)",
  ]);
});

test("a PR's fields, a review request, a PR that opened and one that closed", () => {
  const prev = facts({ cards: [card("BL-1", "In Progress")], prs: [pr(URL1, "BL-1"), pr(URL1 + "0", "BL-1")] });
  const next = facts({ cards: [card("BL-1", "In Progress")], prs: [pr(URL1, "BL-1", { isDraft: false, checks: "SUCCESS", reviewRequests: ["colin"] }), pr(URL1 + "1", "BL-1")] });
  assert.deepEqual(diffFacts(prev, next), [
    `BL-1 PR ${URL1}: isDraft true -> false`,
    `BL-1 PR ${URL1}: checks "PENDING" -> "SUCCESS"`,
    `BL-1 PR ${URL1}: review requested from colin`,
    `BL-1 PR ${URL1}1: opened`,
    `BL-1 PR ${URL1}0: merged or closed`,
  ]);
});

test("a worktree's new commits, a push, and worktrees added and removed", () => {
  const prev = facts({ cards: [card("BL-1", "In Progress")], worktrees: [wt("D:/a", "BL-1", { unpushed: 1 }), wt("D:/b", "BL-1")] });
  const next = facts({ cards: [card("BL-1", "In Progress")], worktrees: [wt("D:/a", "BL-1", { ownCommits: ["a1 one", "a2 two"] }), wt("D:/c", "BL-1")] });
  assert.deepEqual(diffFacts(prev, next), [
    "BL-1 D:/a: 1 new commit",
    "BL-1 D:/a: pushed",
    "BL-1 D:/c: worktree added on BL-1-x",
    "BL-1 D:/b: worktree removed",
  ]);
});

test("changes about cards off the board are left out", () => {
  const prev = facts({ cards: [card("BL-1", "Ready For Testing"), card("BL-2", "In Progress", { assignedToDeveloper: false })], prs: [pr(URL1, "BL-1")] });
  const next = facts({ cards: [card("BL-1", "Closed"), card("BL-2", "Has Comments", { assignedToDeveloper: false })], prs: [pr(URL1, "BL-1", { isDraft: false })] });
  assert.deepEqual(diffFacts(prev, next), []);
});

test("a card that one of the developer's worktrees names counts though someone else has it", () => {
  const other = { assignedToDeveloper: false };
  const prev = facts({ cards: [card("BL-5", "In Progress", other)], prs: [pr(URL1, "BL-5")], worktrees: [wt("D:/BL-5-x", "BL-5")] });
  const next = facts({ cards: [card("BL-5", "In Progress", other)], prs: [pr(URL1, "BL-5", { isDraft: false })], worktrees: [wt("D:/BL-5-x", "BL-5")] });
  assert.deepEqual(diffFacts(prev, next), [`BL-5 PR ${URL1}: isDraft true -> false`]);
});
