// Tests for the rules of History in standup.mjs and reviewed.mjs. Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeStandup, bloomRepos, dayOf, historyStart, readyTimes } from "./standup.mjs";
import { followUp } from "./reviewed.mjs";

const ready = at => ({ __typename: "ReadyForReviewEvent", createdAt: at });
const draft = at => ({ __typename: "ConvertToDraftEvent", createdAt: at });
const MON = "2026-11-09T15:00:00Z", TUE = "2026-11-10T15:00:00Z", WED = "2026-11-11T15:00:00Z";

test("a PR opened ready counts as offered on the day it was opened", () => {
  assert.deepEqual(readyTimes({ createdAt: MON, isDraft: false, timelineItems: { nodes: [] } }), [MON]);
});

test("a PR opened ready and later made a draft still counts its opening", () => {
  assert.deepEqual(readyTimes({ createdAt: MON, isDraft: true, timelineItems: { nodes: [draft(TUE)] } }), [MON]);
  assert.deepEqual(readyTimes({ createdAt: MON, isDraft: false, timelineItems: { nodes: [ready(WED), draft(TUE)] } }), [MON, WED]);
});

test("a PR opened as a draft counts only when it was marked ready", () => {
  assert.deepEqual(readyTimes({ createdAt: MON, isDraft: true, timelineItems: { nodes: [] } }), []);
  assert.deepEqual(readyTimes({ createdAt: MON, isDraft: false, timelineItems: { nodes: [ready(TUE)] } }), [TUE]);
  assert.deepEqual(readyTimes({ createdAt: MON, isDraft: true, timelineItems: { nodes: [ready(TUE), draft(WED)] } }), [TUE]);
});

test("History starts two weekdays before today, skipping a weekend", () => {
  // Local times, as the page and standup.mjs use them.
  assert.equal(historyStart(new Date(2026, 10, 9, 10)), "2026-11-05");   // Monday -> Thursday
  assert.equal(historyStart(new Date(2026, 10, 11, 10)), "2026-11-09");  // Wednesday -> Monday
  assert.equal(dayOf(new Date(2026, 10, 9, 23, 30)), "2026-11-09");
});

test("work counts as before stand-up only on a weekday before 8:45", () => {
  assert.equal(beforeStandup(new Date(2026, 10, 9, 8, 44)), true);
  assert.equal(beforeStandup(new Date(2026, 10, 9, 8, 45)), false);
  assert.equal(beforeStandup(new Date(2026, 10, 8, 7, 0)), false);  // Sunday
});

test("bloomRepos keeps the BloomBooks repos Orca knows", () => {
  const repos = [
    { path: "D:/bloom", gitRemoteIdentity: { canonicalKey: "github.com/BloomBooks/BloomDesktop" } },
    { path: "D:/other", gitRemoteIdentity: { canonicalKey: "github.com/someone/else" } },
    { path: "D:/none" },
  ];
  assert.deepEqual(bloomRepos(repos), [{ path: "D:/bloom", slug: "BloomBooks/BloomDesktop", name: "BloomDesktop" }]);
  assert.deepEqual(bloomRepos(undefined), []);
});

test("a reviewed card back in Ready For Code Review: merged, responded or forgot", () => {
  const line = extra => ({ commentedAt: "2026-11-09T10:00:00.000Z", authorAt: "", merged: false, closed: false, ...extra });
  assert.equal(followUp("Ready For Code Review", line({ merged: true, closed: true })), "merged");
  assert.equal(followUp("Ready For Code Review", line({ authorAt: "2026-11-09T11:00:00.000Z" })), "responded");
  assert.equal(followUp("Ready For Code Review", line({ authorAt: "2026-11-09T09:00:00.000Z" })), "forgot");
  assert.equal(followUp("Has Comments", line()), "");
});

test("a PR closed without merging needs nothing more from its reviewer", () => {
  assert.equal(followUp("Ready For Code Review", { commentedAt: "2026-11-09T10:00:00.000Z", authorAt: "2026-11-09T11:00:00.000Z", merged: false, closed: true }), "");
});
