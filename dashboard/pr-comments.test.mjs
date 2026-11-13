// Tests for pr-comments.mjs: which of a PR's discussions wait to be processed.
// Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingComments } from "./pr-comments.mjs";

const john = { username: "hatton", displayName: "John Hatton", agent: false, bot: false };
const andrew = { username: "andrew-polk", displayName: "Andrew Polk", agent: false, bot: false };
const agent = { username: "hatton+JHAI", displayName: "Agent JHAI for John Hatton", agent: true, bot: false };
const greptile = { username: "greptile-apps[bot]", agent: false, bot: true };
const TAG = "[Claude Opus 5.5 from Hatton's machine during preflight]\n\n";
const comment = (author, markdownBody) => ({ author, markdownBody });
const discussion = (resolved, ...comments) => ({ comments, status: { resolved } });

test("an unresolved discussion whose last comment is the developer's waits, as from you", () => {
  const c = waitingComments([discussion(false, comment(john, "why do we still have nicescroll changes?"))], "Hatton");
  assert.deepEqual(c, { total: 1, from: [{ who: "you", you: true, count: 1 }] });
});

test("a teammate's comments are counted under their name, after the developer's", () => {
  const c = waitingComments([
    discussion(false, comment(andrew, "rename this")),
    discussion(false, comment(john, "one")),
    discussion(false, comment(andrew, "and this")),
  ], "hatton");
  assert.deepEqual(c.from, [{ who: "you", you: true, count: 1 }, { who: "Andrew Polk", you: false, count: 2 }]);
  assert.equal(c.total, 3);
});

test("a resolved discussion does not wait", () => {
  assert.equal(waitingComments([discussion(true, comment(john, "nit"))], "hatton").total, 0);
});

test("a discussion that an agent or a bot wrote last does not wait", () => {
  const answered = [
    discussion(false, comment(john, "nit"), comment(agent, "Done.")),
    discussion(false, comment(john, "nit"), comment(john, TAG + "Fixed in abc123.")),
    discussion(false, comment(john, "[Devin] **Bug**: marks shift\n\n" + TAG + "Devin found...")),
    discussion(false, comment(greptile, "P1: ...")),
  ];
  assert.equal(waitingComments(answered, "hatton").total, 0);
});

test("the developer's reply to an agent's comment waits", () => {
  const c = waitingComments([discussion(false, comment(john, TAG + "Not an issue."), comment(john, "yes, but our convention is..."))], "hatton");
  assert.equal(c.total, 1);
});

test("a comment that starts with a Markdown link is a person's", () => {
  assert.equal(waitingComments([discussion(false, comment(andrew, "[this page](https://example.com) says otherwise"))], "hatton").total, 1);
});
