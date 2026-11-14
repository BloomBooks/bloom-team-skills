// The worktrees that the page's last section offers to remove: each Orca worktree (other than a
// repo's main checkout) whose branch or path names a card that YouTrack has resolved (Done, Closed,
// Won't Fix and the like). gather.mjs lists them as `staleWorktrees`, with the signs that work may
// still be left in each, and service/service.mjs removes one when the developer asks.
//
// Removing a worktree with `orca worktree rm --delete-branch` keeps its branch unless Orca can
// prove the branch merged, so of the warnings only `uncommitted` names something that removal
// loses. The others say the card may not be finished after all.

// One warning: `kind` groups them for the server's check (WARNING_KINDS), `text` is what the page
// shows, and `url` links it when it is about a PR.
export const WARNING_KINDS = ["uncommitted", "unpushed", "unmerged", "open-pr", "agent", "used"];

// How long after a card is resolved activity in its worktree still counts as finishing that card
// (the last agent's summary, a final push), rather than the worktree being used for something else.
const GRACE_MS = 24 * 3600e3;

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const prNumber = url => url.split("/").pop();

/**
 * The warnings for one stale worktree.
 * - w: the worktree as gather.mjs lists it (modified, untracked, hasUpstream, upstreamBranch,
 *   unpushed, ownCommits, lastActivity). upstreamBranch stays set after GitHub deletes a merged
 *   branch; hasUpstream does not.
 * - prs: the card's open PRs in any repo, by anyone ({ url, title, author })
 * - branchPr: the newest merged PR from the worktree's branch, or null
 * - afterMerge: how many commits the branch has that neither that PR nor its base branch has
 *   (null when no PR merged, or when git could not tell)
 * - agents: the worktree's agents from `orca worktree ps` ({ state }, with agentState applied)
 * - resolvedAt: when YouTrack resolved the card (ISO)
 */
export function removalWarnings(w, { prs = [], branchPr = null, afterMerge = null, agents = [], resolvedAt = null } = {}) {
  const out = [];
  const dirty = (w.modified?.length || 0) + (w.untracked || 0);
  if (dirty) out.push({ kind: "uncommitted", text: `${plural(dirty, "uncommitted file")}, which removing the worktree deletes` });
  if (w.hasUpstream && w.unpushed > 0) out.push({ kind: "unpushed", text: `${plural(w.unpushed, "commit")} not pushed` });
  else if (!w.upstreamBranch && w.ownCommits?.length) out.push({ kind: "unpushed", text: `branch never pushed, with ${plural(w.ownCommits.length, "commit")}` });
  if (branchPr && afterMerge > 0) out.push({ kind: "unmerged", text: `${plural(afterMerge, "commit")} made after PR ${prNumber(branchPr.url)} merged`, url: branchPr.url });
  else if (!branchPr && w.upstreamBranch && w.ownCommits?.length && !prs.some(p => p.headRefName === w.upstreamBranch)) {
    out.push({ kind: "unmerged", text: `${plural(w.ownCommits.length, "commit")} in no merged PR` });
  }
  for (const p of prs) out.push({ kind: "open-pr", text: `open PR ${prNumber(p.url)}${p.isDraft ? " (draft)" : ""}${p.author ? " by " + p.author : ""}: ${p.title}`, url: p.url });
  if (agents.some(a => a.state === "working")) out.push({ kind: "agent", text: "Claude is working here" });
  else if (agents.some(a => a.state === "waiting")) out.push({ kind: "agent", text: "Claude is asking a question here" });
  else if (resolvedAt && w.lastActivity && Date.parse(w.lastActivity) > Date.parse(resolvedAt) + GRACE_MS) {
    out.push({ kind: "used", text: `used in Orca on ${w.lastActivity.slice(0, 10)}, after the card was resolved on ${resolvedAt.slice(0, 10)}` });
  }
  return out;
}

/**
 * The kinds of warning that a worktree has now and that the developer did not confirm: the
 * server's check just before it removes one, since the gather behind the page can be 15 minutes
 * old. `dirty` is how many files `git status` lists now, `agents` the live agents.
 */
export function unconfirmed({ dirty, agents }, confirmed) {
  const now = [];
  if (dirty) now.push("uncommitted");
  if (agents?.working || agents?.waiting) now.push("agent");
  return now.filter(k => !confirmed.includes(k));
}
