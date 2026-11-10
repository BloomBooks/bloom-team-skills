// The facts about a card's row that the dashboard server (server.mjs), the gather (gather.mjs),
// progress.mjs and the Worktree panel's worker (worktree-panel/worktree-facts.mjs) all work out
// the same way: what Orca's agents in a worktree are doing, a PR's CI checks, a preflight run's
// progress file, the rows the session wrote, and what the server adds to a row before the page
// draws it (row.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const dataDir = path.join(os.homedir(), ".claude", "bloom-dashboard");
export const rowsDir = path.join(dataDir, "rows");
export const progressDir = path.join(dataDir, "progress");
export const CARD = /\bBL-\d+/i;

export const norm = p => (p || "").replace(/\\/g, "/").toLowerCase();

// Reads a JSON file. The session often writes files with PowerShell, which may start them with a
// UTF-8 byte-order mark that JSON.parse rejects, so the mark is dropped first (trimStart counts it as white space).
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").trimStart());

// ---- agents ----------------------------------------------------------------------------------

// An agent's state as the dashboard counts it. Orca calls an agent "working" while a background
// Monitor runs in it (workingMode "monitoring"), though it sits at its prompt; that counts as done.
export const agentState = a => a.state === "working" && a.workingMode === "monitoring" ? "done" : a.state;

// The skill an agent was started on, from its prompt. A skill started with
// `claude --continue /<skill>` in Git Bash arrives with the slash rewritten into a Windows path
// ("C:/Program Files/Git/preflight").
export const skillOf = a => (String(a?.prompt || "").match(/^(?:\/|[A-Za-z]:\/Program Files\/Git\/)([\w-]+)/) || [])[1] || "";

// When `seen` first saw the worktree's agent working on its current prompt. Orca's stateStartedAt
// does not serve: an agent at its prompt with a Monitor running is "working" for hours, and a
// prompt typed into it then leaves stateStartedAt where it was.
function workingSince(seen, p, a) {
  if (!a) { seen.delete(p); return 0; }
  const id = a.paneKey + "|" + a.prompt;
  if (seen.get(p)?.id !== id) seen.set(p, { id, since: Date.now() });
  return seen.get(p).since;
}

/**
 * What the agents in one worktree (an entry of `orca worktree ps`) are doing, as the page's
 * withLiveAgents (row.js) reads it: { working, waiting, question, skill, since, monitoring, tool }.
 * `run` is the worktree's latest preflight run (readProgress), `seen` a Map the caller keeps from
 * one call to the next.
 */
export function liveAgents(w, run, seen) {
  const list = w.agents || [];
  const q = list.find(a => a.state === "waiting" && a.programStatus?.kind === "question");
  // Preflight spends much of its half hour waiting on bots with a Monitor, which Orca reports as
  // working in "monitoring" mode. That counts as preflight still running while the run that
  // progress.mjs records there has not ended; once it ends, the agent is at its prompt.
  const working = list.find(a => agentState(a) === "working")
    || (run && !run.endedAt && list.find(a => a.state === "working" && skillOf(a) === "preflight"));
  return {
    working: !!working,
    waiting: list.some(a => a.state === "waiting"),
    question: q ? String(q.programStatus.message || "").replace(/^answer:\s*/, "") : "",
    skill: skillOf(working),
    since: workingSince(seen, norm(w.path), working),
    monitoring: working?.workingMode === "monitoring",
    // A line under a working agent's step when it is waiting on its Monitor. The tool it runs is
    // left out: the developer does not want tool calls on the dashboard.
    tool: working?.workingMode === "monitoring" ? "Waiting on reviewers and CI" : "",
  };
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

// The number of decision items in a preflight report. Each item's options end with a
// "Leave as is" option (preflight's references/report-artifact.md), so this counts those labels;
// the report's own wording of "nothing is waiting" varies from run to run. null when the report
// cannot be read.
export async function reportDecisions(report) {
  try {
    const r = await fetch(report, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.text()).split(/<[^>]*>/).filter(t => /^\s*Leave as is\s*$/i.test(t)).length;
  } catch { return null; }
}

// ---- the code since the last preflight -------------------------------------------------------

// What `codeChangedSincePreflight` needs from a checkout: HEAD's commit and commit time, and the
// number of tracked files with uncommitted changes. Untracked files are left out: a checkout
// collects ones that are never committed (.claude/, scratch output). null when git fails.
export async function checkoutState(wt) {
  const git = async (...a) => (await execFileP("git", ["-C", wt, ...a], { windowsHide: true })).stdout.trim();
  try {
    const [head, status] = await Promise.all([
      git("log", "-1", "--format=%H %cI"),
      git("status", "--porcelain", "--untracked-files=no"),
    ]);
    const [sha, time] = head.split(" ");
    return { head: sha, headTime: time, uncommitted: status.split(/\r?\n/).filter(Boolean).length };
  } catch { return null; }
}

/**
 * Whether the code has changed since the worktree's last preflight run ended, so that preflight
 * is the next step again: HEAD is no longer the commit the run ended on, or tracked files have
 * uncommitted changes. A run recorded without its commit is compared by time instead: a HEAD
 * commit made after the run ended. false while a run is going (its own fixes change the code) and
 * when there is no run or no `checkout` (checkoutState) to compare.
 */
export function codeChangedSincePreflight(run, checkout) {
  if (!run?.endedAt || !checkout) return false;
  if (checkout.uncommitted > 0) return true;
  if (run.head) return checkout.head !== run.head;
  return !!checkout.headTime && Date.parse(checkout.headTime) > Date.parse(run.endedAt);
}

// ---- files the dashboard keeps ---------------------------------------------------------------

// The file progress.mjs writes a checkout's preflight run to.
export const progressFile = worktree =>
  path.join(progressDir, norm(worktree).replace(/\/$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".json");

// Each worktree's latest preflight run, from the files progress.mjs writes, keyed by its path.
export function readProgress() {
  const runs = new Map();
  let files = [];
  try { files = fs.readdirSync(progressDir); } catch { return runs; }
  for (const f of files) {
    try {
      const run = readJson(path.join(progressDir, f));
      if (run.worktree) runs.set(norm(run.worktree), run);
    } catch {}
  }
  return runs;
}

// The rows the session wrote. A row's time is when its file was written, not the `updated` the
// session typed into it, which a session can get wrong.
export function readRows() {
  const rows = [];
  let files = [];
  try { files = fs.readdirSync(rowsDir); } catch { return rows; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const file = path.join(rowsDir, f);
      rows.push({ ...readJson(file), updated: fs.statSync(file).mtime.toISOString() });
    } catch {}
  }
  return rows;
}

// The row of a worktree: matched by its path, not by the card id in its branch, since a PR's
// branch can name another card. A row with no path is found by the branch's card.
export function rowOfWorktree(rows, worktree, branchCard) {
  return rows.find(r => r.worktree && norm(r.worktree).replace(/\/$/, "") === norm(worktree).replace(/\/$/, ""))
    ?? rows.find(r => !r.worktree && branchCard && r.card === branchCard)
    ?? null;
}

/**
 * Adds to each row what the page draws besides what the session wrote: the PR's state
 * (`prState`, "draft" or "open"), mergeability and CI (`prMergeable`, `prChecks`) from `facts.prs`,
 * whether the card has the "Approved Plan" tag (`approvedPlan`) from `facts.cards`, the
 * developer's own review of the PR (`ownReview`, from `ownReviews`, PR URL -> own-review.mjs's
 * answer), the worktree's latest preflight run (`progress`), and whether the code has changed
 * since that run (`codeChanged`, from `checkouts`, worktree path as norm() gives it ->
 * checkoutState). A PR not among `facts.prs` (merged or closed) is left to the page.
 */
export function enrichRows(rows, facts, ownReviews = new Map(), runs = readProgress(), checkouts = new Map()) {
  const prFacts = new Map((facts?.prs || []).map(p => [p.url, p]));
  const approved = new Set((facts?.cards || []).filter(c => c.approvedPlan).map(c => c.id));
  for (const r of rows) {
    const p = prFacts.get(r.pr);
    if (p) { r.prState = p.isDraft ? "draft" : "open"; r.prMergeable = p.mergeable; r.prChecks = p.checks; }
    r.approvedPlan = approved.has(r.card);
    if (ownReviews.has(r.pr)) r.ownReview = ownReviews.get(r.pr);
    const key = norm(r.worktree).replace(/\/+$/, "");
    if (r.worktree && runs.has(key)) r.progress = runs.get(key);
    r.codeChanged = codeChangedSincePreflight(r.progress, r.worktree ? checkouts.get(key) : null);
  }
  return rows;
}
