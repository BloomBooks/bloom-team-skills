// Opens what a stale worktree's warning details list (stale-worktrees.mjs) in VS Code: an
// uncommitted file beside its committed version, or one commit's diff. git writes the committed
// side to a folder under the system's temp folder, since `code --diff` compares two files on disk.
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quote } from "../../orca-worktrees.mjs";
import { statusEntries } from "./stale-worktrees.mjs";

const execP = promisify(exec);
const execFileP = promisify(execFile);
const git = async (wt, args, encoding = "utf8") =>
  (await execFileP("git", ["-C", wt, ...args], { windowsHide: true, maxBuffer: 64 << 20, encoding })).stdout;
// `code` is a .cmd file on Windows, which only a shell runs.
const code = (...args) => execP(["code", ...args.map(quote)].join(" "), { cwd: os.homedir(), windowsHide: true, timeout: 30_000 });
const scratch = () => {
  const dir = path.join(os.tmpdir(), "bloom-dashboard-changes", crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// An uncommitted file in the worktree `wt`, as `git status` names it. A new file opens by itself, a
// deleted one shows its committed version, and any other shows beside its committed version.
export async function openChange(wt, file) {
  file = String(file || "");
  if (!file || path.isAbsolute(file) || file.split("/").includes("..")) throw new Error("not a file in the worktree: " + file);
  const entry = statusEntries(await git(wt, ["status", "--porcelain", "-z"])).find(e => e.file === file);
  if (!entry) throw new Error(`${file} has no uncommitted change now; press Refresh`);
  const here = path.join(wt, file);
  if (entry.status === "??" || entry.status[0] === "A") { await code(here); return "Opened " + file + " in VS Code."; }
  const committed = path.join(scratch(), "HEAD " + path.basename(entry.from || file));
  fs.writeFileSync(committed, await git(wt, ["show", "HEAD:" + (entry.from || file)], "buffer"));
  if (entry.status.includes("D")) { await code(committed); return "Opened the committed version of " + file + " in VS Code."; }
  await code("--diff", committed, here);
  return "Opened the change to " + file + " in VS Code.";
}

// A commit in the worktree `wt`: its message, the files it changed and its diff, as a .diff file.
export async function openCommit(wt, commit) {
  commit = String(commit || "");
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw new Error("not a commit: " + commit);
  const diff = path.join(scratch(), commit + ".diff");
  fs.writeFileSync(diff, await git(wt, ["show", "--stat", "--patch", "--format=fuller", commit, "--"], "buffer"));
  await code(diff);
  return "Opened commit " + commit + " in VS Code.";
}
