// The facts about a card's row that the dashboard server (server.mjs), the gather (gather.mjs),
// progress.mjs and the Worktree panel's worker (worktree-panel/worktree-facts.mjs) all work out
// the same way: what Orca's agents in a worktree are doing, a PR's CI checks, a preflight run's
// progress file, the rows the session wrote and what is wrong with them, and what the server adds
// to a row before the page draws it (row.js). Every rule here is a plain function of its
// arguments, apart from the readers of the dashboard's files, so row-facts.test.mjs tests them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentState, DASHBOARD_SKILLS, norm } from "../orca-worktrees.mjs";

export { agentState, DASHBOARD_SKILLS, norm };

const execFileP = promisify(execFile);

// The folders are worked out each time they are used, so that a test can point the home folder
// at a temporary one.
export const dataDir = () => path.join(os.homedir(), ".claude", "bloom-dashboard");
export const rowsDir = () => path.join(dataDir(), "rows");
export const progressDir = () => path.join(dataDir(), "progress");
export const CARD = /\bBL-\d+/i;

// The card a worktree is for: the id in its branch, or failing that in its path; null for none.
export const cardOf = (branch, wtPath) =>
  ((String(branch || "").match(CARD) || String(wtPath || "").match(CARD) || [])[0] || "").toUpperCase() || null;

// Reads a JSON file. The session often writes files with PowerShell, which may start them with a
// UTF-8 byte-order mark that JSON.parse rejects, so the mark is dropped first (trimStart counts it as white space).
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").trimStart());

// ---- agents ----------------------------------------------------------------------------------

// The skill an agent was started on, from its prompt. A skill started with
// `claude --continue /<skill>` in Git Bash arrives with the slash rewritten into a Windows path
// ("C:/Program Files/Git/preflight").
export const skillOf = a => (String(a?.prompt || "").match(/^(?:\/|[A-Za-z]:\/Program Files\/Git\/)([\w-]+)/) || [])[1] || "";

// The question a waiting agent asks in its terminal, or "".
export const questionOf = a =>
  a?.state === "waiting" && a.programStatus?.kind === "question" ? String(a.programStatus.message || "").replace(/^answer:\s*/, "") : "";

// When `seen` first saw the worktree's agent working on its current prompt. Orca's stateStartedAt
// does not serve: an agent at its prompt with a Monitor running is "working" for hours, and a
// prompt typed into it then leaves stateStartedAt where it was.
function workingSince(seen, key, a, now) {
  if (!a) { seen.delete(key); return 0; }
  const id = a.paneKey + "|" + a.prompt;
  if (seen.get(key)?.id !== id) seen.set(key, { id, since: now });
  return seen.get(key).since;
}

// ---- a preflight run -------------------------------------------------------------------------
//
// preflight records a run with progress.mjs: `start`, then each step's state, then `end`. A run
// is in one of these states:
//   none      no file, or one with no steps;
//   showing   not ended, and either an agent works in the worktree on it or it wrote in the last
//             RUN_FRESH_MS: "Where it stands" shows its phases and the agent counts as preflight;
//   stale     not ended, with nothing showing it is still going: an agent that stopped without
//             `end`. It shows nothing;
//   ended     `end` was recorded: Preflight is done until the code changes after it
//             (codeChangedSincePreflight).

// The steps progress.mjs accepts, and their states. row.js draws them in its RUN_STEPS, apart from
// `ci` (on BloomDesktop the PR's checks are only pr-automation, which starts Devin, and Reviewable).
export const RUN_STEPS = ["discover", "local", "merge", "publish", "devin", "ci", "bots", "tests", "report"];
export const RUN_STATES = ["running", "done", "failed", "skipped"];
export const RUN_FRESH_MS = 45 * 60000;

/**
 * Whether the run shows on the row as preflight going (the "showing" state above). `working` is
 * the agent working in the worktree, as { skill, since }, or null. An agent started on another
 * of DASHBOARD_SKILLS (request-peer-review, merge-without-peer-review) counts only when the run
 * wrote after that agent began working: those skills can hand the work back to preflight, but a
 * run that a stopped preflight left without an end is older than the agent.
 */
export function runShowing(run, working, now = Date.now()) {
  if (!run || run.endedAt || !run.steps) return false;
  const updated = Date.parse(run.updatedAt) || 0;
  if (working) {
    const otherSkill = working.skill && working.skill !== "preflight" && DASHBOARD_SKILLS.includes(working.skill);
    return !(otherSkill && updated < (working.since || 0));
  }
  return now - updated < RUN_FRESH_MS;
}

// Whether any step of the run failed, which means it stopped on something that needs the developer.
export const runFailed = run => Object.values(run?.steps || {}).some(s => s?.state === "failed");

/**
 * What the agents in one worktree (an entry of `orca worktree ps`) are doing, as the page's
 * withLiveAgents (row.js) reads it: { working, waiting, question, skill, since, monitoring, tool,
 * runShowing }. `run` is the worktree's latest preflight run (readProgress), `seen` a Map the
 * caller keeps from one call to the next. `skill` is "preflight" whenever the run shows, since an
 * agent can run preflight without having been started on /preflight (asked in words, or handed on
 * by another skill).
 */
export function liveAgents(w, run, seen, now = Date.now()) {
  const list = w.agents || [];
  const q = list.find(a => questionOf(a));
  // Preflight spends much of its half hour waiting on bots with a Monitor, which Orca reports as
  // working in "monitoring" mode. That counts as preflight still running while the run that
  // progress.mjs records there has not ended; once it ends, the agent is at its prompt.
  const working = list.find(a => agentState(a) === "working")
    || (run && !run.endedAt && list.find(a => a.state === "working" && skillOf(a) === "preflight"));
  const since = workingSince(seen, norm(w.path), working, now);
  const showing = !!working && runShowing(run, { skill: skillOf(working), since }, now);
  return {
    working: !!working,
    waiting: list.some(a => a.state === "waiting"),
    question: q ? questionOf(q) : "",
    skill: showing ? "preflight" : skillOf(working),
    since,
    monitoring: working?.workingMode === "monitoring",
    // A line under a working agent's step when it is waiting on its Monitor. The tool it runs is
    // left out: the developer does not want tool calls on the dashboard.
    tool: working?.workingMode === "monitoring" ? "Waiting on reviewers and CI" : "",
    runShowing: showing,
  };
}

// The `s` of agentEventLines for a worktree's agents, e.g. "done+working", or "none".
export const agentStates = agents => (agents || []).map(agentState).sort().join("+") || "none";

/**
 * The lines server.mjs appends to events.log when agents change state, from two polls of
 * `orca worktree ps`, each a Map of worktree path -> { card, s } (`s` from agentStates).
 */
export function agentEventLines(before, after) {
  const lines = [];
  for (const [p, { card, s }] of after) {
    const was = before.get(p)?.s ?? "none";
    if (was !== s) lines.push(`${card} ${p}: ${was} -> ${s}`);
  }
  for (const [p, { card, s }] of before) if (!after.has(p) && s !== "none") lines.push(`${card} ${p}: ${s} -> worktree gone`);
  return lines;
}

// ---- GitHub ----------------------------------------------------------------------------------

// One word for a PR's CI checks: FAILURE if any failed, PENDING if any have not finished,
// SUCCESS when all passed, "" when it has none. Reviewable's status (code-review/reviewable) is
// left out: it stays PENDING until reviewers have seen every file, which says nothing about CI.
export function checksState(rollup) {
  const results = (rollup || []).filter(c => c.context !== "code-review/reviewable").map(c => c.__typename === "StatusContext" ? c.state : (c.status === "COMPLETED" ? c.conclusion : "PENDING"));
  if (!results.length) return "";
  if (results.some(r => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(r))) return "FAILURE";
  if (results.some(r => ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"].includes(r))) return "PENDING";
  return "SUCCESS";
}

// The preflight report that preflight links from a PR's description ("Preflight report: <url>").
export const reportOf = body => (String(body || "").match(/Preflight report:[^\n]*?(https:\/\/[^\s)\]>]+)/) || [])[1] ?? null;

// The number of decision items in a preflight report's HTML. Each item's options end with a
// "Leave as is" option (preflight's references/report-artifact.md), so this counts those labels;
// the report's own wording of "nothing is waiting" varies from run to run.
export const countDecisions = html => String(html).split(/<[^>]*>/).filter(t => /^\s*Leave as is\s*$/i.test(t)).length;

// countDecisions of the report at `report`, or null when it cannot be read.
export async function reportDecisions(report) {
  try {
    const r = await fetch(report, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(String(r.status));
    return countDecisions(await r.text());
  } catch { return null; }
}

// ---- the code since the last preflight -------------------------------------------------------

// What `codeChangedSincePreflight` needs from a checkout: HEAD's commit, its tree and its commit
// time, and the number of tracked files with uncommitted changes. Untracked files are left out:
// a checkout collects ones that are never committed (.claude/, scratch output). null when git fails.
export async function checkoutState(wt) {
  const git = async (...a) => (await execFileP("git", ["-C", wt, ...a], { windowsHide: true })).stdout.trim();
  try {
    const [head, status] = await Promise.all([
      git("log", "-1", "--format=%H %T %cI"),
      git("status", "--porcelain", "--untracked-files=no"),
    ]);
    const [sha, tree, time] = head.split(" ");
    return { head: sha, tree, headTime: time, uncommitted: status.split(/\r?\n/).filter(Boolean).length };
  } catch { return null; }
}

/**
 * Whether the code has changed since the worktree's last preflight run ended, so that preflight
 * is the next step again: tracked files have uncommitted changes, or HEAD's content is no longer
 * what the run ended on. A run records both its commit (`head`) and that commit's tree (`tree`);
 * the tree is compared when there is one, so a squash or a rebase that leaves the content as it
 * was (request-peer-review squashes the branch) is no change. A run recorded with only its commit
 * compares the commit, and one with neither compares times: a HEAD commit made after the run
 * ended. false while a run is going (its own fixes change the code) and when there is no run or
 * no `checkout` (checkoutState) to compare.
 */
export function codeChangedSincePreflight(run, checkout) {
  if (!run?.endedAt || !checkout) return false;
  if (checkout.uncommitted > 0) return true;
  if (run.tree && checkout.tree) return checkout.tree !== run.tree;
  if (run.head) return checkout.head !== run.head;
  return !!checkout.headTime && Date.parse(checkout.headTime) > Date.parse(run.endedAt);
}

// ---- files the dashboard keeps ---------------------------------------------------------------

// The file progress.mjs writes a checkout's preflight run to.
export const progressFile = worktree =>
  path.join(progressDir(), norm(worktree).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".json");

// Each worktree's latest preflight run, from the files progress.mjs writes, keyed by norm() of its path.
export function readProgress() {
  const runs = new Map();
  let files = [];
  try { files = fs.readdirSync(progressDir()); } catch { return runs; }
  for (const f of files) {
    try {
      const run = readJson(path.join(progressDir(), f));
      if (run.worktree) runs.set(norm(run.worktree), run);
    } catch {}
  }
  return runs;
}

// ---- the rows the session writes -------------------------------------------------------------
//
// The session writes rows/<card>.json (dashboard SKILL.md, step 4) and the server adds the rest.
// A row that breaks these rules would draw wrong or not at all (a row with an unknown group is in
// no table), so the server reports each problem to the page and to events.log instead.

export const GROUPS = ["near", "nopr", "large", "cleanup"];
// `who` as the session writes it; the page sets "asking" and "agent" itself from Orca.
export const SESSION_WHO = ["you", "idle"];
export const NEXT_SKILLS = ["preflight", "request-peer-review"];
// The fields that the server adds to a row (enrichRows) and the page adds from Orca
// (withLiveAgents), which the session leaves out.
export const DERIVED_FIELDS = ["prState", "prMergeable", "prChecks", "approvedPlan", "ownReview", "progress", "codeChanged", "runShowing", "skill", "since", "tool", "question"];

/** What is wrong with a row the session wrote, as short phrases; [] for none. */
export function rowProblems(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["is not a JSON object"];
  const problems = [];
  if (typeof row.card !== "string" || !row.card) problems.push("has no card");
  if (!GROUPS.includes(row.group)) problems.push(`has group ${JSON.stringify(row.group)}, not one of ${GROUPS.join(", ")}, so it is in no table`);
  if (row.who != null && !SESSION_WHO.includes(row.who)) problems.push(`has who ${JSON.stringify(row.who)}, not one of ${SESSION_WHO.join(", ")}`);
  if (row.nextSkill && !NEXT_SKILLS.includes(row.nextSkill)) problems.push(`has nextSkill ${JSON.stringify(row.nextSkill)}, not one of ${NEXT_SKILLS.join(", ")}`);
  if (row.order != null && typeof row.order !== "number") problems.push("has an order that is not a number");
  if (row.pr && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(row.pr)) problems.push(`has pr ${JSON.stringify(row.pr)}, which is not a GitHub PR URL`);
  if (row.worktree != null && typeof row.worktree !== "string") problems.push("has a worktree that is not a path");
  const derived = DERIVED_FIELDS.filter(f => f in row);
  if (derived.length) problems.push(`sets ${derived.join(", ")}, which the dashboard works out itself`);
  return problems;
}

/**
 * The rows the session wrote, and what is wrong with them: { rows, problems }, each problem
 * { card, file, problem }. A file that is not JSON is a problem and no row. A row's time is when
 * its file was written, not the `updated` the session typed into it, which a session can get wrong.
 */
export function readRowFiles() {
  const rows = [], problems = [];
  let files = [];
  try { files = fs.readdirSync(rowsDir()); } catch { return { rows, problems }; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(rowsDir(), f);
    let row;
    try {
      row = readJson(file);
    } catch (e) {
      problems.push({ card: f.slice(0, -5), file: f, problem: "is not valid JSON: " + e.message.split("\n")[0] });
      continue;
    }
    for (const problem of rowProblems(row)) problems.push({ card: (typeof row?.card === "string" && row.card) || f.slice(0, -5), file: f, problem });
    if (row && typeof row === "object" && !Array.isArray(row)) rows.push({ ...row, updated: fs.statSync(file).mtime.toISOString() });
  }
  return { rows, problems };
}
export const readRows = () => readRowFiles().rows;

// The row of a worktree: matched by its path, not by the card id in its branch, since a PR's
// branch can name another card. A row with no path is found by the branch's card.
export function rowOfWorktree(rows, worktree, branchCard) {
  return rows.find(r => r.worktree && norm(r.worktree) === norm(worktree))
    ?? rows.find(r => !r.worktree && branchCard && r.card === branchCard)
    ?? null;
}

/**
 * The next skill and status for a worktree's PR, worked out from the PR and its preflight run
 * the way the session decides them (SKILL.md, step 3): a report that lists decisions waits on
 * the developer; preflight is done when its last run ended with no failed step and the code has
 * not changed since; otherwise preflight is next. `pr` is { url, report, reportDecisions } or null.
 */
export function nextFromFacts(pr, run, checkout) {
  if (!pr) return { who: "idle", nextSkill: null };
  const n = pr.reportDecisions;
  if (n > 0) return { who: "you", nextSkill: "preflight", next: `The preflight report lists ${n} decision${n > 1 ? "s" : ""} for you.` };
  const done = !!(run?.endedAt && !runFailed(run) && checkout && !codeChangedSincePreflight(run, checkout));
  return { who: "idle", nextSkill: done ? "request-peer-review" : "preflight" };
}

/**
 * The Worktree panel's row for a worktree that the session wrote no row for, made from the card
 * (YouTrack: { url, summary }) and the PR (GitHub: { url, report, reportDecisions }).
 */
export function rowFromFacts({ cardId, card, pr, run, checkout, worktree, title }) {
  return {
    card: cardId,
    cardUrl: card?.url ?? null,
    title: card?.summary || title,
    ...nextFromFacts(pr, run, checkout),
    pr: pr?.url ?? null,
    report: pr?.report ?? null,
    reportDecisions: pr?.reportDecisions ?? null,
    worktree,
  };
}

/**
 * The Worktree panel's row: the one the session wrote (`row`), or with none, rowFromFacts. The
 * panel reads the worktree's PR live, so when that is another PR than the row's (the row's was
 * closed and a new one opened since the session wrote it), the PR's link, report and next step
 * come from the live PR and the row's judgement about the old one is dropped.
 */
export function panelRow({ row, ...facts }) {
  const made = rowFromFacts(facts);
  if (!row) return made;
  const d = { ...row, worktree: facts.worktree };
  if (facts.pr && row.pr !== facts.pr.url) {
    delete d.next;
    for (const k of ["pr", "report", "reportDecisions", "who", "nextSkill", "next"]) if (made[k] != null) d[k] = made[k];
  }
  return d;
}

/**
 * Adds to each row what the page draws besides what the session wrote: the PR's state
 * (`prState`, "draft" or "open"), mergeability and CI (`prMergeable`, `prChecks`) from `facts.prs`,
 * whether the card has the "Approved Plan" tag (`approvedPlan`) from `facts.cards`, the
 * developer's own review of the PR (`ownReview`, from `ownReviews`, PR URL -> own-review.mjs's
 * answer), the worktree's latest preflight run (`progress`), whether that run shows as going with
 * no agent working there (`runShowing`; withLiveAgents in row.js takes the live answer when one
 * works), and whether the code has changed since that run (`codeChanged`, from `checkouts`,
 * norm() of the worktree path -> checkoutState). A PR not among `facts.prs` (merged or closed) is
 * left to the page.
 */
export function enrichRows(rows, facts, ownReviews = new Map(), runs = readProgress(), checkouts = new Map(), now = Date.now()) {
  const prFacts = new Map((facts?.prs || []).map(p => [p.url, p]));
  const approved = new Set((facts?.cards || []).filter(c => c.approvedPlan).map(c => c.id));
  for (const r of rows) {
    const p = prFacts.get(r.pr);
    if (p) { r.prState = p.isDraft ? "draft" : "open"; r.prMergeable = p.mergeable; r.prChecks = p.checks; }
    r.approvedPlan = approved.has(r.card);
    if (ownReviews.has(r.pr)) r.ownReview = ownReviews.get(r.pr);
    const key = norm(r.worktree);
    if (r.worktree && runs.has(key)) r.progress = runs.get(key);
    r.runShowing = runShowing(r.progress, null, now);
    r.codeChanged = codeChangedSincePreflight(r.progress, r.worktree ? checkouts.get(key) : null);
  }
  return rows;
}
