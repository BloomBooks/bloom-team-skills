// Opens and creates Orca worktrees for YouTrack cards. dashboard/server.mjs (its Open and Create
// buttons) and work-on-youtrack/work-on-youtrack.mjs share these.
//
//   import { orca, openWorktree, createWorktree, bringOrcaToFront } from "<repo>/orca-worktrees.mjs";
//
// Each function reports what it did through the function given to setLog (nothing by default).
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);
const execFileP = promisify(execFile);

let log = () => {};
export function setLog(fn) { log = fn; }

export const norm = p => (p || "").replace(/\\/g, "/").toLowerCase();

// orca is a .cmd shim on Windows, so it runs through a shell. Every argument is either fixed text
// or has been checked against the patterns below, and none may contain a quote or a % sign.
export function quote(a) {
  if (/["%\r\n]/.test(a)) throw new Error("refusing an argument with a quote, % or newline: " + a);
  return /^[\w.:\/@-]+$/.test(a) ? a : `"${a}"`;
}
export async function orca(...args) {
  const cli = process.env.ORCA_CLI_COMMAND || "orca";
  let stdout;
  try {
    ({ stdout } = await execP([cli, ...args.map(quote), "--json"].join(" "), { maxBuffer: 64 << 20, windowsHide: true }));
  } catch (e) {
    // A failing orca exits non-zero with its JSON error on stdout; report that, not just "Command failed".
    if (!String(e.stdout || "").includes("{")) throw e;
    stdout = e.stdout;
  }
  const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
  if (j.ok === false) throw new Error(`orca ${args[0]} ${args[1]}: ${j.error?.code || "failed"} ${j.error?.message || ""}`.trim());
  return j.result;
}

let orcaExe = null;
export async function bringOrcaToFront() {
  // Launching Orca.exe again makes the running Orca bring its window to the front (its
  // second-instance handler); the CLI calls only change what it shows.
  if (!orcaExe && process.platform === "win32") {
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-Command",
      "(Get-Process -Name Orca -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path"], { windowsHide: true });
    orcaExe = stdout.trim() || null;
  }
  if (orcaExe) spawn(orcaExe, [], { detached: true, stdio: "ignore" }).unref();
}

export async function knownWorktree(p) {
  const w = (await orca("worktree", "list")).worktrees.find(x => !x.isArchived && norm(x.path) === norm(p));
  if (!w) throw new Error("Orca has no worktree at " + p);
  return w.path;
}

// The worktree's Claude terminal, if it has one: { handle, agent }. With several agents, a waiting
// one comes first, then a working one, so the dashboard's Status pill opens the terminal it describes.
export async function agentTerminal(wt) {
  const terms = (await orca("terminal", "list", "--worktree", "path:" + wt)).terminals;
  const ps = (await orca("worktree", "ps")).worktrees.find(x => norm(x.path) === norm(wt));
  const rank = a => ({ waiting: 0, working: 1 })[a.state] ?? 2;
  for (const a of [...(ps?.agents || [])].sort((x, y) => rank(x) - rank(y))) {
    const t = terms.find(t => `${t.tabId}:${t.leafId}` === a.paneKey);
    if (t) return { handle: t.handle, agent: a };
  }
  return null;
}

// Switches Orca to the worktree's agent terminal; with no agent there, starts Claude in it,
// resuming that worktree's last conversation when there is one.
export async function openWorktree(p) {
  const wt = await knownWorktree(p);
  const target = await agentTerminal(wt);
  if (target) {
    await orca("terminal", "switch", "--terminal", target.handle);
    log("switched to agent " + target.handle + " in " + wt);
  } else {
    await orca("terminal", "create", "--worktree", "path:" + wt, "--title", "Claude", "--command", "claude --continue || claude", "--focus");
    log("started Claude in " + wt);
  }
}

// The first three words of a card's title, without any [tag], for a branch name.
export function titleWords(title) {
  return (title || "").replace(/\[[^\]]*\]/g, "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 3);
}

// The repo ("owner/name", lower case) and number of a GitHub PR URL, or null.
export function parsePr(url) {
  const m = (url || "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  return m ? { repo: m[1].toLowerCase(), number: m[2] } : null;
}

// Orca's id for the repo it knows as github:<repo>, or an error naming the repo.
export async function orcaRepoId(repo) {
  const repoId = (await orca("worktree", "list")).worktrees.find(w => w.projectId === "github:" + repo)?.repoId;
  if (!repoId) throw new Error("Orca has no repo for github:" + repo);
  return repoId;
}

// The branch of a PR, checked to be safe to pass to git and orca.
export async function prHeadBranch(repo, number) {
  const { stdout } = await execFileP("gh", ["pr", "view", number, "-R", repo, "--json", "headRefName", "--jq", ".headRefName"], { windowsHide: true });
  const head = stdout.trim();
  if (!/^[\w.\/-]+$/.test(head)) throw new Error(`could not read the branch of ${repo} PR ${number}`);
  return head;
}

// The GitHub default branch of `repo`, e.g. "master".
async function defaultBranch(repo) {
  const base = (await execFileP("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { windowsHide: true })).stdout.trim();
  if (!base) throw new Error("GitHub gave no default branch for " + repo);
  return base;
}
// Claude's first message in a worktree whose branch is not based on the default branch.
const branchNotice = (branch, base, main) =>
  `This worktree is on branch ${branch}, which is based on ${base}, not ${main}. ` +
  `Tell the developer that in one sentence, then wait for their instructions without starting any work.`;

// Makes a worktree for a card that has none and starts Claude in it, then returns { path, branch }.
// Orca names the worktree's branch itself from --name (adding its branch prefix, e.g.
// "JohnThomson/"). Without a PR, that branch, <prefix><card>-<words>, is new from origin's copy of
// a base branch, fetched first: Version<n> when the title starts with "[<n>]" (a card for a
// release, e.g. "[6.5] …" goes on Version6.5), otherwise the GitHub default branch of `repo`
// (bloombooks/bloomdesktop unless given). The base is named on every call because Orca's own
// default base for a repo can be any branch. `words` defaults to the first three words of the
// title. With a PR, the worktree is switched onto the PR's own branch before Claude starts, and
// Orca's prefixed branch is deleted. When the branch is based on anything but the default branch,
// Claude's first message asks it to tell the developer which branch the worktree is on.
export async function createWorktree({ card, title, pr, words, repo = "bloombooks/bloomdesktop" }) {
  if (!/^BL-\d+$/.test(card || "")) throw new Error("bad card id " + card);
  let prNumber = null;
  const parsed = parsePr(pr);
  if (parsed) { repo = parsed.repo; prNumber = parsed.number; }
  const repoId = await orcaRepoId(repo);
  const repoPath = (await orca("repo", "list")).repos.find(r => r.id === repoId)?.path;
  const main = await defaultBranch(repo);
  const args = ["worktree", "create", "--repo", "id:" + repoId, "--no-parent", "--activate"];
  if (!prNumber) {
    const version = (String(title || "").match(/^\s*\[(\d+(?:\.\d+)*)\]/) || [])[1];
    const base = version ? "Version" + version : main;
    try {
      await execFileP("git", ["-C", repoPath, "fetch", "origin", base], { windowsHide: true });
    } catch {
      throw new Error(`could not fetch ${base} from ${repo}` + (version ? ` (the title starts with [${version}]); make that branch or retitle the card` : ""));
    }
    const name = [card, ...(words || titleWords(title))].join("-");
    // Orca's prefix is unknown until it answers, so the notice names the branch Orca is asked for.
    const notice = base !== main ? ["--prompt", branchNotice(name, "origin/" + base, main)] : [];
    const r = await orca(...args, "--agent", "claude", ...notice, "--name", name, "--base-branch", "origin/" + base);
    const made = r.worktree?.path || r.worktreeId;
    log("created " + made + " on origin/" + base + " for " + card);
    return { path: made, branch: (r.worktree?.branch || "").replace("refs/heads/", ""), base };
  }
  const head = await prHeadBranch(repo, prNumber);
  const prBase = (await execFileP("gh", ["pr", "view", String(prNumber), "-R", repo, "--json", "baseRefName", "--jq", ".baseRefName"], { windowsHide: true })).stdout.trim();
  await execFileP("git", ["-C", repoPath, "fetch", "origin", head], { windowsHide: true });
  const before = new Set((await orca("worktree", "list")).worktrees.map(w => norm(w.path)));
  const r = await orca(...args, "--name", head.replace(/\//g, "-"), "--base-branch", "origin/" + head, "--pr", prNumber);
  const wt = r.worktree?.path || (await orca("worktree", "list")).worktrees.find(w => w.repoId === repoId && !before.has(norm(w.path)))?.path;
  if (!wt) throw new Error("Orca made the worktree but did not say where; switch it to " + head + " by hand");
  const orcaBranch = (await execFileP("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { windowsHide: true })).stdout.trim();
  // A local branch named like the PR's makes "git switch" use it; otherwise it creates one tracking origin.
  await execFileP("git", ["-C", wt, "switch", head], { windowsHide: true });
  if (orcaBranch && orcaBranch !== head) await execFileP("git", ["-C", wt, "branch", "-D", orcaBranch], { windowsHide: true }).catch(e => log("could not delete " + orcaBranch + ": " + e.message));
  if (prBase && prBase !== main) await orca("agent", "launch", "--agent", "claude", "--worktree", "path:" + wt, "--prompt", branchNotice(head, prBase, main), "--focus");
  else await orca("terminal", "create", "--worktree", "path:" + wt, "--title", "Claude", "--command", "claude", "--focus");
  log("created " + wt + " on " + head + " for " + card);
  return { path: wt, branch: head, base: prBase || main };
}
