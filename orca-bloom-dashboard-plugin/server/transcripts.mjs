// The developer's own prompts in Claude Code's session transcripts (~/.claude/projects/<folder>/
// <session id>.jsonl, one JSON object per line). History (standup.mjs) counts them as work on a
// card, and the Worktree panel (plugin/panel-facts.mjs) shows the last few, so both
// read them here.

export const oneLine = text => String(text).replace(/\s+/g, " ").trim();

// A prompt as the developer typed it: a slash command that Claude Code expanded into
// <command-name>/x</command-name>…<command-args>y</command-args> reads "/x y", and one that Git
// Bash rewrote into "C:/Program Files/Git/x" reads "/x".
export function promptText(text) {
  const name = /<command-name>\/?([\w:.-]+)<\/command-name>/.exec(text)?.[1];
  if (name) return `/${name} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ""}`.trim();
  return text.replace(/^[A-Za-z]:\/Program Files\/Git\/([\w-]+)/, "/$1");
}

// The messages the harness itself adds as user turns, in transcripts too old to mark the
// developer's own prompts with an origin.
const HARNESS = /^(<task-notification|<local-command|<system-reminder|Caveat:|This session is being continued|\[Request interrupted|\[SYSTEM NOTIFICATION)/;

// The text of a prompt the developer typed, from a parsed transcript line, or null. Claude Code
// marks those with origin "human": a user message (its text, without any pasted images, which
// arrive as content blocks beside the text), or a `queued_command` attachment for a message sent
// while Claude was working. Transcripts older than that mark have no origin; there, a user message
// with text and none of the messages the harness adds.
export function typedPrompt(j) {
  if (!j || j.isSidechain) return null;
  const q = j.type === "attachment" && j.attachment?.type === "queued_command" ? j.attachment : null;
  if (q) return q.origin?.kind === "human" && q.commandMode === "prompt" && typeof q.prompt === "string" ? q.prompt : null;
  if (j.type !== "user" || j.isMeta) return null;
  const c = j.message?.content;
  const text = typeof c === "string" ? c
    : Array.isArray(c) && !c.some(x => x.type === "tool_result") ? c.filter(x => x.type === "text").map(x => x.text).join("\n") : null;
  if (!text) return null;
  if (j.origin) return j.origin.kind === "human" ? text : null;
  return HARNESS.test(text.trim()) ? null : text;
}

// Whether a transcript line could hold a typed prompt, checked on the raw text before parsing it.
export const mayHoldPrompt = line => line.includes('"type":"user"') || line.includes('"queued_command"');
