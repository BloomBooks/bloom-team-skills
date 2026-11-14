// The three pieces of prose on a row that code cannot compute: where the work has got to, what
// the reviewers asked for (on a card in Has Comments), and a "Next:" note for something outside
// Bloom's normal process. Nothing else on a row comes from an LLM, and the row is complete without
// these.
//
// The service asks for them only when the facts they describe change (digestOf), one card at a
// time, through `claude -p`: Claude Code's headless mode, which uses the developer's own sign-in,
// so nobody needs an API key. The model is config.json's `model`, by default MODEL: the smallest
// current model. The job is to put a dozen given facts into one sentence, which needs no more, and
// a call is about 600 tokens in and 100 out on top of the 12,500 that Claude Code's own system
// prompt costs, read from cache after the first call of the hour.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { dataDir, dataFile, log, readJsonFile } from "./env.mjs";

export const MODEL = "claude-haiku-5-5";
// The facts must stay as they are this long before a call is made about them.
export const SETTLE_MS = 2 * 60_000;

export const config = () => ({ model: MODEL, prose: true, ...readJsonFile(dataFile("config.json"), {}) });

// The folder that the headless sessions run in; the service ignores hook payloads from it.
export const llmDir = () => path.join(dataDir(), "llm");

const SYSTEM = `You write short status text for one row of a software developer's dashboard. You are given facts as JSON. Answer with one JSON object and nothing else: {"status": string, "comments": string, "next": string}.

"status": one sentence of at most 14 words on how far the work itself has got toward review: code written or not, the PR, conflicts, CI, preflight, review, blockers. Example: "Draft PR conflicts with master; CI green." Do not mention worktrees, agents, branch names, commit hashes or commit counts. Use only the facts given.

"comments": only when the card's state is "Has Comments": what the people who asked for changes said, in a few words each, with their first name. Example: "Colin: Undo does nothing after unlocking." Leave out comments written by an agent or a bot (they start with a bracketed tag). Otherwise "".

"next": almost always "". The dashboard already shows the next step of the process (preflight, the developer's own review, processing PR comments, requesting peer review), so never restate that. Fill it only for something outside that process which the facts state plainly: waiting for another PR or person, or a check that must be done by hand before review.`;

/** A digest of the facts that the prose describes; the prose is rewritten when it changes. */
export function digestOf(facts) {
  return crypto.createHash("sha1").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}

// The object in a model's answer, which may come wrapped in a code fence.
export function parseAnswer(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("the answer holds no JSON object");
  const j = JSON.parse(m[0]);
  const s = v => typeof v === "string" ? v.trim().slice(0, 300) : "";
  return { status: s(j.status), comments: s(j.comments), next: s(j.next) };
}

// A "Next:" note that only names a step of the process says what the Process column already
// says, and could contradict it, so it is dropped.
export const restatesProcess = next => /\b(preflight|request[- ]peer[- ]review|peer review|review the pr|your (own )?review|process (the )?(pr )?comments|merge without)\b/i.test(next);

const usage = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastAt: 0, lastError: "", day: "" };
export function proseUsage() { return { ...usage, model: config().model, enabled: !!config().prose }; }

/**
 * Asks the model for a row's prose from `facts` (a small JSON object). Returns { status, comments,
 * next, at, model, digest }. Throws when the call fails; the caller keeps the earlier prose.
 */
export function writeProse(facts) {
  const { model } = config();
  fs.mkdirSync(llmDir(), { recursive: true });
  const env = { ...process.env };
  // Variables of a session that started the service would make this call part of that session.
  for (const name of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|ORCA_AGENT_)/.test(name)) delete env[name];
  const day = new Date().toDateString();
  if (usage.day !== day) Object.assign(usage, { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, day });
  return new Promise((resolve, reject) => {
    // The system prompt goes in a file, and `claude` (a .cmd shim under npm and Volta, which only
    // a shell starts) through cmd.exe, so no argument holds anything a shell would read.
    const systemFile = path.join(llmDir(), "system.txt");
    fs.writeFileSync(systemFile, SYSTEM);
    const args = ["-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt-file", systemFile];
    const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "claude", ...args]] : ["claude", args];
    const child = execFile(cmd, cmdArgs, { cwd: llmDir(), env, windowsHide: true, timeout: 90_000, maxBuffer: 8 << 20 }, (error, stdout) => {
      usage.calls++; usage.lastAt = Date.now();
      try {
        if (error && !stdout) throw error;
        const j = JSON.parse(stdout);
        usage.inputTokens += (j.usage?.input_tokens || 0) + (j.usage?.cache_read_input_tokens || 0) + (j.usage?.cache_creation_input_tokens || 0);
        usage.outputTokens += j.usage?.output_tokens || 0;
        usage.costUsd += j.total_cost_usd || 0;
        if (j.is_error) throw new Error(String(j.result || j.subtype || "the model call failed").slice(0, 200));
        const answer = parseAnswer(j.result);
        if (restatesProcess(answer.next)) answer.next = "";
        usage.lastError = "";
        resolve({ ...answer, at: Date.now(), model, digest: digestOf(facts) });
      } catch (e) {
        usage.failures++; usage.lastError = String(e.message).split("\n")[0].slice(0, 200);
        log("prose failed: " + usage.lastError);
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(facts));
  });
}
