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
// Prints { total, from: [{ who, you, count }], texts, peers }, the developer first, or null when
// Reviewable could not be read.
import { pathToFileURL } from "node:url";
import { pool } from "./own-review.mjs";
import { discussion, discussionKeys, reviewState } from "./reviewable.mjs";

// A comment that starts with a bracketed tag, which is no Markdown link.
const TAGGED = /^\s*\[[^\]\n]+\](?!\()/;
const byAgent = c => !!(c.author?.agent || c.author?.bot || TAGGED.test(c.markdownBody || ""));
const nameOf = c => c.author?.displayName || c.author?.username || "someone";

// The waiting discussions among `discussions` (each as `reviewable review discussions view`
// prints it): unresolved, with a last comment that a person wrote.
function waiting(discussions) {
  return discussions.filter(d => {
    const last = (d.comments || []).at(-1);
    return last && d.status?.resolved === false && !byAgent(last);
  });
}

/**
 * Counts the waiting discussions by who wrote the last comment: { total, from: [{ who, you, count }] },
 * the developer (`login`, their GitHub login) first as "you", then the others by name.
 */
export function waitingComments(discussions, login) {
  const me = String(login || "").toLowerCase();
  const counts = new Map();
  for (const d of waiting(discussions)) {
    const last = d.comments.at(-1);
    const you = (last.author?.username || "").toLowerCase() === me;
    const who = you ? "you" : nameOf(last);
    counts.set(who, { who, you, count: (counts.get(who)?.count || 0) + 1 });
  }
  const from = [...counts.values()].sort((a, b) => b.you - a.you || a.who.localeCompare(b.who));
  return { total: from.reduce((n, f) => n + f.count, 0), from };
}

/**
 * The start of up to twelve of the waiting discussions' last comments, each { who, text }, for the
 * prose on a card's row (server/prose.mjs).
 */
export function waitingTexts(discussions) {
  return waiting(discussions).slice(0, 12).map(d => {
    const last = d.comments.at(-1);
    return { who: nameOf(last), text: String(last.markdownBody || "").replace(/\s+/g, " ").slice(0, 200) };
  });
}

/**
 * The unresolved discussions that a teammate (a person other than the developer) has commented
 * in, for the row's count of them: [{ who, text, answered, reply, url, file, line }] with the
 * teammate's latest comment there.
 *   answered   true when the developer or an agent has replied to that comment, or the teammate
 *              marked the discussion satisfied in Reviewable without resolving it: the teammate
 *              is to resolve it. False when it is the developer's turn to answer.
 *   reply      the start of the latest reply, or "" when nobody has replied
 *   url        the discussion in Reviewable; `file` and `line` are null for a comment on the whole PR
 */
export function peerComments(discussions, login) {
  const me = String(login || "").toLowerCase();
  const isTeammate = a => !!a && !a.agent && !a.bot && (a.username || "").toLowerCase() !== me;
  const peers = [];
  for (const d of discussions) {
    if (d.status?.resolved !== false) continue;
    const cs = d.comments || [];
    const i = cs.findLastIndex(c => isTeammate(c.author) && !byAgent(c));
    if (i < 0) continue;
    const writer = (d.participants || []).find(p => (p.username || "") === cs[i].author.username);
    const replied = i < cs.length - 1;
    peers.push({
      who: nameOf(cs[i]), text: String(cs[i].markdownBody || "").trim().slice(0, 2000),
      answered: replied || writer?.disposition === "satisfied",
      reply: replied ? String(cs.at(-1).markdownBody || "").replace(TAGGED, "").trim().slice(0, 300) : "",
      url: d.url || null, file: d.location?.file?.path || null, line: d.location?.line ?? null,
    });
  }
  return peers;
}

// The answer for each PR and the counters of Reviewable's `review state` it was made at. Reading
// every discussion takes a request each, so an answer is kept while those counters stay the
// same, for up to KEEP_MS.
const KEEP_MS = 5 * 60000;
const kept = new Map();   // PR URL -> { at, counters, value }

export async function prComments(prUrl, githubLogin, now = Date.now()) {
  const m = String(prUrl).match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error("not a GitHub PR URL: " + prUrl);
  const pr = { owner: m[1], repo: m[2], number: m[3] };
  try {
    const counters = JSON.stringify((await reviewState(pr)).discussions ?? null);
    const k = kept.get(prUrl);
    if (k && k.counters === counters && now - k.at < KEEP_MS) return k.value;
    const keys = await discussionKeys(pr);
    const discussions = await pool(keys, 6, key => discussion(pr, key));
    const value = { ...waitingComments(discussions, githubLogin), texts: waitingTexts(discussions), peers: peerComments(discussions, githubLogin) };
    kept.set(prUrl, { at: now, counters, value });
    return value;
  } catch (e) {
    console.error("pr-comments: could not read Reviewable's discussions:", e.message);
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { developer } = await import("../../developer.mjs");
  const url = process.argv[2];
  if (!url) { console.error("usage: node pr-comments.mjs <PR URL>"); process.exit(1); }
  console.log(JSON.stringify(await prComments(url, (await developer()).github), null, 2));
}
