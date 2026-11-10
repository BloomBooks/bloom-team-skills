// Tests for transcripts.mjs, which finds the developer's own prompts in Claude Code transcripts
// for History and the Worktree panel. Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayHoldPrompt, promptText, typedPrompt } from "./transcripts.mjs";

const user = (content, extra) => ({ type: "user", message: { role: "user", content }, ...extra });

test("promptText reads slash commands as the developer typed them", () => {
  assert.equal(promptText("<command-message>preflight</command-message>\n<command-name>/preflight</command-name>\n<command-args>thorough</command-args>"), "/preflight thorough");
  assert.equal(promptText("<command-name>/clear</command-name>"), "/clear");
  assert.equal(promptText("C:/Program Files/Git/request-peer-review"), "/request-peer-review");
  assert.equal(promptText("fix the bug"), "fix the bug");
});

test("a prompt marked human counts, and one marked otherwise does not", () => {
  assert.equal(typedPrompt(user("fix it", { origin: { kind: "human" } })), "fix it");
  assert.equal(typedPrompt(user("fix it", { origin: { kind: "task-notification" } })), null);
});

test("a prompt stored as content blocks counts, without its pasted image", () => {
  const blocks = [{ type: "text", text: "look at this" }, { type: "image", source: {} }];
  assert.equal(typedPrompt(user(blocks)), "look at this");
  assert.equal(typedPrompt(user(blocks, { origin: { kind: "human" } })), "look at this");
});

test("tool results, side chains and meta messages are not prompts", () => {
  assert.equal(typedPrompt(user([{ type: "tool_result", content: "ok" }])), null);
  assert.equal(typedPrompt(user("x", { isSidechain: true })), null);
  assert.equal(typedPrompt(user("x", { isMeta: true })), null);
  assert.equal(typedPrompt({ type: "assistant", message: { content: "hi" } }), null);
});

test("without an origin, the messages the harness adds are not prompts", () => {
  for (const text of ["<task-notification>x</task-notification>", "<system-reminder>x", "Caveat: the messages", "[Request interrupted by user]", "[SYSTEM NOTIFICATION - NOT USER INPUT]"]) {
    assert.equal(typedPrompt(user(text)), null, text);
  }
  assert.equal(typedPrompt(user("<command-message>dashboard</command-message>\n<command-name>/dashboard</command-name>")) !== null, true);
});

test("a message queued while Claude worked counts when a human typed it", () => {
  const queued = (origin, mode = "prompt") => ({ type: "attachment", attachment: { type: "queued_command", prompt: "and the tests", commandMode: mode, origin } });
  assert.equal(typedPrompt(queued({ kind: "human" })), "and the tests");
  assert.equal(typedPrompt(queued({ kind: "task-notification" })), null);
  assert.equal(typedPrompt(queued({ kind: "human" }, "bash")), null);
});

test("mayHoldPrompt lets through the lines typedPrompt reads", () => {
  assert.equal(mayHoldPrompt(JSON.stringify(user("x"))), true);
  assert.equal(mayHoldPrompt(JSON.stringify({ type: "attachment", attachment: { type: "queued_command" } })), true);
  assert.equal(mayHoldPrompt(JSON.stringify({ type: "assistant" })), false);
});
