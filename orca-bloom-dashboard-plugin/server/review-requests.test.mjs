import { test } from "node:test";
import assert from "node:assert/strict";
import { requestLines } from "./review-requests.mjs";

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
