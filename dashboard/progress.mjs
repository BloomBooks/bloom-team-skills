#!/usr/bin/env node
// Records how far a preflight run has got, for the dashboard's "Where it stands" stepper.
//
//   node progress.mjs start                    a new run: forgets the last run's steps
//   node progress.mjs <step> <state> [note]    one step's state, with an optional short note
//   node progress.mjs end                      the run is over
//
// <step> is one of RUN_STEPS in row-facts.mjs; <state> is running, done, failed or skipped. The
// run belongs to the git checkout of the current folder (or --worktree <path>). It writes
// ~/.claude/bloom-dashboard/progress/<checkout>.json and then tells the dashboard service, which
// reads the file (service/runs.mjs describes the states a run goes through). The file is the
// record: a service that is not running reads it when it starts. `start` records the Claude Code
// session that runs the skill. `end` also records the commit the run ended on (`head`) and its
// tree (`tree`), which tell the dashboard whether the code has changed since, and leaves a run
// that already ended alone. It never fails the caller: a problem
// prints a warning and exits 0. The one exception is `walkaround done`, which exits 1 unless the
// walkaround skill's record.mjs has recorded the working copy exactly as it stands now; with no
// note, the step takes the summary from that record.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RUN_STATES, RUN_STEPS, dataDir, norm, progressDir, progressFile } from "./row-facts.mjs";
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
  if (step === "start") run = { worktree: key, session: process.env.CLAUDE_CODE_SESSION_ID || null, startedAt: now, steps: {} };
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
  // The service also watches the folder; this reaches it sooner, and costs at most half a second.
  try {
    const key = fs.readFileSync(path.join(dataDir(), "service.key"), "utf8").trim();
    await fetch(`http://127.0.0.1:${Number(process.env.BLOOM_DASHBOARD_PORT || 47600)}/tell`, {
      method: "POST", headers: { "content-type": "application/json", "x-bloom-key": key },
      body: JSON.stringify({ kind: "progress", worktree: run.worktree }), signal: AbortSignal.timeout(500),
    });
  } catch {}
} catch (e) {
  console.warn("progress.mjs: " + e.message);
}
