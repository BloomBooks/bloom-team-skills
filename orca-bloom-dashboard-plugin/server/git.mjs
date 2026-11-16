// A worktree's git state, read when something says it may have changed: a file watch on the
// worktree's git folder (a commit, a checkout, a staged file), a tool call in a session there, or
// a timer while a surface shows the worktree. Each read starts four or five git processes, so
// nothing reads on a short timer.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const git = async (wt, ...args) => (await execFileP("git", ["-C", wt, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 16 << 20 })).stdout.trim();

const bases = new Map();   // worktree -> its base branch, e.g. "origin/master"
async function baseOf(wt) {
  if (!bases.has(wt)) bases.set(wt, await git(wt, "rev-parse", "--abbrev-ref", "origin/HEAD").catch(() => "origin/master"));
  return bases.get(wt);
}

/**
 * What the row and the panel need from a checkout:
 *   head, tree, headTime   HEAD's commit, its tree, and its commit time
 *   uncommitted            tracked files with uncommitted changes (what makes preflight stale)
 *   untracked              untracked files (the panel counts them as uncommitted; preflight does not)
 *   branch, upstream       the branch and whether it has an upstream
 *   unpushed               commits ahead of the upstream, or null with no upstream
 *   base, behind, ahead    the base branch, and commits behind and beyond it
 *   commitsSince           with `since` (the commit a preflight run ended on): commits after it,
 *                          or null when that commit is no longer in the branch's history
 * Throws when git cannot read the folder.
 */
export async function readGit(wt, since = null) {
  const base = await baseOf(wt);
  const [head, status, counts, commitsSince] = await Promise.all([
    git(wt, "log", "-1", "--format=%H %T %cI"),
    git(wt, "status", "--porcelain=v2", "--branch"),
    git(wt, "rev-list", "--left-right", "--count", `${base}...HEAD`).catch(() => ""),
    since ? git(wt, "merge-base", "--is-ancestor", since, "HEAD").then(() => git(wt, "rev-list", "--count", "--first-parent", since + "..HEAD")).then(Number).catch(() => null) : null,
  ]);
  const [sha, tree, headTime] = head.split(" ");
  let uncommitted = 0, untracked = 0, branch = "", upstream = false, unpushed = null;
  for (const line of status.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) upstream = true;
    else if (line.startsWith("# branch.ab ")) unpushed = Number((/\+(\d+)/.exec(line) || [])[1] ?? 0);
    else if (line.startsWith("? ")) untracked++;
    else if (line && !line.startsWith("#") && !line.startsWith("! ")) uncommitted++;
  }
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
  return { head: sha, tree, headTime, uncommitted, untracked, branch, upstream, unpushed: upstream ? unpushed ?? 0 : null, base: base.replace(/^origin\//, ""), behind, ahead, commitsSince };
}

/**
 * Watches the git folders of the given worktrees and calls onChange(worktree) a second after one
 * changes. `set(paths)` replaces the watched set; `close()` stops everything.
 */
export function gitWatcher(onChange) {
  const watched = new Map();   // worktree -> { watcher, timer }
  const stop = wt => { const w = watched.get(wt); if (!w) return; clearTimeout(w.timer); try { w.watcher.close(); } catch {} watched.delete(wt); };
  async function start(wt) {
    watched.set(wt, { watcher: null, timer: null });
    try {
      const dir = await git(wt, "rev-parse", "--absolute-git-dir");
      const entry = watched.get(wt);
      if (!entry) return;
      entry.watcher = fs.watch(dir, { persistent: false }, (event, file) => {
        // Git writes lock files and FETCH_HEAD constantly; these say the checkout itself moved.
        if (file && !/^(HEAD|index|ORIG_HEAD|MERGE_HEAD|REBASE_HEAD)$/.test(String(file))) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => onChange(wt), 1000);
      });
      entry.watcher.on("error", () => stop(wt));
    } catch { watched.delete(wt); }
  }
  return {
    set(paths) {
      const want = new Set(paths);
      for (const wt of [...watched.keys()]) if (!want.has(wt)) stop(wt);
      for (const wt of want) if (!watched.has(wt)) start(wt);
    },
    close() { for (const wt of [...watched.keys()]) stop(wt); },
  };
}
