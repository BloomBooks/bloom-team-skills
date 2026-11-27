// The dashboard's "Review up for grabs" list: cards in Ready For Code Review on the chosen board that
// nobody has taken as reviewer yet, so the developer can pick one up as its first reviewer.
//
// It is the inverse of "Back with you for review" (reviewed.mjs), and uses the same rule for who
// a card's reviewers are (cardReviewers): a card is up for grabs when that list is empty. So
// every card in Ready For Code Review with an open PR is on its reviewer's "Back with you" or on
// everyone's "Review up for grabs". The developer's own cards (is or was assigned) are left out, and so
// is a PR that asks someone else, by name, for a review: like a new PR on "Back with you", it is
// theirs.
//
// Run on its own to see the list: node up-for-grabs.mjs [board]

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cardFacts, cardPrs, cardReviewers, isAssignee } from "./reviewed.mjs";

/**
 * The open, ready PRs of a card that "Review up for grabs" shows ([] for none), from the card's PRs
 * (prFacts records) and its assignees, for the developer me (a lower-case GitHub login; known maps
 * it to their YouTrack login). [] when the card is the developer's own or has a reviewer.
 */
export function grabbable(prs, assignees, me, known) {
  if (isAssignee(me, "", assignees, known) || cardReviewers(prs, assignees, known).length) return [];
  return prs.filter(p => !p.merged && !p.closed && !p.draft && p.author !== me && !(p.requested.length && !p.requested.includes(me)));
}

/**
 * yt(path, params) calls the YouTrack REST API; board is a Kanban Board value ("Bloom 6.6"), or
 * null for every board; githubLogin and youtrackLogin are the developer's. Returns
 * [{ id, url, summary, state, pr, author, additions, deletions, readyAt }], one line per PR, the
 * card that has waited longest in Ready For Code Review first.
 */
export async function upForGrabs(yt, board, githubLogin, youtrackLogin) {
  const me = githubLogin.toLowerCase();
  const known = { [me]: youtrackLogin };
  const query = "project: BL State: {Ready For Code Review}" + (board ? ` {Kanban Board}: {${board}}` : "");
  const ids = (await yt("/issues", { query, fields: "idReadable", $top: "500" })).map(i => i.idReadable);
  const facts = new Map(await Promise.all(ids.map(async id => [id, await cardFacts(yt, id)])));
  const byCard = cardPrs(ids, me);
  const out = [];
  for (const id of ids) {
    const f = facts.get(id);
    if (!f) throw new Error(`could not read ${id} from YouTrack`);
    for (const p of grabbable(byCard.get(id), f.assignees, me, known)) {
      out.push({ id, url: "https://issues.bloomlibrary.org/youtrack/issue/" + id, summary: f.summary, state: f.state, pr: p.url, author: p.author, additions: p.additions, deletions: p.deletions, readyAt: f.readyAt || p.openedAt });
    }
  }
  return out.sort((a, b) => a.readyAt.localeCompare(b.readyAt));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { developer } = await import("../../developer.mjs");
  const token = process.env.YOUTRACK_BOT || execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('YOUTRACK_BOT','User')"], { encoding: "utf8" }).trim();
  const yt = async (p, params) => {
    const url = new URL("https://issues.bloomlibrary.org/youtrack/api" + p);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (!r.ok) throw new Error(`YouTrack ${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const dev = await developer();
  for (const l of await upForGrabs(yt, process.argv[2] || null, dev.github, dev.youtrack.login)) {
    console.log(`${l.readyAt.slice(0, 10)}  ${l.id.padEnd(9)} ${l.author.padEnd(16)} ${l.pr.split("/").slice(-3).join("/")}  ${l.summary}`);
  }
}
