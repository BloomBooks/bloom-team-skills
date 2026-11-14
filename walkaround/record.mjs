#!/usr/bin/env node
// Records that a walkaround has read a checkout's code as it stands now.
//
//   node record.mjs --simplify ran "<one-line summary of the walkaround's report>"
//   node record.mjs --simplify not-needed "<why /simplify was skipped>" "<one-line summary>"
//   node record.mjs --check     exits 1 unless a finished walkaround has recorded the code as it stands
//
// Run from inside the checkout (or pass --worktree <path>) as the walkaround's last step, after its
// fixes and fast checks. It writes ~/.claude/walkaround/<checkout>.json holding the HEAD, the tree
// of the working copy (uncommitted and untracked files included, ignored files left out), the
// summary, and whether /simplify ran (`simplify: { status, reason }`). It refuses without
// --simplify, because a walkaround whose /simplify could not run is not finished and is not
// recorded. dashboard/progress.mjs refuses `walkaround done`, and request-peer-review and
// merge-without-peer-review bounce to preflight (through --check), for a checkout whose working
// copy no longer has that tree (apart from later merges that git made with no hand edits), or whose
// record does not say that /simplify ran or was not needed, so a walkaround that never ran on this
// code cannot be reported as done.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const git = (worktree, args, env) =>
  execFileSync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    // Git's line-ending warnings would bury the result; on failure stderr is in the thrown error.
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** The checkout's top folder, for the folder the caller names or the current one. */
export const topOf = worktree => git(worktree || ".", ["rev-parse", "--show-toplevel"]);

/**
 * The git tree id of the working copy as it stands, staged or not, untracked files included.
 * Built in a copy of the index, so the checkout's own staging is left alone.
 */
export function workingTree(worktree) {
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]);
  const tempIndex = path.join(os.tmpdir(), `walkaround-index-${process.pid}-${Date.now()}`);
  try {
    const index = path.join(gitDir, "index");
    if (fs.existsSync(index)) fs.copyFileSync(index, tempIndex);
    const env = { GIT_INDEX_FILE: tempIndex };
    git(worktree, ["add", "-A"], env);
    return git(worktree, ["write-tree"], env);
  } finally {
    fs.rmSync(tempIndex, { force: true });
  }
}

/** Where the record for a checkout lives. */
export const recordFile = worktree =>
  path.join(os.homedir(), ".claude", "walkaround",
    topOf(worktree).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".json");

/** The values of a record's `simplify.status` that let `walkaround done` through. */
const SIMPLIFY_STATUSES = ["ran", "not-needed"];

/** The checkout's last walkaround record, or null when it has none. */
export function readRecord(worktree) {
  try { return JSON.parse(fs.readFileSync(recordFile(worktree), "utf8")); } catch { return null; }
}

/**
 * Whether the code as it stands is the code that a record with this tree read: the same working
 * tree, or a clean working copy whose commits since that tree are merges that git made with no
 * hand edits. Preflight merges the base after its walkaround; such a merge leaves the PR's own
 * diff as the walkaround read it.
 */
function matchesRecord(worktree, recordTree) {
  const tree = workingTree(worktree);
  if (tree === recordTree) return true;
  if (tree !== git(worktree, ["rev-parse", "HEAD^{tree}"])) return false;
  let commit = "HEAD";
  for (;;) {
    const [own, ...parents] = git(worktree, ["log", "-1", "--format=%T %P", commit]).split(" ");
    if (own === recordTree) return true;
    if (parents.length !== 2) return false;
    let merged;
    // Exits 1 on a conflict, which needed a hand edit.
    try { merged = git(worktree, ["merge-tree", "--write-tree", ...parents]).split("\n")[0]; } catch { return false; }
    if (merged !== own) return false;
    commit = parents[0];
  }
}

/**
 * The checkout's record when a finished walkaround has read its code as it stands now, else
 * `{ problem }` saying what is missing.
 */
export function finishedRecord(worktree) {
  const record = readRecord(worktree);
  if (!record || !matchesRecord(worktree, record.tree)) {
    return {
      problem: "no walkaround has read this code. Run the walkaround skill on this checkout; its " +
        "last step (record.mjs) records the code it read.",
    };
  }
  if (!SIMPLIFY_STATUSES.includes(record.simplify?.status)) {
    return {
      problem: "the walkaround record does not say that /simplify ran or was not needed. /simplify " +
        "is a required step of the walkaround; when it cannot run, the walkaround is incomplete: " +
        "stop and ask the developer.",
    };
  }
  return { record };
}

/** What a finished record says about /simplify, for a note. */
export const simplifyNote = ({ simplify }) =>
  simplify.status === "ran" ? "(/simplify ran)" : `(/simplify not needed: ${simplify.reason})`;

// Compared by real path, so the CLI also runs through the ~/.claude/skills symlink.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const wtArg = args.indexOf("--worktree");
  const worktree = topOf(wtArg >= 0 ? args.splice(wtArg, 2)[1] : "");
  if (args.includes("--check")) {
    const { record, problem } = finishedRecord(worktree);
    if (problem) {
      console.error(`record.mjs: ${problem}`);
      process.exit(1);
    }
    console.log(`walkaround recorded for this code: ${record.summary} ${simplifyNote(record)}`);
    process.exit(0);
  }
  const simplifyArg = args.indexOf("--simplify");
  const status = simplifyArg >= 0 ? args[simplifyArg + 1] : undefined;
  const reason = status === "not-needed" ? (args[simplifyArg + 2] ?? "").trim() : undefined;
  if (!SIMPLIFY_STATUSES.includes(status) || reason === "") {
    console.error(
      "record.mjs: say whether /simplify ran: --simplify ran, or --simplify not-needed \"<reason>\". " +
        "A walkaround whose /simplify could not run is not finished: do not record it; stop and " +
        "ask the developer.",
    );
    process.exit(1);
  }
  args.splice(simplifyArg, status === "not-needed" ? 3 : 2);
  const summary = args.join(" ").trim();
  if (!summary) {
    console.error('record.mjs: give a one-line summary, e.g. node record.mjs --simplify ran "2 changes, 1 proposal"');
    process.exit(1);
  }
  const record = {
    worktree,
    head: git(worktree, ["rev-parse", "HEAD"]),
    tree: workingTree(worktree),
    summary,
    simplify: reason === undefined ? { status } : { status, reason },
    at: new Date().toISOString(),
  };
  const file = recordFile(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`walkaround recorded for ${worktree} at tree ${record.tree.slice(0, 10)}`);
}
