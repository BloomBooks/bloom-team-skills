// Tests for the rules of "Back with you for review" in reviewed.mjs. Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardFollowUps, prFacts } from "./reviewed.mjs";

const ME = "johnthomson";
// A prFacts record with the given differences: an open PR by hatton that nobody has commented on.
const pr = (number, more = {}) => ({
  url: "https://github.com/BloomBooks/BloomDesktop/pull/" + number, number, cards: ["BL-1"], author: "hatton",
  draft: false, merged: false, closed: false, mergedAt: "", mergedBy: "", requested: [], mine: [], authorAt: "", ...more,
});
const merged = (number, by, at, more = {}) => pr(number, { merged: true, closed: true, mergedBy: by, mergedAt: at, ...more });
const verdicts = prs => cardFollowUps(prs, ME).map(f => `${f.pr.number} ${f.followUp}`);

test("old merged PRs you commented on don't count when a newer PR is open: the open one is new to you", () => {
  // BL-16822: a stack merged by someone else three weeks ago, then a PR for bugs found in testing.
  const prs = [
    merged(8319, "stephenmcconnel", "2026-10-19T16:15:44Z", { mine: ["2026-10-12T21:29:45.000Z"] }),
    merged(8320, "stephenmcconnel", "2026-10-19T16:17:06Z", { mine: ["2026-10-12T22:56:22.000Z"] }),
    merged(8321, "stephenmcconnel", "2026-10-19T19:23:33Z", { mine: ["2026-10-13T21:00:11.000Z"] }),
    pr(8323, { closed: true }),
    pr(8530),
  ];
  assert.deepEqual(verdicts(prs), ["8530 new"]);
});

test("an open PR you commented on: responded when the author answered since, otherwise forgot", () => {
  const mine = ["2026-11-09T10:00:00.000Z"];
  assert.deepEqual(verdicts([pr(1, { mine, authorAt: "2026-11-09T11:00:00.000Z" })]), ["1 responded"]);
  assert.deepEqual(verdicts([pr(1, { mine, authorAt: "2026-11-09T09:00:00.000Z" })]), ["1 forgot"]);
});

test("a new PR that asks someone else for review is theirs; one that asks you is yours", () => {
  assert.deepEqual(verdicts([pr(1, { requested: ["stephenmcconnel"] })]), []);
  assert.deepEqual(verdicts([pr(1, { requested: ["stephenmcconnel", ME] })]), ["1 new"]);
});

test("a draft is not ready for review, and while it is open the card waits for nobody", () => {
  assert.deepEqual(verdicts([pr(1, { draft: true }), merged(2, ME, "2026-11-01T00:00:00Z")]), []);
});

test("with every PR merged: Ready For Testing only when you merged the last one", () => {
  assert.deepEqual(verdicts([merged(1, "hatton", "2026-11-01T00:00:00Z"), merged(2, ME, "2026-11-02T00:00:00Z")]), ["2 merged"]);
  assert.deepEqual(verdicts([merged(1, ME, "2026-11-01T00:00:00Z"), merged(2, "hatton", "2026-11-02T00:00:00Z")]), []);
});

test("a PR closed without merging needs nothing more from its reviewer", () => {
  assert.deepEqual(verdicts([pr(1, { closed: true, mine: ["2026-11-09T10:00:00.000Z"] })]), []);
});

test("prFacts: the developer's own comments without an agent's, the author's latest activity, the cards", () => {
  const f = prFacts({
    url: "u", number: 7, title: "Fix it (BL-16822)", headRefName: "BL-99-other", isDraft: false, merged: true, closed: true,
    mergedAt: "2026-10-19T16:15:44Z", mergedBy: { login: "StephenMcConnel" }, author: { login: "hatton" }, repository: { name: "BloomDesktop" },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "JohnThomson" } }, { requestedReviewer: {} }] },
    comments: { nodes: [
      { author: { login: "JohnThomson" }, createdAt: "2026-10-12T10:00:00Z", body: "Looks good" },
      { author: { login: "JohnThomson" }, createdAt: "2026-10-13T10:00:00Z", body: "[Claude for John] preflight report" },
      { author: { login: "hatton" }, createdAt: "2026-10-12T11:00:00Z", body: "thanks" },
    ] },
    reviews: { nodes: [{ author: { login: "JohnThomson" }, submittedAt: "2026-10-11T10:00:00Z", body: "" }] },
    commits: { nodes: [{ commit: { committedDate: "2026-10-12T12:00:00Z" } }] },
  }, ME);
  assert.deepEqual(f.cards, ["BL-16822"]);
  assert.deepEqual(f.mine, ["2026-10-11T10:00:00.000Z", "2026-10-12T10:00:00.000Z"]);
  assert.equal(f.authorAt, "2026-10-12T12:00:00.000Z");
  assert.equal(f.mergedBy, "stephenmcconnel");
  assert.deepEqual(f.requested, [ME]);
});
