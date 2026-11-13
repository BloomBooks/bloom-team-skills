#!/usr/bin/env node
// Records that a walkaround has read a checkout's code as it stands now.
//
//   node record.mjs "<one-line summary of the walkaround's report>"
//
// Run from inside the checkout (or pass --worktree <path>) as the walkaround's last step, after its
// fixes and fast checks. It writes ~/.claude/walkaround/<checkout>.json holding the HEAD, the tree
// of the working copy (uncommitted and untracked files included, ignored files left out) and the
// summary. dashboard/progress.mjs refuses `walkaround done` for a checkout whose working copy no
// longer has that tree, so a walkaround that never ran on this code cannot be reported as done.
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

/** The checkout's last walkaround record, or null when it has none. */
export function readRecord(worktree) {
  try { return JSON.parse(fs.readFileSync(recordFile(worktree), "utf8")); } catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const wtArg = args.indexOf("--worktree");
  const worktree = topOf(wtArg >= 0 ? args.splice(wtArg, 2)[1] : "");
  const summary = args.join(" ").trim();
  if (!summary) {
    console.error('record.mjs: give a one-line summary, e.g. node record.mjs "2 changes, 1 proposal"');
    process.exit(1);
  }
  const record = {
    worktree,
    head: git(worktree, ["rev-parse", "HEAD"]),
    tree: workingTree(worktree),
    summary,
    at: new Date().toISOString(),
  };
  const file = recordFile(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`walkaround recorded for ${worktree} at tree ${record.tree.slice(0, 10)}`);
}
