// The worktrees that the page's last section offers to remove: each Orca worktree (other than a
// repo's main checkout) whose branch or path names a card that YouTrack has resolved (Done, Closed,
// Won't Fix and the like). gather.mjs lists them as `staleWorktrees`, with the signs that work may
// still be left in each, and server/service.mjs removes one when the developer asks.
//
// Removing a worktree with `orca worktree rm --delete-branch` keeps its branch unless Orca can
// prove the branch merged, so of the warnings only `uncommitted` names something that removal
// loses. The others say the card may not be finished after all.

// One warning: `kind` groups them for the server's check (WARNING_KINDS), `text` is what the page
// shows, `url` links it when it is about a PR, `open` puts a Show in Orca button after it, and
// `details` are the lines the page lists when the warning is expanded: { text } plus `file` (an
// uncommitted file, whose change opens in VS Code) or `commit` (a commit, whose diff does).
export const WARNING_KINDS = ["uncommitted", "unpushed", "unmerged", "open-pr", "agent", "used"];

// The most lines a warning's details list; a last line says how many more there are.
const MAX_DETAILS = 25;
const capped = list => list.length > MAX_DETAILS ? [...list.slice(0, MAX_DETAILS), { text: `and ${list.length - MAX_DETAILS} more` }] : list;
// `git log --oneline` lines, each opening its commit.
const commitDetails = lines => capped((lines || []).map(l => ({ text: l, commit: l.split(" ")[0] })));
// What `git status` says happened to a file, in words.
const STATUS_WORDS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "conflicted", "?": "new" };
const statusWord = s => STATUS_WORDS[s.trim()[0]] || s.trim();
// An untracked folder, which git lists as one entry ending in a slash, opens nothing.
const fileDetails = changes => capped((changes || []).map(c =>
  c.file.endsWith("/") ? { text: c.file, status: "new folder" } : { text: c.file, status: statusWord(c.status), file: c.file }));

/**
 * The entries of `git status --porcelain -z`: [{ status, file, from }], where `status` is git's
 * two letters ("??" for untracked) and `from` the old name of a renamed or copied file.
 */
export function statusEntries(z) {
  const parts = (z || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const e = { status: p.slice(0, 2), file: p.slice(3) };
    if (/[RC]/.test(e.status[0])) e.from = parts[++i];
    out.push(e);
  }
  return out;
}

// How long after a card is resolved activity in its worktree still counts as finishing that card
// (the last agent's summary, a final push), rather than the worktree being used for something else.
const GRACE_MS = 24 * 3600e3;

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const prNumber = url => url.split("/").pop();

/**
 * The warnings for one stale worktree.
 * - w: the worktree as gather.mjs lists it (modified, untracked, changes, hasUpstream,
 *   upstreamBranch, unpushed, unpushedCommits, ownCommits, lastActivity, orcaComment).
 *   upstreamBranch stays set after GitHub deletes a merged branch; hasUpstream does not.
 * - prs: the card's open PRs in any repo, by anyone ({ url, title, author })
 * - branchPr: the newest merged PR from the worktree's branch, or null
 * - afterMerge: how many commits the branch has that neither that PR nor its base branch has
 *   (null when no PR merged, or when git could not tell), and afterMergeCommits those commits as
 *   `git log --oneline` lines
 * - agents: the worktree's agents from `orca worktree ps` ({ state, question }, with agentState
 *   applied)
 * - resolvedAt: when YouTrack resolved the card (ISO)
 */
export function removalWarnings(w, { prs = [], branchPr = null, afterMerge = null, afterMergeCommits = [], agents = [], resolvedAt = null } = {}) {
  const out = [];
  const dirty = (w.modified?.length || 0) + (w.untracked || 0);
  if (dirty) out.push({ kind: "uncommitted", text: `${plural(dirty, "uncommitted file")}, which removing the worktree deletes`, details: fileDetails(w.changes) });
  if (w.hasUpstream && w.unpushed > 0) out.push({ kind: "unpushed", text: `${plural(w.unpushed, "commit")} not pushed`, details: commitDetails(w.unpushedCommits) });
  else if (!w.upstreamBranch && w.ownCommits?.length) out.push({ kind: "unpushed", text: `branch never pushed, with ${plural(w.ownCommits.length, "commit")}`, details: commitDetails(w.ownCommits) });
  if (branchPr && afterMerge > 0) out.push({ kind: "unmerged", text: `${plural(afterMerge, "commit")} made after PR ${prNumber(branchPr.url)} merged`, url: branchPr.url, details: commitDetails(afterMergeCommits) });
  else if (!branchPr && w.upstreamBranch && w.ownCommits?.length && !prs.some(p => p.headRefName === w.upstreamBranch)) {
    out.push({ kind: "unmerged", text: `${plural(w.ownCommits.length, "commit")} in no merged PR`, details: commitDetails(w.ownCommits) });
  }
  for (const p of prs) out.push({ kind: "open-pr", text: `open PR ${prNumber(p.url)}${p.isDraft ? " (draft)" : ""}${p.author ? " by " + p.author : ""}: ${p.title}`, url: p.url });
  const questions = agents.filter(a => a.state === "waiting" && a.question).map(a => ({ text: a.question }));
  if (agents.some(a => a.state === "working")) out.push({ kind: "agent", text: "Claude is working here", open: true, details: questions });
  else if (agents.some(a => a.state === "waiting")) out.push({ kind: "agent", text: "Claude is asking a question here", open: true, details: questions });
  else if (resolvedAt && w.lastActivity && Date.parse(w.lastActivity) > Date.parse(resolvedAt) + GRACE_MS) {
    out.push({ kind: "used", text: `used in Orca on ${w.lastActivity.slice(0, 10)}, after the card was resolved on ${resolvedAt.slice(0, 10)}`, open: true,
      details: w.orcaComment ? [{ text: "Orca comment: " + w.orcaComment }] : [] });
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
