#!/usr/bin/env node
// Records how far a preflight run has got, for the dashboard's "Where it stands" stepper.
//
//   node progress.mjs start                    a new run: forgets the last run's steps
//   node progress.mjs <step> <state> [note]    one step's state, with an optional short note
//   node progress.mjs end                      the run is over
//
// <step> is one of RUN_STEPS in row-facts.mjs; <state> is running, done, failed or skipped. The
// run belongs to the git checkout of the current folder (or --worktree <path>). It writes
// ~/.claude/bloom-dashboard/progress/<checkout>.json, which the dashboard server reads; row-facts.mjs
// describes the states a run goes through. `end` also records the commit the run ended on (`head`)
// and its tree (`tree`), which tell the dashboard whether the code has changed since. `end` leaves
// a run that already ended alone, so request-peer-review and merge-without-peer-review can close a
// run that preflight left open without moving its end. It never fails the caller: a problem
// prints a warning and exits 0. The one exception is `walkaround done`, which exits 1 unless the
// walkaround skill's record.mjs has recorded the working copy exactly as it stands now; with no
// note, the step takes the summary from that record.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { RUN_STATES, RUN_STEPS, norm, progressDir, progressFile } from "./row-facts.mjs";
import { readRecord, workingTree } from "../walkaround/record.mjs";

try {
  const args = process.argv.slice(2);
  const wtArg = args.indexOf("--worktree");
  let worktree = wtArg >= 0 ? args.splice(wtArg, 2)[1] : "";
  if (!worktree) worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const key = norm(worktree);
  fs.mkdirSync(progressDir(), { recursive: true });
  const file = progressFile(key);
  const now = new Date().toISOString();
  const [step, state, ...noteWords] = args;
  let run = {};
  try { run = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (step === "start") run = { worktree: key, startedAt: now, steps: {} };
  else if (step === "end") {
    if (run.endedAt || !run.startedAt) process.exit(0);
    run.endedAt = now;
    try {
      const [head, tree] = execFileSync("git", ["-C", worktree, "log", "-1", "--format=%H %T"], { encoding: "utf8" }).trim().split(" ");
      Object.assign(run, { head, tree });
    } catch {}
  }
  else if (RUN_STEPS.includes(step) && RUN_STATES.includes(state)) {
    if (step === "walkaround" && state === "done") {
      const record = readRecord(worktree);
      if (!record || record.tree !== workingTree(worktree)) {
        console.error(
          "progress.mjs: no walkaround has read this code. Run the walkaround skill on this " +
            "checkout; its last step (record.mjs) records the code it read, and then " +
            "`walkaround done` is accepted until the code changes again.",
        );
        process.exit(1);
      }
      if (noteWords.length === 0) noteWords.push(record.summary);
    }
    run.worktree ??= key;
    run.steps ??= {};
    run.steps[step] = { state, note: noteWords.join(" "), at: now };
  } else {
    console.warn(`progress.mjs: expected start, end, or one of ${RUN_STEPS.join("/")} then ${RUN_STATES.join("/")}`);
    process.exit(0);
  }
  run.updatedAt = now;
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
} catch (e) {
  console.warn("progress.mjs: " + e.message);
}
