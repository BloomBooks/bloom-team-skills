// Reads a PR's review from Reviewable through one `reviewable mcp` process that stays running,
// started at the first request. Each `reviewable review ...` command is a new Node process that
// loads the CLI's whole package tree, and the dashboard asks about every file and every
// discussion of every PR once a minute, so it asks this process instead: the CLI's MCP server
// over stdio, which gives the same answers as the commands.
//
// The process ends when this one does (its stdin closes). One that exits or stops answering is
// replaced at the next request.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 120000;
let server = null;   // { child, pending: Map(id -> { resolve, reject, timer }), ready }
let nextId = 1;

// The child keeps this process alive only while a request waits for its answer, so that a
// script which has printed its result exits.
function hold(s, on) {
  for (const h of [s.child, s.child.stdin, s.child.stdout, s.child.stderr]) on ? h.ref?.() : h.unref?.();
}

function start() {
  // On Windows the `reviewable` CLI can be a .cmd shim (Volta and npm install it that way), which
  // spawn cannot start without a shell, so cmd.exe runs it.
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "reviewable", "mcp"]] : ["reviewable", ["mcp"]];
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const s = { child, pending: new Map() };
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", t => { errors = (errors + t).slice(-2000); });
  const end = why => {
    if (server === s) server = null;
    const error = new Error([why, errors.trim()].filter(Boolean).join(": "));
    for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    s.pending.clear();
    child.stdin.destroy();
    child.kill();
    hold(s, false);
  };
  s.end = end;
  child.on("error", e => end("could not start `reviewable mcp`: " + e.message));
  child.on("exit", code => end("`reviewable mcp` exited with code " + code));
  child.stdin.on("error", () => {});
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const p = s.pending.get(message.id);
      if (!p) continue;
      s.pending.delete(message.id);
      clearTimeout(p.timer);
      if (!s.pending.size) hold(s, false);
      if (message.error) p.reject(new Error(message.error.message || "reviewable mcp error"));
      else p.resolve(message.result);
    }
  });
  s.ready = send(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bloom-dashboard", version: "1" } })
    .then(() => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); });
  s.ready.catch(() => {});
  return s;
}

function send(s, method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => s.end(`\`reviewable mcp\` did not answer ${method} in ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);
    s.pending.set(id, { resolve, reject, timer });
    hold(s, true);
    s.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function request(method, params) {
  const s = server ??= start();
  await s.ready;
  return send(s, method, params);
}

// A tool's answer: the JSON in its first block of text.
async function tool(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  const text = result.content?.find(c => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || name + " failed");
  return JSON.parse(text);
}
async function resource(uri) {
  return JSON.parse((await request("resources/read", { uri })).contents[0].text);
}

const reference = ({ owner, repo, number }) => ({ owner, repo, prNumber: Number(number) });
const uri = ({ owner, repo, number }, kind, key) =>
  `reviewable://reviews/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${Number(number)}/${kind}/${encodeURIComponent(key)}`;

// Each takes the PR as { owner, repo, number } and answers as the CLI command named beside it prints.
export const reviewState = pr => tool("review_state", reference(pr));                                            // review state
export const discussionKeys = async pr => (await tool("review_discussions_list", reference(pr))).map(d => d.key); // review discussions list
export const discussion = (pr, key) => resource(uri(pr, "discussions", key));                                    // review discussions view
export const files = pr => tool("review_files_list", reference(pr));                                             // review files list
export const file = (pr, key) => resource(uri(pr, "files", key));                                                // review files view
