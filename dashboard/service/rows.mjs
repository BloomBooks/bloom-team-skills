// What a card's row says, computed from facts. This is the one place that decides a card's step in
// Bloom's process, which buttons are enabled, and why; the dashboard page and the Worktree panel
// draw what it returns and hold no rule of their own. Every function here is a plain function of
// its arguments, so rows.test.mjs tests it.
//
// A card is in one of these states. The rules in stateOf run in order and the first that matches
// decides:
//
//   peer-review        the card is in Ready For Code Review
//   preflight-running  a preflight run is working or waiting in the worktree
//   comments-running   an agent is processing the PR's comments
//   handoff-running    request-peer-review or merge-without-peer-review is running
//   no-worktree        no worktree and no PR
//   comments           a person's comment waits on the PR
//   code               no PR and no preflight run yet
//   preflight-stopped  the last preflight run paused or ended before it finished
//   preflight-needed   no finished run covers the code as it is, or the PR conflicts or fails CI
//   decision           the finished run's report lists decisions for the developer
//   review             preflight is valid and the developer has files left to review
//   handoff-ready      nothing is left before request-peer-review
import { HAND_OFF, isOpen } from "./runs.mjs";

export const IN_REVIEW = "Ready For Code Review";
export const ROW_STATES = ["In Progress", "Has Comments"];
export const GROUPS = ["near", "nopr", "large", "cleanup"];
// A PR over either of these counts as large.
export const LARGE_FILES = 30;
export const LARGE_LINES = 1500;
// A card with no worktree and no PR that YouTrack has not seen change in this long is cleanup.
export const CLEANUP_DAYS = 180;

export const SKILL_LABEL = { "preflight": "Preflight", "request-peer-review": "Request Peer Review", "merge-without-peer-review": "Merge without Peer Review", "process-pr-comments": "Process PR Comments" };
export const SKILL_RUNNING = { "preflight": "Preflighting", "request-peer-review": "Requesting peer review", "merge-without-peer-review": "Merging", "process-pr-comments": "Processing PR comments" };

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const clock = t => t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

/**
 * Whether the code is still what the finished preflight run ended on, and when not, how it
 * differs. A run records its commit and that commit's tree; the tree is compared, so a squash or
 * a rebase that leaves the content as it was changes nothing. Untracked files do not count.
 * Returns { changed, why } with `changed` null when git could not be read.
 */
export function codeSince(run, git) {
  if (!run?.result) return { changed: null, why: "" };
  if (!git) return { changed: null, why: "git could not be read" };
  const parts = [];
  const moved = run.result.tree ? git.tree !== run.result.tree : run.result.head ? git.head !== run.result.head : false;
  if (moved) parts.push(git.commitsSince > 0 ? plural(git.commitsSince, "commit") : "code changed");
  if (git.uncommitted > 0) parts.push("uncommitted changes");
  if (!parts.length) return { changed: false, why: "" };
  return { changed: true, why: parts.join(" and ").replace(/^code changed and /, "") + " since preflight" };
}

/**
 * The group a row is listed under: "nopr" with no PR, "large" for a PR over LARGE_FILES files or
 * LARGE_LINES changed lines, "cleanup" for a card with no worktree and no PR that has not changed
 * in CLEANUP_DAYS, and otherwise "near".
 */
export function groupOf({ card, pr, worktree }, now = Date.now()) {
  if (!pr && !worktree && card.updated && now - Date.parse(card.updated) > CLEANUP_DAYS * 864e5) return "cleanup";
  if (!pr) return "nopr";
  if ((pr.changedFiles || 0) > LARGE_FILES || (pr.additions || 0) + (pr.deletions || 0) > LARGE_LINES) return "large";
  return "near";
}

/**
 * The state of a card (see the list at the top) and the reasons for it, from:
 *   card      { id, state, approvedPlan }
 *   pr        { url, isDraft, mergeable, checks, reportDecisions } or null
 *   worktree  { path } or null
 *   git       { head, tree, uncommitted, commitsSince } or null when it could not be read
 *   preflight the worktree's newest preflight run, or null
 *   open      the worktree's open run of any skill, or null
 *   review    own-review.mjs's answer { files, reviewed, left, reviewable } or null when unread
 *   comments  pr-comments.mjs's answer { total, from } or null when unread
 */
export function stateOf({ card, pr, worktree, git, preflight, open, review, comments }) {
  if (card.state === IN_REVIEW) return { state: "peer-review", reasons: ["The card is in Ready For Code Review."] };
  if (open && open.state !== "paused") {
    if (open.skill === "preflight") return { state: "preflight-running", reasons: [open.state === "waiting" ? "A preflight run is waiting on reviewers and CI." : "A preflight run is working."] };
    if (open.skill === "process-pr-comments") return { state: "comments-running", reasons: ["An agent is processing the PR's comments."] };
    if (HAND_OFF.includes(open.skill)) return { state: "handoff-running", reasons: [`${SKILL_LABEL[open.skill]} is running.`] };
  }
  if (!worktree && !pr) return { state: "no-worktree", reasons: ["The card has no worktree and no PR."] };
  if (comments?.total > 0) return { state: "comments", reasons: [`${plural(comments.total, "comment")} on the PR wait${comments.total === 1 ? "s" : ""} to be processed.`] };
  if (!pr && !preflight) return { state: "code", reasons: ["No PR yet, and preflight has not run in this worktree."] };
  if (preflight && preflight.state !== "finished") {
    const how = preflight.state === "paused" ? "paused" : preflight.state === "ended" ? "stopped before it finished" : preflight.state;
    return { state: "preflight-stopped", reasons: [`The last preflight run ${how}${preflight.cause ? ": " + preflight.cause : ""}.`] };
  }
  const reasons = [];
  if (!preflight) reasons.push("no preflight run is recorded for this worktree");
  else {
    const since = codeSince(preflight, git);
    if (since.changed) reasons.push(since.why);
    else if (since.changed === null) reasons.push("cannot tell whether the code changed since preflight: " + since.why);
    if (Object.values(preflight.phases || {}).some(p => p?.state === "failed")) reasons.push("a step of the last preflight failed");
  }
  if (pr?.mergeable === "CONFLICTING") reasons.push("PR conflicts with its base branch");
  if (pr?.checks === "FAILURE") reasons.push("CI is failing");
  // A report with decisions is what the finished run stopped on, so it comes before the rest
  // while the code is still what that run saw.
  const codeMoved = reasons.some(r => / since preflight$/.test(r) || r.startsWith("no preflight run"));
  if (pr?.reportDecisions > 0 && !codeMoved) return { state: "decision", reasons: [`The preflight report lists ${plural(pr.reportDecisions, "decision")} for you.`] };
  if (reasons.length) return { state: "preflight-needed", reasons };
  if (!review) return { state: "review", reasons: ["Preflight covers the code as it is. Your review of the PR could not be read."], reviewUnknown: true };
  if (review.files - review.reviewed > 0) return { state: "review", reasons: [`Preflight covers the code as it is. ${review.files - review.reviewed} of ${plural(review.files, "file")} left to review.`] };
  return { state: "handoff-ready", reasons: ["Preflight covers the code as it is and you have reviewed every file."] };
}

// The Process column's steps and the first one that each state leaves unfinished.
const STEP_OF_STATE = {
  "no-worktree": "code", "code": "code", "preflight-running": "preflight", "preflight-stopped": "preflight", "preflight-needed": "preflight",
  "decision": "preflight", "review": "review", "handoff-ready": "request", "handoff-running": "request", "peer-review": "peer",
};
const ORDER = ["code", "preflight", "review", "request", "peer"];

/**
 * Whether an action is allowed, as { ok } or { ok: false, reason }. The row's buttons take their
 * enabled state from this, and the service runs it again on fresh facts before it acts, so a
 * button and its action cannot disagree.
 *   action   "open", "create", "vscode", or one of the skills
 *   row      the row's { state, worktree, card, offered } (computeRow gives them)
 *   activity { working, asking, orcaOk }
 */
export function allowAction(action, row, activity) {
  if (action === "vscode") return row.worktree ? { ok: true } : { ok: false, reason: "This card has no worktree." };
  if (!activity.orcaOk) return { ok: false, reason: "Orca is not answering, so nothing can be opened or started there." };
  if (action === "create") return row.worktree ? { ok: false, reason: "The card already has a worktree." } : /^BL-\d+$/.test(row.card || "") ? { ok: true } : { ok: false, reason: "Only a single card can get a worktree." };
  if (!row.worktree) return { ok: false, reason: "This card has no worktree yet." };
  if (action === "open") return { ok: true };
  if (!SKILL_LABEL[action]) return { ok: false, reason: "Not something the dashboard does: " + action };
  if (activity.asking) return { ok: false, reason: "Claude is asking a question in that worktree; answer it first." };
  if (activity.working) return { ok: false, reason: "Claude is working in that worktree; wait for it to finish." };
  if (!row.offered.includes(action)) return { ok: false, reason: `${SKILL_LABEL[action]} is not the next step for this card.` };
  return { ok: true };
}

/**
 * The whole row for one card, ready to draw. Besides stateOf's arguments:
 *   activity  { working, asking, question, since, orcaOk, orcaError } for the worktree
 *   launch    { skill, at, failed } when a button was pressed and its run has not begun yet
 *   prose     { status, comments, next, at, model, stale } or null
 *   deciders  the decider forms that sessions in the worktree wait on: [{ path, name, topic }]
 *   ages      { git, github, youtrack, review, comments, orca }: when each was last read (ms), and
 *   failing   { github: "error text", ... } for the sources whose last read failed
 */
export function computeRow(input, now = Date.now()) {
  const { card, pr, worktree, git, preflight, open, review, comments, activity = {}, launch = null, prose = null, ages = {}, failing = {}, deciders = [] } = input;
  const { state, reasons, reviewUnknown = false } = stateOf(input);
  const since = codeSince(preflight, git);
  const act = { working: !!activity.working, asking: !!activity.asking, orcaOk: activity.orcaOk !== false };
  const starting = launch && !launch.failed && now - launch.at < 30_000 && !open;
  const blocked = act.asking || state === "decision" || deciders.length > 0;
  const busy = act.working || !!starting || ["preflight-running", "comments-running", "handoff-running"].includes(state);

  // The skills on offer: the first unfinished step's, and with comments waiting, only theirs.
  const first = state === "comments" ? null : STEP_OF_STATE[state];
  const offered = [];
  if (state === "comments") offered.push("process-pr-comments");
  else if (first === "preflight" && state !== "decision") offered.push("preflight");
  else if (first === "request" || reviewUnknown) { offered.push("request-peer-review"); if (card.approvedPlan) offered.push("merge-without-peer-review"); }
  if (state === "peer-review" && comments?.total > 0) offered.push("process-pr-comments");
  // Nothing says when coding is finished, so Preflight is offered beside Code once the worktree
  // holds work: commits beyond the base branch, or changes to tracked files.
  if (state === "code" && worktree && git && (git.ahead > 0 || git.uncommitted > 0)) offered.push("preflight");
  const ref = { state, worktree: worktree?.path ?? null, card: card.id, offered };
  const button = id => {
    const a = allowAction(id, ref, act);
    return { id, label: SKILL_LABEL[id] ?? id, enabled: a.ok && !busy && !blocked, reason: a.ok ? (busy ? "An agent is working on this card." : blocked ? "This card waits for your answer first." : "") : a.reason };
  };

  // Which step shows the spinner: the open run's, or Code for an agent doing anything else.
  const runningSkill = open && open.state !== "paused" ? open.skill : starting ? launch.skill : null;
  const runningStep = runningSkill === "preflight" ? "preflight" : runningSkill === "process-pr-comments" ? "comments" : HAND_OFF.includes(runningSkill) ? "request" : act.working ? "code" : null;
  const runningSince = runningSkill ? (open?.startedAt ?? launch?.at ?? 0) : activity.since || 0;
  const runningNote = starting ? "Starting…" : open?.state === "waiting" ? "Waiting on reviewers and CI" : "";

  // With comments waiting, the steps show as they would without them, and only the review stays offered.
  const base = state === "comments" || state === "comments-running" ? stateOf({ ...input, comments: null, open: null }) : { state, reviewUnknown };
  const firstIndex = ORDER.indexOf(STEP_OF_STATE[base.state] ?? "code");
  const commentsShown = state === "comments" || state === "comments-running";
  const stepState = id => {
    if (runningStep === id) return "running";
    const i = ORDER.indexOf(id);
    if (i < firstIndex) return "done";
    if (id === "preflight" && offered.includes("preflight")) return "now";
    if (commentsShown) return id === "review" && i === firstIndex ? "now" : "later";
    if (i === firstIndex) return id === "peer" ? "later" : "now";
    if (id === "request" && base.reviewUnknown) return "now";
    return "later";
  };
  const left = review ? review.files - review.reviewed : null;
  const steps = [
    { id: "code", label: act.working && runningStep === "code" ? "Agent working" : worktree ? "Code" : "Start coding", state: stepState("code"),
      buttons: stepState("code") === "now" ? [{ ...button(worktree ? "open" : "create"), label: worktree ? "Code" : "Start coding" }] : [] },
    { id: "preflight", label: runningStep === "preflight" ? SKILL_RUNNING.preflight : "Preflight", state: stepState("preflight"),
      note: stepState("preflight") === "now" && ["preflight-needed", "preflight-stopped"].includes(state) ? reasons.join("; ") : "",
      buttons: stepState("preflight") === "now" && state !== "decision" ? [button("preflight")] : [] },
    { id: "review", label: left ? `Your review (${left} of ${plural(review.files, "file")} left${review.reviewable ? "" : "; couldn't read Reviewable"})` : "Your review", state: stepState("review"),
      link: stepState("review") === "now" && pr ? pr.url : null, linkEnabled: !busy && !blocked, files: review?.left ?? null, reviewable: review?.reviewable ?? null },
  ];
  if (commentsShown) steps.push({ id: "comments", label: state === "comments-running" ? SKILL_RUNNING["process-pr-comments"] : "Process PR Comments", state: state === "comments-running" ? "running" : "now",
    note: state === "comments" && comments ? commentsText(comments) : "", buttons: state === "comments" ? [button("process-pr-comments")] : [] });
  steps.push({ id: "request", label: runningStep === "request" ? SKILL_RUNNING[runningSkill] : card.approvedPlan ? "Request Peer Review, or Merge" : "Request Peer Review", state: stepState("request"),
    buttons: stepState("request") === "now" ? [button("request-peer-review"), ...(card.approvedPlan ? [button("merge-without-peer-review")] : [])] : [] });
  steps.push({ id: "peer", label: card.state === "Has Comments" ? "Peer review: comments back" : "Peer review", state: card.state === "Has Comments" ? "comments" : stepState("peer") });
  for (const s of steps) if (s.state === "running") { s.since = runningSince; s.runningNote = runningNote; }

  // A decider form that a session in the worktree is waiting on comes before a report's count:
  // it is the form to answer.
  const badge = act.asking ? { kind: "asking", text: "Claude has a question", question: activity.question || "" }
    : deciders.length ? { kind: "you", text: "Needs your decision", url: deciders[0].path }
    : state === "decision" ? { kind: "you", text: "Needs your decision", url: pr?.report || null } : null;
  const reportOld = !!pr?.report && ["preflight-needed", "preflight-stopped", "code"].includes(state);
  const failed = launch?.failed ? `Typed ${SKILL_LABEL[launch.skill] ?? launch.skill} at ${clock(launch.at)}, but the session did not start it.` : "";

  // "Why does this row say that?": the rule that matched, then each fact it read, with the
  // source it came from and when that source was last read (the page turns `at` into an age).
  const fact = (label, text, source = "", at = 0) => ({ label, text, source, at });
  const why = [
    fact("State", `${state}: ${reasons.join(" ")}`),
    fact("Card", (card.state || "State unknown") + (failing.youtrack ? "; the last read failed: " + failing.youtrack : ""), "YouTrack", ages.youtrack),
    fact("PR", pr ? `${pr.isDraft ? "draft" : "ready"}, ${pr.mergeable || "mergeability unknown"}, CI ${pr.checks || "none"}${pr.reportDecisions != null ? ", report lists " + plural(pr.reportDecisions, "decision") : ""}${failing.github ? "; the last read failed: " + failing.github : ""}` : "none found for this card", "GitHub", ages.github),
    fact("Worktree", worktree ? `${worktree.path}${git ? `: HEAD ${String(git.head).slice(0, 7)}, tree ${String(git.tree).slice(0, 7)}, ${plural(git.uncommitted, "tracked file")} changed, ${git.ahead ?? "?"} beyond ${git.base}` : ": git could not be read" + (failing.git ? " (" + failing.git + ")" : "")}` : "none", worktree ? "git" : "", ages.git),
    fact("Preflight", preflight ? `last run ${preflight.state}${preflight.cause ? " (" + preflight.cause + ")" : ""}, began ${clock(preflight.startedAt)}${preflight.result?.tree ? ", ended on tree " + preflight.result.tree.slice(0, 7) : ""}; known from ${preflight.signals.join(", ")}${since.changed ? "; " + since.why : ""}` : "no run recorded on this machine", preflight ? "hooks and progress records" : ""),
    fact("Your review", review ? `${review.reviewed} of ${review.files} files reviewed${review.reviewable ? "" : " (Reviewable could not be read, so only GitHub's Viewed marks count)"}` : "not read", review ? "GitHub and Reviewable" : "", ages.review),
    fact("PR comments", comments ? `${comments.total} waiting` : "not read" + (failing.reviewable ? ": " + failing.reviewable : ""), comments ? "Reviewable" : "", ages.comments),
    fact("Agents", act.orcaOk ? `${act.working ? "working" : act.asking ? "asking a question" : "none working"}${open ? `; ${open.skill} run ${open.state}${open.cause ? " (" + open.cause + ")" : ""}` : ""}` : "Orca is not answering: " + (activity.orcaError || ""), "Orca", ages.orca),
  ];

  return {
    card: card.id, cardUrl: card.url, title: card.summary || "", ytState: card.state, approvedPlan: !!card.approvedPlan,
    pr: pr?.url ?? null, prState: pr ? (pr.isDraft ? "draft" : "open") : null,
    worktree: worktree?.path ?? null, branch: worktree?.branch ?? null,
    group: groupOf(input, now), state, reasons, offered, steps, badge, busy,
    actions: { open: button("open"), create: button("create"), vscode: button("vscode") },
    run: open?.skill === "preflight" && open.state !== "paused" ? { phases: open.phases || {}, state: open.state, cause: open.cause, startedAt: open.startedAt } : null,
    stopped: state === "preflight-stopped" ? { phases: preflight.phases || {}, state: preflight.state, cause: preflight.cause } : null,
    report: pr?.report ? { url: pr.report, old: reportOld, decisions: reportOld ? 0 : pr.reportDecisions || 0 } : null,
    question: act.asking ? activity.question || "" : "",
    comments: comments ? { total: comments.total, text: comments.total ? commentsText(comments) : "", button: button("process-pr-comments") } : null,
    deciders, prose, failed, why,
    unknown: Object.entries(failing).map(([source, error]) => ({ source, error, since: ages[source] || 0 })),
  };
}

// "3 comments from you, 1 from Andrew Polk", from pr-comments.mjs's { total, from }.
export function commentsText(c) {
  return c.from.map((f, i) => (i ? f.count : f.count + (c.total === 1 ? " comment" : " comments")) + " from " + f.who).join(", ");
}

/** How far along a row is, for ordering rows in a group: the nearest to hand-off first. */
export function orderOf(row) {
  const rank = ["handoff-running", "handoff-ready", "review", "decision", "comments-running", "comments", "preflight-running", "preflight-stopped", "preflight-needed", "code", "no-worktree"];
  return rank.indexOf(row.state);
}
