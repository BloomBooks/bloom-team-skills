import { test } from "node:test";
import assert from "node:assert/strict";
import { requestLines, selfRequested } from "./review-requests.mjs";

const asked = (actor, reviewer) => ({ actor: { login: actor }, requestedReviewer: { login: reviewer } });

test("selfRequested is true only when the latest request for the developer was their own", () => {
  assert.equal(selfRequested([asked("Hatton", "hatton")], "hatton"), true);
  assert.equal(selfRequested([asked("JohnThomson", "hatton")], "hatton"), false);
  // The author asked again after the developer claimed it: the request is now the author's.
  assert.equal(selfRequested([asked("hatton", "hatton"), asked("JohnThomson", "hatton")], "hatton"), false);
  // A request for someone else, or a team, says nothing about the developer's.
  assert.equal(selfRequested([asked("hatton", "hatton"), asked("JohnThomson", "andrew-polk"), { actor: { login: "x" }, requestedReviewer: {} }], "hatton"), true);
  assert.equal(selfRequested([], "hatton"), false);
});

const item = (repo, number, title, created_at, more = {}) => ({
  repository_url: "https://api.github.com/repos/" + repo, number, title, created_at,
  html_url: `https://github.com/${repo}/pull/${number}`, user: { login: "JohnThomson" }, ...more,
});

test("requestLines names the card a title names, or else the PR, oldest request first", () => {
  const items = [
    item("BloomBooks/BloomDesktop", 8600, "Fix the thing (BL-17000)", "2026-11-19T10:00:00Z"),
    item("sillsdev/libpalaso", 1566, "Add a flag", "2026-11-18T10:00:00Z", { draft: true }),
  ];
  assert.equal(items[0].created_at > items[1].created_at, true, "the test's newest item should come first in its input");
  assert.deepEqual(requestLines(items), [
    { id: "libpalaso#1566", url: "https://github.com/sillsdev/libpalaso/pull/1566", summary: "Add a flag",
      pr: "https://github.com/sillsdev/libpalaso/pull/1566", author: "JohnThomson", draft: true, openedAt: "2026-11-18T10:00:00Z" },
    { id: "BL-17000", url: "https://issues.bloomlibrary.org/youtrack/issue/BL-17000", summary: "Fix the thing (BL-17000)",
      pr: "https://github.com/BloomBooks/BloomDesktop/pull/8600", author: "JohnThomson", draft: false, openedAt: "2026-11-19T10:00:00Z" },
  ]);
  assert.deepEqual(requestLines([]), []);
});
