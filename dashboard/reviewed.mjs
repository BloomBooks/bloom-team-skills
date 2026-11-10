// The PRs the developer reviewed lately, by card: for the standup section's Reviewed lines
// (standup.mjs, from reviewedCards) and for the dashboard's "Back with you for review" list (from
// backForReview).
//
// reviewedCards asks GitHub for BloomBooks PRs opened by someone else that the developer reviewed
// or commented on, and keeps those where the developer commented or reviewed in the last DAYS days
// (Reviewable posts its comments as the reviewer's GitHub reviews, so they count). Each PR becomes
// one line per card its title names (or, failing that, its branch), with the card's title and
// State from YouTrack; a PR that names no card is one line under its own title. commentDates lists
// the times of all the developer's comments and reviews on the PR, oldest first; commentedAt is the
// last. A line whose card is in Ready For Code Review is kept however old, for backForReview.
//
// Two kinds of activity are not reviewing. A comment an agent posted for the developer (preflight,
// devin-review: it starts with "[Claude ...]") shows them running the PR, so it is ignored. And a
// card the developer is or was assigned to is their own work, even when the PR was opened under
// someone else's GitHub account (the Bloom bot opens PRs as Hatton), so it is left off.
//
// backForReview judges each reviewed card in Ready For Code Review as a whole, from all of the
// card's PRs, not just the ones the developer commented on: a card often has a stack of PRs, merged
// weeks ago, and then a new PR for a bug found in testing. What the card waits for is its open PR
// (see cardFollowUps).
//
// Run on its own to see both lists: node reviewed.mjs

import { execFileSync } from "node:child_process";

const DAYS = 14;
// How far back the search for PRs reaches. Past DAYS, a review stays on the list only when its
// card is still in Ready For Code Review; a PR merged three weeks ago is not updated since, so a
// search limited to DAYS would never find it.
const FOLLOW_UP_DAYS = 60;
const CARDS = /\bBL-\d+/gi;
const READY_FOR_REVIEW = "Ready For Code Review";
// The attribution line an agent puts at the start of what it posts as the developer.
const AGENT_POST = /^\s*\[Claude\b[^\]]*\]/;
const login = u => (u?.login || "").toLowerCase();

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

// The GraphQL fields of a PR that prFacts reads.
const PR_FIELDS = `url number title headRefName isDraft merged closed mergedAt mergedBy { login } author { login }
  repository { name }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  comments(last: 100) { nodes { author { login } createdAt body } }
  reviews(last: 100) { nodes { author { login } submittedAt body } }
  commits(last: 1) { nodes { commit { committedDate } } }`;

/**
 * What the rules need from a PR as GraphQL returns it (PR_FIELDS), for the developer's GitHub
 * login me (lower case): the cards it names, its state, who merged it, the times of the
 * developer's own comments and reviews (mine, oldest first; an agent's posts left out), the time
 * of the author's latest comment, review or commit (authorAt), and the logins asked to review it.
 */
export function prFacts(pr, me) {
  const author = login(pr.author);
  const byMe = n => login(n.author) === me && !AGENT_POST.test(n.body || "");
  const mine = [
    ...pr.comments.nodes.filter(byMe).map(c => c.createdAt),
    ...pr.reviews.nodes.filter(r => byMe(r) && r.submittedAt).map(r => r.submittedAt),
  ].map(t => new Date(t).toISOString()).sort();
  // Reviewable's replies arrive as reviews, so the author's count too.
  const theirs = [
    ...pr.comments.nodes.filter(c => login(c.author) === author).map(c => c.createdAt),
    ...pr.reviews.nodes.filter(r => login(r.author) === author && r.submittedAt).map(r => r.submittedAt),
    ...pr.commits.nodes.map(c => c.commit.committedDate),
  ].map(t => new Date(t).toISOString()).sort();
  return {
    url: pr.url, repo: pr.repository?.name || "", number: pr.number, title: pr.title,
    cards: [...new Set((pr.title.match(CARDS) || pr.headRefName.match(CARDS) || []).map(c => c.toUpperCase()))],
    author, draft: !!pr.isDraft, merged: !!pr.merged, closed: !!pr.closed,
    mergedAt: pr.mergedAt || "", mergedBy: login(pr.mergedBy),
    requested: (pr.reviewRequests?.nodes || []).map(n => login(n.requestedReviewer)).filter(Boolean),
    mine, authorAt: theirs.at(-1) || "",
  };
}

// Runs GraphQL queries that are each "alias: field { ... }", 25 to a request, and returns
// { alias: result }.
function graphqlBatches(parts) {
  const data = {};
  for (let k = 0; k < parts.length; k += 25) Object.assign(data, gh(["api", "graphql", "-f", "query={" + parts.slice(k, k + 25).join("\n") + "}"]).data || {});
  return data;
}

/**
 * yt(path, params) calls the YouTrack REST API and returns the parsed JSON; githubLogin and
 * youtrackLogin are the developer's logins, and gh must be signed in. Returns
 * [{ id, url, summary, state, pr, merged, commentedAt, commentDates }], newest first. id is the
 * card id, or "<repo>#<number>" for a PR that names no card, whose url is then the PR's.
 */
export async function reviewedCards(yt, githubLogin, youtrackLogin) {
  const since = Date.now() - DAYS * 864e5;
  const day = new Date(Date.now() - FOLLOW_UP_DAYS * 864e5).toISOString().slice(0, 10);
  const me = githubLogin.toLowerCase();

  // PRs the developer reviewed or commented on that changed in the last FOLLOW_UP_DAYS.
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

  const prs = [...found.values()];
  const data = graphqlBatches(prs.map((p, n) => `p${n}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) { pullRequest(number: ${p.number}) { ${PR_FIELDS} } }`));
  const lines = prs.map((p, n) => data[`p${n}`]?.pullRequest).filter(Boolean).map(pr => prFacts(pr, me))
    .filter(l => l.author !== me && l.mine.length);

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
  const recent = l => Date.parse(l.mine.at(-1)) >= since;
  const line = (l, more) => ({ pr: l.url, merged: l.merged, commentedAt: l.mine.at(-1), commentDates: l.mine, ...more });
  for (const l of lines) {
    if (!l.cards.length) { if (recent(l)) out.push(line(l, { id: `${l.repo}#${l.number}`, url: l.url, summary: l.title, state: "" })); continue; }
    for (const id of l.cards) {
      if (own.has(id)) continue;
      const i = issues.get(id);
      const state = i?.customFields?.find(c => c.name === "State")?.value?.name ?? "";
      if (!recent(l) && state !== READY_FOR_REVIEW) continue;
      out.push(line(l, { id, url: "https://issues.bloomlibrary.org/youtrack/issue/" + id, summary: i?.summary || l.title, state }));
    }
  }
  return out.sort((a, b) => b.commentedAt.localeCompare(a.commentedAt));
}

/**
 * The "Back with you for review" list, from reviewedCards' lines: for each reviewed card in Ready
 * For Code Review, every PR whose title or branch names the card is fetched from GitHub, and
 * cardFollowUps says what, if anything, the card needs from the developer. Returns
 * [{ id, url, summary, state, pr, merged, commentedAt, followUp }], the ones needing the developer
 * most first; commentedAt is the developer's latest comment on any of the card's PRs.
 */
export function backForReview(reviewed, githubLogin) {
  const me = githubLogin.toLowerCase();
  const cards = new Map();
  for (const r of reviewed) if (r.state === READY_FOR_REVIEW && /^BL-\d+$/.test(r.id) && !cards.has(r.id)) cards.set(r.id, r);
  const ids = [...cards.keys()];
  // GitHub's search matches the id as a word of the title; the branch is checked by prFacts.
  const data = graphqlBatches(ids.map((id, n) => `c${n}: search(query: ${JSON.stringify(`is:pr org:BloomBooks ${id} in:title`)}, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }`));
  const out = [];
  ids.forEach((id, n) => {
    const card = cards.get(id);
    const found = (data[`c${n}`]?.nodes || []).filter(p => p.url).map(p => prFacts(p, me));
    // A PR found only by its branch (reviewedCards' lines) is one of the card's too.
    const known = new Set(found.map(p => p.url));
    const missing = reviewed.filter(r => r.id === id && !known.has(r.pr));
    if (missing.length) {
      const more = graphqlBatches(missing.map((r, k) => {
        const [, owner, repo, number] = r.pr.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/) || [];
        return `m${k}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequest(number: ${number}) { ${PR_FIELDS} } }`;
      }));
      for (const k of Object.keys(more)) if (more[k]?.pullRequest) found.push(prFacts(more[k].pullRequest, me));
    }
    const prs = found.filter(p => p.cards.includes(id));
    const commentedAt = prs.flatMap(p => p.mine).sort().at(-1) || card.commentedAt;
    for (const f of cardFollowUps(prs, me)) {
      out.push({ id, url: card.url, summary: card.summary, state: card.state, pr: f.pr.url, merged: f.pr.merged, commentedAt, followUp: f.followUp });
    }
  });
  const rank = { responded: 0, new: 1, forgot: 2, merged: 2 };
  return out.sort((a, b) => (rank[a.followUp] ?? 3) - (rank[b.followUp] ?? 3) || b.commentedAt.localeCompare(a.commentedAt));
}

/**
 * What a card in Ready For Code Review needs from the developer (me, a lower-case GitHub login),
 * given all its PRs (prFacts records): [{ pr, followUp }], empty when nothing.
 *
 * The card waits for its open PRs (drafts aside, since nobody reviews those yet). For each:
 * "responded" when the developer has commented on it and the author has commented, reviewed or
 * committed since, so it is back with the reviewer; "forgot" when the author hasn't, which usually
 * means the developer asked for changes but did not move the card to Has Comments; "new" when the
 * developer has not commented on it, unless it asks others, and not the developer, to review it.
 *
 * With no open PR (draft or not), the card waits for nobody's review. "merged" when its PRs are
 * all merged or closed and the developer merged the last one to merge, so the card should be in
 * Ready For Testing; someone else's merge is theirs to follow through.
 */
export function cardFollowUps(prs, me) {
  const open = prs.filter(p => !p.merged && !p.closed);
  if (open.length) {
    return open.filter(p => !p.draft).flatMap(p => {
      if (!p.mine.length) return p.requested.length && !p.requested.includes(me) ? [] : [{ pr: p, followUp: "new" }];
      return [{ pr: p, followUp: p.authorAt > p.mine.at(-1) ? "responded" : "forgot" }];
    });
  }
  const last = prs.filter(p => p.merged).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)).at(-1);
  return last && last.mergedBy === me ? [{ pr: last, followUp: "merged" }] : [];
}

// node reviewed.mjs: print the developer's lists.
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
  const reviewed = await reviewedCards(yt, dev.github, dev.youtrack.login);
  const show = c => `${c.commentedAt}  ${(c.followUp || "").padEnd(9)} ${c.id.padEnd(9)} ${c.state.padEnd(21)} ${c.pr.split("/").slice(-3).join("/")}  ${c.summary}`;
  console.log("Reviewed:");
  for (const c of reviewed) console.log("  " + show(c));
  console.log("Back with you for review:");
  for (const c of backForReview(reviewed, dev.github)) console.log("  " + show(c));
}
