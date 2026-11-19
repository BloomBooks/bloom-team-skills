// Tests for pr-comments.mjs: which of a PR's discussions wait to be processed.
// Run: node --test "orca-bloom-dashboard-plugin/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { peerComments, waitingComments } from "./pr-comments.mjs";

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

test("peer comments are a teammate's latest comment in each unresolved discussion, split by whose turn it is", () => {
  const onLine = { ...discussion(false, comment(andrew, "rename this")), url: "https://reviewable.io/reviews/o/r/1#-a", location: { file: { path: "src/a.ts" }, line: 12 } };
  const replied = { ...discussion(false, comment(andrew, "why?"), comment(agent, TAG + "Because...")), url: "https://reviewable.io/reviews/o/r/1#-b" };
  const mine = discussion(false, comment(john, "and the PR body?"));
  const resolved = discussion(true, comment(andrew, "done"));
  const bot = discussion(false, comment(greptile, "P1: ..."));
  assert.deepEqual(peerComments([onLine, replied, mine, resolved, bot], "hatton"), [
    { who: "Andrew Polk", text: "rename this", answered: false, reply: "", url: "https://reviewable.io/reviews/o/r/1#-a", file: "src/a.ts", line: 12 },
    { who: "Andrew Polk", text: "why?", answered: true, reply: "Because...", url: "https://reviewable.io/reviews/o/r/1#-b", file: null, line: null },
  ]);
});

test("a teammate who marks a discussion satisfied has been answered; the latest teammate's comment is the one listed", () => {
  const colin = { username: "colin", displayName: "Colin Suggett", agent: false, bot: false };
  const satisfied = { ...discussion(false, comment(andrew, "nit: rename")), participants: [{ ...andrew, disposition: "satisfied" }] };
  const two = discussion(false, comment(colin, "hmm"), comment(andrew, "agree"), comment(agent, TAG + "Fixed."));
  const [a, b] = peerComments([satisfied, two], "hatton");
  assert.deepEqual([a.answered, a.reply], [true, ""]);
  assert.deepEqual([b.answered, b.who, b.text, b.reply], [true, "Andrew Polk", "agree", "Fixed."]);
});
