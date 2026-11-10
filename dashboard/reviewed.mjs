// The PRs the developer reviewed lately, by card: for the standup section's Reviewed lines
// (standup.mjs) and for the dashboard's "Back with you for review" list (the ones with a followUp).
//
// Asks GitHub for BloomBooks PRs opened by someone else that the developer reviewed or commented
// on, and keeps those where the developer commented or reviewed in the last DAYS days (Reviewable
// posts its comments as the reviewer's GitHub reviews, so they count). Each PR becomes one line per
// card its title names (or, failing that, its branch), with the card's title and State from
// YouTrack; a PR that names no card is one line under its own title. commentDates lists the times
// of all the developer's comments and reviews on the PR, oldest first; commentedAt is the last.
//
// Two kinds of activity are not reviewing. A comment an agent posted for the developer (preflight,
// devin-review: it starts with "[Claude ...]") shows them running the PR, so it is ignored. And a
// card the developer is or was assigned to is their own work, even when the PR was opened under
// someone else's GitHub account (the Bloom bot opens PRs as Hatton), so it is left off.
//
// A card in Ready For Code Review gets a followUp (see followUp below) and sorts first. A review
// older than DAYS days is still listed when its card is back in Ready For Code Review and the
// author has responded since, because the PR is back with the developer, or when its PR is merged
// while the card still says Ready For Code Review.
//
// Run on its own to see the list: node reviewed.mjs

import { execFileSync } from "node:child_process";

const DAYS = 14;
const CARDS = /\bBL-\d+/gi;
// The attribution line an agent puts at the start of what it posts as the developer.
const AGENT_POST = /^\s*\[Claude\b[^\]]*\]/;

function gh(args) {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    // GraphQL with a PR it cannot see exits non-zero but still prints the data it found.
    const text = String(e.stdout || "");
    if (text.includes("{")) return JSON.parse(text);
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ` + String(e.stderr || e.message).split("\n")[0]);
  }
}

/**
 * yt(path, params) calls the YouTrack REST API and returns the parsed JSON; githubLogin and
 * youtrackLogin are the developer's logins, and gh must be signed in. Returns
 * [{ id, url, summary, state, pr, merged, commentedAt, commentDates, followUp }], newest first. id is the card id, or
 * "<repo>#<number>" for a PR that names no card, whose url is then the PR's.
 */
export async function reviewedCards(yt, githubLogin, youtrackLogin) {
  const since = Date.now() - DAYS * 864e5;
  const day = new Date(since).toISOString().slice(0, 10);
  const me = githubLogin.toLowerCase();

  // PRs the developer reviewed or commented on that changed since then.
  const found = new Map(); // url -> { owner, repo, number }
  for (const who of ["reviewed-by", "commenter"]) {
    for (let page = 1; ; page++) {
      const r = gh(["api", "-X", "GET", "search/issues", "-f", `q=is:pr org:BloomBooks ${who}:${githubLogin} -author:${githubLogin} updated:>=${day}`, "-f", "per_page=100", "-f", "page=" + page]);
      for (const i of r.items) {
        const [owner, repo] = i.repository_url.split("/").slice(-2);
        found.set(i.html_url, { owner, repo, number: i.number });
      }
      if (r.items.length < 100) break;
    }
  }

  // The developer's latest comment or review on each, from GraphQL in batches of 25.
  const prs = [...found.entries()];
  const lines = [];
  for (let k = 0; k < prs.length; k += 25) {
    const batch = prs.slice(k, k + 25);
    const query = "{" + batch.map(([, p], n) => `p${n}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) {
      pullRequest(number: ${p.number}) { title headRefName merged author { login } comments(last: 100) { nodes { author { login } createdAt body } } reviews(last: 100) { nodes { author { login } submittedAt body } } commits(last: 1) { nodes { commit { committedDate } } } } }`).join("\n") + "}";
    const data = gh(["api", "graphql", "-f", "query=" + query]).data || {};
    batch.forEach(([url, p], n) => {
      const pr = data[`p${n}`]?.pullRequest;
      if (!pr || (pr.author?.login || "").toLowerCase() === me) return;
      const byMe = n => (n.author?.login || "").toLowerCase() === me && !AGENT_POST.test(n.body || "");
      const mine = [
        ...pr.comments.nodes.filter(byMe).map(c => c.createdAt),
        ...pr.reviews.nodes.filter(r => byMe(r) && r.submittedAt).map(r => r.submittedAt),
      ].sort();
      // An older review still counts if the card turns out to be back in Ready For Code Review
      // with the author's answer (see below), so the window is applied once the State is known.
      if (!mine.length) return;
      // The author's latest comment, review (Reviewable replies arrive as reviews) or commit.
      const author = (pr.author?.login || "").toLowerCase();
      const theirs = [
        ...pr.comments.nodes.filter(c => (c.author?.login || "").toLowerCase() === author).map(c => c.createdAt),
        ...pr.reviews.nodes.filter(r => (r.author?.login || "").toLowerCase() === author && r.submittedAt).map(r => r.submittedAt),
        ...pr.commits.nodes.map(c => c.commit.committedDate),
      ].sort();
      const cards = [...new Set((pr.title.match(CARDS) || pr.headRefName.match(CARDS) || []).map(c => c.toUpperCase()))];
      lines.push({
        url, repo: p.repo, number: p.number, title: pr.title, cards, merged: !!pr.merged,
        commentDates: mine.map(t => new Date(t).toISOString()),
        commentedAt: new Date(mine.at(-1)).toISOString(),
        authorAt: theirs.length ? new Date(theirs.at(-1)).toISOString() : "",
      });
    });
  }

  // One line per card, with the card's own title and State.
  const ids = [...new Set(lines.flatMap(l => l.cards))];
  const issues = new Map(await Promise.all(ids.map(async id =>
    [id, await yt("/issues/" + id, { fields: "summary,customFields(name,value(name,login))" }).catch(() => null)])));
  // The cards the developer is or was assigned to: their own work, not a review.
  const own = new Set(await Promise.all(ids.map(async id => {
    const assignee = issues.get(id)?.customFields?.find(c => c.name === "Assignee")?.value;
    if ([assignee].flat().some(u => u?.login === youtrackLogin)) return id;
    const history = await yt(`/issues/${id}/activities`, { categories: "CustomFieldCategory", fields: "field(name),added(login),removed(login)", $top: "2000" }).catch(() => []);
    const was = history.some(a => a.field?.name === "Assignee" && [...(a.added || []), ...(a.removed || [])].some(u => u?.login === youtrackLogin));
    return was ? id : null;
  })));
  const out = [];
  const recent = l => Date.parse(l.commentedAt) >= since;
  for (const l of lines) {
    if (!l.cards.length) { if (recent(l)) out.push({ id: `${l.repo}#${l.number}`, url: l.url, summary: l.title, state: "", pr: l.url, merged: l.merged, commentedAt: l.commentedAt, commentDates: l.commentDates, followUp: "" }); continue; }
    for (const id of l.cards) {
      if (own.has(id)) continue;
      const i = issues.get(id);
      const state = i?.customFields?.find(c => c.name === "State")?.value?.name ?? "";
      // Past the window, only a card the author has sent back to the developer, or one whose PR
      // is merged while the card still waits for review.
      if (!recent(l) && !["responded", "merged"].includes(followUp(state, l))) continue;
      out.push({
        id, url: "https://issues.bloomlibrary.org/youtrack/issue/" + id,
        summary: i?.summary || l.title, state,
        pr: l.url, merged: l.merged, commentedAt: l.commentedAt, commentDates: l.commentDates, followUp: followUp(state, l),
      });
    }
  }
  // The ones waiting on the developer first (the author's answers before forgotten moves), then
  // newest comment first.
  const rank = { responded: 0, forgot: 1, merged: 1 };
  return out.sort((a, b) => (rank[a.followUp] ?? 2) - (rank[b.followUp] ?? 2) || b.commentedAt.localeCompare(a.commentedAt));
}

/**
 * Why a reviewed card back in Ready For Code Review needs the developer, or "" when it doesn't:
 * "merged" when the PR is merged, so the card should have moved on to Ready For Testing;
 * otherwise "responded" when the PR's author has commented, reviewed or committed since the
 * developer last commented, so the PR is back with the reviewer; "forgot" when they haven't,
 * which usually means the developer asked for changes but did not move the card to Has Comments.
 */
function followUp(state, line) {
  if (state !== "Ready For Code Review") return "";
  if (line.merged) return "merged";
  return line.authorAt && line.authorAt > line.commentedAt ? "responded" : "forgot";
}

// node reviewed.mjs: print the developer's list.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const { developer } = await import("../developer.mjs");
  const token = process.env.YOUTRACK_BOT || execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('YOUTRACK_BOT','User')"], { encoding: "utf8" }).trim();
  const yt = async (p, params) => {
    const url = new URL("https://issues.bloomlibrary.org/youtrack/api" + p);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (!r.ok) throw new Error(`YouTrack ${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const dev = await developer();
  for (const c of await reviewedCards(yt, dev.github, dev.youtrack.login)) console.log(`${c.commentedAt}  ${(c.followUp || "").padEnd(9)} ${c.id.padEnd(9)} ${c.state.padEnd(21)} ${c.pr.split("/").slice(-3).join("/")}  ${c.summary}`);
}
