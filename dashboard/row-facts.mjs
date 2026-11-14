// Small facts that the dashboard service (service/service.mjs), the gather (gather.mjs) and
// progress.mjs work out the same way: the card a worktree is for, a waiting agent's question, a
// PR's CI checks, the preflight report linked from a PR, and where a preflight run's progress
// record is kept. Every rule here is a plain function of its arguments, apart from the readers of
// the dashboard's files, so row-facts.test.mjs tests them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentState, norm } from "../orca-worktrees.mjs";

export { agentState, norm };

// The folders are worked out each time they are used, so that a test can point the home folder
// at a temporary one.
export const dataDir = () => path.join(os.homedir(), ".claude", "bloom-dashboard");
export const progressDir = () => path.join(dataDir(), "progress");
export const CARD = /\bBL-\d+/i;

// The card a worktree is for: the id in its branch, or failing that in its path; null for none.
export const cardOf = (branch, wtPath) =>
  ((String(branch || "").match(CARD) || String(wtPath || "").match(CARD) || [])[0] || "").toUpperCase() || null;

// Reads a JSON file. The session often writes files with PowerShell, which may start them with a
// UTF-8 byte-order mark that JSON.parse rejects, so the mark is dropped first (trimStart counts it as white space).
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").trimStart());

// ---- agents ----------------------------------------------------------------------------------

// The question a waiting agent asks in its terminal, or "".
export const questionOf = a =>
  a?.state === "waiting" && a.programStatus?.kind === "question" ? String(a.programStatus.message || "").replace(/^answer:\s*/, "") : "";

// ---- a preflight run -------------------------------------------------------------------------

// The steps progress.mjs accepts, and their states. row.js draws them in its RUN_STEPS, apart from
// `ci` (on BloomDesktop the PR's checks are only pr-automation, which starts Devin, and Reviewable).
export const RUN_STEPS = ["discover", "local", "walkaround", "merge", "publish", "devin", "ci", "bots", "tests", "report"];
export const RUN_STATES = ["running", "done", "failed", "skipped"];

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

// Where preflight publishes its reports (dev-process-artifacts.md). A PR's description is written
// by whoever opened the PR, so the dashboard fetches a report only from here, and follows no
// redirect: anything else in a "Preflight report:" line would have the developer's machine
// request an address that the PR's author chose.
export const REPORT_HOME = "https://bloombooks.github.io/dev-process-artifacts/";
export const reportReadable = url => typeof url === "string" && url.startsWith(REPORT_HOME) && !url.includes("..");

// countDecisions of the report at `report`, or null when it cannot be read or is not one of
// preflight's (reportReadable).
export async function reportDecisions(report) {
  if (!reportReadable(report)) return null;
  try {
    const r = await fetch(report, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(String(r.status));
    return countDecisions(await r.text());
  } catch { return null; }
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
