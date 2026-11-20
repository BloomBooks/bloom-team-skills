// The open PRs on which someone has asked the developer, by name, for a review: the dashboard's
// "Waiting for your review" list. A request to a team the developer is on does not count, nor
// does a PR whose request was taken back or answered (GitHub drops the request once the
// developer submits a review, and adds it again when the author re-requests one).
//
// Run on its own to see the list: node review-requests.mjs

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cardOf, orgsQuery } from "./row-facts.mjs";

/**
 * Asks GitHub for the open PRs in the team's organizations that request a review from
 * `githubLogin`, and returns requestLines of them. Throws when gh cannot search.
 */
export function reviewRequests(githubLogin) {
  const q = `is:pr is:open ${orgsQuery} user-review-requested:${githubLogin}`;
  const out = execFileSync("gh", ["api", "-X", "GET", "search/issues", "-f", "q=" + q, "-f", "per_page=100"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 << 20, windowsHide: true });
  return requestLines(JSON.parse(out).items);
}

/**
 * The list's lines from GitHub's search results, oldest request first so the PR that has waited
 * longest is on top: [{ id, url, summary, pr, author, draft, openedAt }]. id is the card the
 * title names, with url its YouTrack page, or "<repo>#<number>" with url the PR's.
 */
export function requestLines(items) {
  return items.map(i => {
    const repo = i.repository_url.split("/").pop();
    const card = cardOf(i.title);
    return {
      id: card || `${repo}#${i.number}`,
      url: card ? "https://issues.bloomlibrary.org/youtrack/issue/" + card : i.html_url,
      summary: i.title, pr: i.html_url, author: i.user?.login || "", draft: !!i.draft, openedAt: i.created_at,
    };
  }).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { developer } = await import("../../developer.mjs");
  const dev = await developer();
  for (const l of reviewRequests(dev.github)) console.log(`${l.id.padEnd(22)} ${l.author.padEnd(16)} ${l.pr}  ${l.summary}`);
}
