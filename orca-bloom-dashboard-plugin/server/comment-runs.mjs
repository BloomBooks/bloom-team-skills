// A card that waits on peer review goes back to In Progress while an agent processes its PR's
// comments, so the dashboard lists it with the work under way. When the run finishes with the
// checkout as it was (the agent only replied), the card goes to Ready For Code Review, back with
// its reviewer. A run that changed code leaves the card In Progress, for preflight, the
// developer's review and Request Peer Review.
//
// These are plain functions of their arguments, so comment-runs.test.mjs tests them; the service
// reads git, writes YouTrack and records what it did on the run as `cardMove`:
//   { card, from, before, pending, settled, error }
import { isOpen } from "./runs.mjs";
import { IN_REVIEW } from "./rows.mjs";

export const COMMENTS_SKILL = "process-pr-comments";
export const WORKING = "In Progress";
// The States that a card waiting on peer review is in. A card in any other State stays where it is.
export const WAITING_ON_REVIEW = [IN_REVIEW, "Has Comments"];

/**
 * What each run of Process PR Comments needs now, as [{ run, step, card, from }]:
 *   start   the run is open and its card waits on peer review: move the card to In Progress
 *   finish  the run finished after moving its card: move the card on to Ready For Code Review
 *           when the checkout is as it was
 *   leave   the run ended before it finished: the card stays In Progress
 * `cardOf(worktree)` is { card, state } for the card whose row has that worktree, or null.
 */
export function commentRunSteps(runs, cardOf) {
  const out = [];
  for (const run of runs.runs) {
    if (run.skill !== COMMENTS_SKILL) continue;
    const m = run.cardMove;
    if (!m) {
      if (!isOpen(run)) continue;
      const c = cardOf(run.worktree);
      if (c && WAITING_ON_REVIEW.includes(c.state)) out.push({ run, step: "start", card: c.card, from: c.state });
    } else if (!m.pending && !m.settled) {
      if (run.state === "finished") out.push({ run, step: "finish" });
      else if (run.state === "ended") out.push({ run, step: "leave" });
    }
  }
  return out;
}

/**
 * Whether the checkout is as it was when the run began: the same HEAD and the same uncommitted
 * changes (git.mjs, checkoutNow). A checkout that could not be read counts as changed.
 */
export const unchanged = (before, after) => !!before && !!after && before.head === after.head && before.changes === after.changes;
