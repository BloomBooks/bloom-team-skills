#!/usr/bin/env node
// Records how far a preflight run has got, for the dashboard's "Where it stands" stepper.
//
//   node progress.mjs start                    a new run: forgets the last run's steps
//   node progress.mjs <step> <state> [note]    one step's state, with an optional short note
//   node progress.mjs end                      the run is over
//
// <step> is one of STEPS below; <state> is running, done, failed or skipped. The run belongs to
// the git checkout of the current folder (or --worktree <path>). It writes
// ~/.claude/bloom-dashboard/progress/<checkout>.json, which the dashboard server reads.
// `end` also records the commit the run ended on (`head`), which tells the dashboard whether the
// code has changed since. It never fails the caller: a problem prints a warning and exits 0.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { progressDir, progressFile } from "./row-facts.mjs";

export const STEPS = ["discover", "local", "merge", "publish", "devin", "ci", "bots", "tests", "report"];
const STATES = ["running", "done", "failed", "skipped"];

try {
  const args = process.argv.slice(2);
  const wtArg = args.indexOf("--worktree");
  let worktree = wtArg >= 0 ? args.splice(wtArg, 2)[1] : "";
  if (!worktree) worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const key = worktree.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  fs.mkdirSync(progressDir, { recursive: true });
  const file = progressFile(key);
  const now = new Date().toISOString();
  const [step, state, ...noteWords] = args;
  let run = {};
  try { run = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (step === "start") run = { worktree: key, startedAt: now, steps: {} };
  else if (step === "end") {
    // A run that already ended keeps its end time and commit, so request-peer-review and
    // merge-without-peer-review can close a run that preflight left open without moving either.
    if (run.endedAt || !run.startedAt) process.exit(0);
    run.endedAt = now;
    // The commit the run ended on. A different HEAD later means the code has moved on since.
    try { run.head = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  }
  else if (STEPS.includes(step) && STATES.includes(state)) {
    run.worktree ??= key;
    run.steps ??= {};
    run.steps[step] = { state, note: noteWords.join(" "), at: now };
  } else {
    console.warn(`progress.mjs: expected start, end, or one of ${STEPS.join("/")} then ${STATES.join("/")}`);
    process.exit(0);
  }
  run.updatedAt = now;
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
} catch (e) {
  console.warn("progress.mjs: " + e.message);
}
