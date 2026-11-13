// The comments on a PR that wait for the PR's agent to process them, from Reviewable's
// discussions (which include GitHub's review threads). A discussion waits when it is unresolved
// and its last comment was written by a person: the developer in their own review, or a teammate.
// A bot's comment does not count (preflight answers the bots), nor does one that an agent wrote.
// An agent's comment is either posted by Reviewable's agent identity, or posted under a person's
// GitHub login with a bracketed tag first ("[Claude Opus 5.5 from Hatton's machine during
// preflight]", "[Devin] ..."; TEAM-AGENTS.md, Attribution). So a discussion stops waiting once an
// agent has replied to it, though it stays unresolved until its reviewer is satisfied.
//
// Usage: node pr-comments.mjs <PR URL>
// Prints { total, from: [{ who, you, count }] }, the developer first, or null when Reviewable
// could not be read.
import { pathToFileURL } from "node:url";
import { json, out, pool } from "./own-review.mjs";

// A comment that starts with a bracketed tag, which is no Markdown link.
const TAGGED = /^\s*\[[^\]\n]+\](?!\()/;
const byAgent = c => !!(c.author?.agent || c.author?.bot || TAGGED.test(c.markdownBody || ""));

/**
 * Counts the waiting discussions among `discussions` (each as `reviewable review discussions
 * view` prints it) by who wrote the last comment: { total, from: [{ who, you, count }] }, the
 * developer (`login`, their GitHub login) first as "you", then the others by name.
 */
export function waitingComments(discussions, login) {
  const me = String(login || "").toLowerCase();
  const counts = new Map();
  for (const d of discussions) {
    const last = (d.comments || []).at(-1);
    if (!last || d.status?.resolved !== false || byAgent(last)) continue;
    const you = (last.author?.username || "").toLowerCase() === me;
    const who = you ? "you" : last.author?.displayName || last.author?.username || "someone";
    counts.set(who, { who, you, count: (counts.get(who)?.count || 0) + 1 });
  }
  const from = [...counts.values()].sort((a, b) => b.you - a.you || a.who.localeCompare(b.who));
  return { total: from.reduce((n, f) => n + f.count, 0), from };
}

// The answer for each PR and the counters of Reviewable's `review state` it was made at. Reading
// every discussion takes a CLI call each, so an answer is kept while those counters stay the
// same, for up to KEEP_MS.
const KEEP_MS = 5 * 60000;
const kept = new Map();   // PR URL -> { at, counters, value }

export async function prComments(prUrl, githubLogin, now = Date.now()) {
  const m = String(prUrl).match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error("not a GitHub PR URL: " + prUrl);
  const pr = `--pr=${m[1]}/${m[2]}/${m[3]}`;
  try {
    const counters = JSON.stringify(json(await out("reviewable", ["review", "state", pr])).discussions ?? null);
    const k = kept.get(prUrl);
    if (k && k.counters === counters && now - k.at < KEEP_MS) return k.value;
    const keys = json(await out("reviewable", ["review", "discussions", "list", pr]));
    const discussions = await pool(keys, 6, async key => json(await out("reviewable", ["review", "discussions", "view", pr, "--key=" + key])));
    const value = waitingComments(discussions, githubLogin);
    kept.set(prUrl, { at: now, counters, value });
    return value;
  } catch (e) {
    console.error("pr-comments: could not read Reviewable's discussions:", e.message);
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { developer } = await import("../developer.mjs");
  const url = process.argv[2];
  if (!url) { console.error("usage: node pr-comments.mjs <PR URL>"); process.exit(1); }
  console.log(JSON.stringify(await prComments(url, (await developer()).github), null, 2));
}
