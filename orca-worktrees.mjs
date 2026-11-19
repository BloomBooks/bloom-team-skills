// Opens and creates Orca worktrees for YouTrack cards, and drives the Claude sessions in them.
// orca-bloom-dashboard-plugin/server/service.mjs (the buttons of the dashboard page and the Worktree panel),
// orca-bloom-dashboard-plugin/panel-facts.mjs, work-on-youtrack/work-on-youtrack.mjs and
// work-on-reviewing/work-on-reviewing.mjs share
// these.
//
//   import { orca, openWorktree, createWorktree, bringOrcaToFront } from "<repo>/orca-worktrees.mjs";
//
// Each function reports what it did through the function given to setLog (nothing by default).
import { exec, execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execP = promisify(exec);
const execFileP = promisify(execFile);

let log = () => {};
export function setLog(fn) { log = fn; }

// A worktree path in the one form that every map of worktrees is keyed by: forward slashes, lower
// case, no trailing slash. Orca, git, the rows the session writes and progress.mjs each spell a
// path their own way.
export const norm = p => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// The skills that the dashboard's and the panel's buttons run in a worktree's Claude session.
export const DASHBOARD_SKILLS = ["preflight", "request-peer-review", "merge-without-peer-review", "process-pr-comments"];
// No skill is named process-pr-comments: its button types this prompt. An agent whose prompt
// starts with COMMENTS_PROMPT_START counts as running it (skillOf in orca-bloom-dashboard-plugin/server/row-facts.mjs).
// The prompt holds no quote, so that it can sit inside a quoted argument of `claude`.
export const COMMENTS_PROMPT_START = "Process the PR comments";
export const COMMENTS_PROMPT = COMMENTS_PROMPT_START + ": read every unresolved discussion on the PR of this branch (reviewable-replies skill), make the changes that they ask for, and reply to each one.";
// What a button types into the session to run one of DASHBOARD_SKILLS.
const skillPrompt = skill => skill === "process-pr-comments" ? COMMENTS_PROMPT : "/" + skill;

// An agent's state as the dashboard counts it. Orca calls an agent "working" while a background
// Monitor runs in it (workingMode "monitoring"), though it sits at its prompt; that counts as done.
export const agentState = a => a.state === "working" && a.workingMode === "monitoring" ? "done" : a.state;

// For a command that runs through a shell (VS Code's `code` is a .cmd file): no argument may
// contain a quote or a % sign.
export function quote(a) {
  if (/["%\r\n]/.test(a)) throw new Error("refusing an argument with a quote, % or newline: " + a);
  return /^[\w.:\/@-]+$/.test(a) ? a : `"${a}"`;
}
// The orca CLI is an executable (resources\bin\orca.exe in Orca's install folder), so it runs
// without a shell and its arguments pass through as they are. ORCA_CLI_COMMAND, which Orca sets in
// its terminals, names the CLI of the Orca they belong to; a development build's is a .cmd file,
// which only a shell runs, and then quote() applies. It runs from the home folder: Node looks for a
// program in the current folder before PATH, and Orca starts plugin workers in its own install
// folder, where it would find Orca.exe.
export async function orca(...args) {
  const cli = process.env.ORCA_CLI_COMMAND || "orca";
  const runOpts = { cwd: os.homedir(), maxBuffer: 64 << 20, windowsHide: true, timeout: 120_000 };
  let stdout;
  try {
    ({ stdout } = /\.(cmd|bat)$/i.test(cli)
      ? await execP([`"${cli}"`, ...[...args, "--json"].map(quote)].join(" "), runOpts)
      : await execFileP(cli, [...args, "--json"], runOpts));
  } catch (e) {
    // A failing orca exits non-zero with its JSON error on stdout; report that, not just "Command failed".
    if (!String(e.stdout || "").includes("{")) throw e;
    stdout = e.stdout;
  }
  const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
  if (j.ok === false) {
    const e = new Error(`orca ${args[0]} ${args[1]}: ${j.error?.code || "failed"} ${j.error?.message || ""}`.trim());
    e.code = j.error?.code;
    throw e;
  }
  return j.result;
}

// Types a prompt into an agent's terminal as Orca delivers prompts: refused while the agent asks
// for permission (agent_prompt_blocked) or while its input box holds text the developer has not
// sent (agent_prompt_draft_present) or when Orca cannot read that box (agent_prompt_draft_unverified),
// and watched for a few seconds for the turn it starts. An Orca without --refuse-draft cannot check
// the input box, so the prompt goes without that check. Returns whether Orca saw the turn start.
export async function typePrompt(handle, text) {
  const send = refuse => orca("terminal", "send", "--terminal", handle, "--text", text, "--enter",
    ...(refuse ? ["--refuse-draft"] : []), "--wait-submit", "5");
  let result;
  try {
    result = await send(true);
  } catch (e) {
    if (["invalid_argument", "incompatible_runtime"].includes(e.code) && /refuse-draft/.test(e.message)) result = await send(false);
    else if (/agent_prompt_draft_present/.test(e.message)) throw new Error("that Claude session has text in its input box that you haven't sent; send or clear it, then try again");
    else if (/agent_prompt_draft_unverified/.test(e.message)) throw new Error("Orca couldn't read that Claude session's input box, so nothing was sent; try again");
    else if (e.code === "agent_prompt_blocked") throw new Error("that Claude session is asking for permission; answer it first");
    else throw e;
  }
  if (!result.send?.accepted) throw new Error("Orca did not accept the prompt");
  return (result.send.prompt?.stages || []).includes("turn_started");
}

let orcaExe = null;
const raiseWindowScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "orca-bloom-dashboard-plugin", "server", "raise-window.ps1");
export async function bringOrcaToFront() {
  // The CLI calls only change what Orca shows. Windows lets only the foreground program raise a
  // window, so Orca raising its own (from its second-instance handler, when Orca.exe is launched
  // again) mostly flashes its taskbar button; raise-window.ps1 taps Alt first, which gets through.
  if (process.platform === "win32") {
    try {
      await execFileP("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", raiseWindowScript, "-Process", "Orca"], { windowsHide: true });
      return;
    } catch {}   // exit 1: Orca shows no main window (hidden to the tray), so launch it again
  }
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

/**
 * Picks the agent whose terminal a button acts on, from the worktree's agents (`orca worktree ps`)
 * and its terminals (`orca terminal list`): { handle, agent }, or null when no agent has a
 * terminal. With `paneKey` (the session the Worktree panel follows), that agent or an error: a
 * prompt typed into another session goes to a conversation that knows nothing of the work.
 * Without it, a waiting agent comes first, then a working one, so the dashboard's Status pill
 * opens the terminal it describes. Orca can run Claude in a terminal that no agent of `worktree ps`
 * points at (its agent record is lost or stale); a terminal whose agentIdentity is "claude" is
 * then the target, with `agent` null.
 */
export function pickAgentTerminal(agents, terminals, paneKey = null) {
  const terminalOf = a => terminals.find(t => `${t.tabId}:${t.leafId}` === a.paneKey);
  if (paneKey) {
    const a = agents.find(x => x.paneKey === paneKey && terminalOf(x));
    if (!a) throw new Error("the Claude session the panel shows has closed; pick another");
    return { handle: terminalOf(a).handle, agent: a };
  }
  const rank = a => ({ waiting: 0, working: 1 })[a.state] ?? 2;
  for (const a of [...agents].sort((x, y) => rank(x) - rank(y))) {
    const t = terminalOf(a);
    if (t) return { handle: t.handle, agent: a };
  }
  const claude = terminals.filter(t => t.agentIdentity === "claude").sort((x, y) => (y.lastOutputAt || 0) - (x.lastOutputAt || 0))[0];
  return claude ? { handle: claude.handle, agent: null } : null;
}

export async function agentTerminal(wt, paneKey = null) {
  const terms = (await orca("terminal", "list", "--worktree", "path:" + wt)).terminals;
  const ps = (await orca("worktree", "ps")).worktrees.find(x => norm(x.path) === norm(wt));
  return pickAgentTerminal(ps?.agents || [], terms, paneKey);
}

// Starts a Claude terminal in the worktree running `command` and shows it.
const startClaude = (wt, command) =>
  orca("terminal", "create", "--worktree", "path:" + wt, "--title", "Claude", "--command", command, "--focus");

// Types `text` into the agent's terminal and shows it; refused while that agent works. A terminal
// with no agent record has no known state, and Orca's own checks in typePrompt still apply.
async function promptAgent(target, text) {
  if (target.agent && agentState(target.agent) === "working") throw new Error("Claude is busy in that worktree; open it and wait for it to finish");
  const started = await typePrompt(target.handle, text);
  await orca("terminal", "switch", "--terminal", target.handle);
  return started;
}

// Switches Orca to the worktree's agent terminal (the `paneKey` one when given); with no agent
// there, starts Claude in it, resuming that worktree's last conversation when there is one.
// Returns what it did, in a few words.
export async function openWorktree(p, paneKey = null) {
  const wt = await knownWorktree(p);
  const target = await agentTerminal(wt, paneKey);
  if (target) {
    await orca("terminal", "switch", "--terminal", target.handle);
    log("switched to agent " + target.handle + " in " + wt);
    return "Showing Claude's terminal.";
  }
  await startClaude(wt, "claude --continue || claude");
  log("started Claude in " + wt);
  return "Started Claude.";
}

// Runs one of DASHBOARD_SKILLS in the worktree's Claude session (the `paneKey` one when given):
// its slash command, or for process-pr-comments COMMENTS_PROMPT, typed into its terminal when
// Claude is there and idle, or in a new Claude terminal when there is none. Returns what it did,
// in a few words.
export async function runSkill(p, skill, paneKey = null) {
  if (!DASHBOARD_SKILLS.includes(skill)) throw new Error("not a skill the dashboard runs: " + skill);
  const wt = await knownWorktree(p);
  const target = await agentTerminal(wt, paneKey);
  if (target) {
    const started = await promptAgent(target, skillPrompt(skill));
    log(`sent ${skill} to ${target.handle} in ${wt}${started ? "" : " (its turn not seen starting yet)"}`);
    return `Sent ${skill} to Claude.`;
  }
  const text = skillPrompt(skill);
  await startClaude(wt, "claude --continue " + (text.includes(" ") ? `"${text}"` : text));
  log(`started Claude with ${skill} in ${wt}`);
  return `Started Claude with ${skill}.`;
}

// Types `text` into the worktree's Claude session (the `paneKey` one when given). Refuses while
// that session works, or when the worktree has no session to ask.
export async function sendPrompt(p, text, paneKey = null) {
  const wt = await knownWorktree(p);
  const target = await agentTerminal(wt, paneKey);
  if (!target) throw new Error("no Claude session is running in this worktree");
  const started = await promptAgent(target, text);
  log(`sent "${text}" to ${target.handle} in ${wt}`);
  return started ? `Asked Claude to ${text}.` : `Typed "${text}" into Claude's session; Orca hasn't seen it start yet.`;
}

// Opens the worktree's folder in VS Code.
export async function openInVsCode(p) {
  const wt = await knownWorktree(p);
  await execP("code " + quote(wt), { cwd: os.homedir(), windowsHide: true, timeout: 30_000 });
  log("opened " + wt + " in VS Code");
  return "Opened in VS Code.";
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

const branchOf = w => (w.branch || "").replace(/^refs\/heads\//, "");
const repoOf = w => (w.projectId || "").replace(/^github:/, "");
// Worktrees (not archived) for a card and its PRs ([{ url, repo, number, head }]), only in `repo`
// ("owner/name", lower case) when given: a branch that, after any "<prefix>/", starts with
// "<card>-" or is the card id; a branch that is one of the PRs' head branches; a worktree Orca
// links to one of the PRs; or one that `orca reference find` returns for the card or a PR. `card`
// may be null, to find only a PR's worktrees. Those on a PR's branch come first, then the one Orca
// saw activity in most recently. Returns [{ path, branch, repo, onPr }], `onPr` being the PR whose
// branch the worktree is on, or null.
export async function cardWorktrees(card, prs, repo = null) {
  const list = (await orca("worktree", "list")).worktrees.filter(w => !w.isArchived && (!repo || repoOf(w) === repo));
  const byPath = new Map(list.map(w => [norm(w.path), w]));
  const found = new Map();
  const add = (w, why) => { if (w && !found.has(norm(w.path))) found.set(norm(w.path), { w, why }); };
  const prOf = w => prs.find(p => p.repo === repoOf(w) && (branchOf(w) === p.head || branchOf(w).endsWith("/" + p.head))) || null;
  const named = card && new RegExp(`(^|/)${card}(-|$)`, "i");
  for (const w of list) {
    if (prOf(w) || prs.some(p => p.repo === repoOf(w) && w.linkedPR === Number(p.number))) add(w, "pr");
    else if (named?.test(branchOf(w))) add(w, "branch");
  }
  for (const query of [card, ...prs.map(p => p.url)].filter(Boolean)) {
    let r;
    try { r = await orca("reference", "find", query); } catch { continue; }
    for (const m of r.matches || []) {
      if (m.workspace?.archived) continue;
      const p = String(m.workspace?.id || "").split("::")[1];
      add(byPath.get(norm(p)), "reference");
    }
  }
  const rank = { pr: 0, reference: 1, branch: 2 };
  return [...found.values()]
    .sort((a, b) => rank[a.why] - rank[b.why] || (b.w.lastActivityAt || 0) - (a.w.lastActivityAt || 0))
    .map(({ w }) => ({ path: w.path, branch: branchOf(w), repo: repoOf(w), onPr: prOf(w) }));
}

// Orca's id for the repo it knows as github:<repo>, or an error naming the repo.
export async function orcaRepoId(repo) {
  const repoId = (await orca("worktree", "list")).worktrees.find(w => w.projectId === "github:" + repo)?.repoId;
  if (!repoId) throw new Error("Orca has no repo for github:" + repo);
  return repoId;
}

// The branch of a PR, checked to be safe to pass to git and orca. A PR from a fork is refused: its
// branch is in the fork, which `origin` does not have, and Claude could not push to it.
export async function prHeadBranch(repo, number) {
  const { stdout } = await execFileP("gh", ["pr", "view", String(number), "-R", repo, "--json", "headRefName,isCrossRepository,headRepositoryOwner"], { windowsHide: true });
  const pr = JSON.parse(stdout);
  if (pr.isCrossRepository) throw new Error(`${repo} PR ${number} comes from a fork (${pr.headRepositoryOwner?.login || "another owner"}), so its branch is not in ${repo}; make its worktree by hand`);
  const head = String(pr.headRefName || "");
  if (!/^[\w.\/-]+$/.test(head)) throw new Error(`could not read the branch of ${repo} PR ${number}`);
  return head;
}

// Whether commit `a` is an ancestor of `b` in the checkout `wt` (or the same commit).
async function isAncestor(wt, a, b) {
  try { await execFileP("git", ["-C", wt, "merge-base", "--is-ancestor", a, b], { windowsHide: true }); return true; }
  catch (e) { if (e.code === 1) return false; throw e; }
}

// The GitHub default branch of `repo`, e.g. "master".
async function defaultBranch(repo) {
  const base = (await execFileP("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { windowsHide: true })).stdout.trim();
  if (!base) throw new Error("GitHub gave no default branch for " + repo);
  return base;
}
// What Claude must tell the developer first in a worktree whose branch is not based on the default branch.
const branchFact = (branch, base, main) => `This worktree is on branch ${branch}, which is based on ${base}, not ${main}.`;
// Claude's first message: the facts it must tell the developer first, then the brief. With facts
// and no brief, Claude waits for instructions. Empty when there is neither.
function firstMessage(facts, prompt) {
  if (!facts.length) return prompt || "";
  const tell = facts.join(" ") + " Tell the developer that in one sentence";
  return prompt ? `${tell}, then: ${prompt}` : `${tell}, then wait for their instructions without starting any work.`;
}

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
// `prompt` (a hand-off's brief) becomes Claude's first message, after any such notice. Claude
// starts as a chat or in a terminal, as the developer's Orca setting says; the first message is the
// only one Orca can give a chat, so a brief must come this way. Returns also `launch`
// (launchSummary).
export async function createWorktree({ card, title, pr, words, repo = "bloombooks/bloomdesktop", prompt }) {
  let prNumber = null;
  const parsed = parsePr(pr);
  if (parsed) { repo = parsed.repo; prNumber = parsed.number; }
  // With a PR the worktree is named for the PR's branch, so the card is only for the log.
  if (!prNumber && !/^BL-\d+$/.test(card || "")) throw new Error("bad card id " + card);
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
    const first = firstMessage(base !== main ? [branchFact(name, "origin/" + base, main)] : [], prompt);
    const r = await orca(...args, "--agent", "claude", ...(first ? ["--prompt", first] : []), "--name", name, "--base-branch", "origin/" + base);
    const made = r.worktree?.path || r.worktreeId;
    log("created " + made + " on origin/" + base + " for " + card);
    return { path: made, branch: (r.worktree?.branch || "").replace("refs/heads/", ""), base, launch: launchSummary(r.launch) };
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
  // A local branch that an earlier worktree left behind can be older than the PR: it moves up to
  // the PR's head. One with commits that the PR lacks stays as it is, and Claude says so first.
  const facts = [];
  if (!(await isAncestor(wt, "origin/" + head, "HEAD"))) {
    if (await isAncestor(wt, "HEAD", "origin/" + head)) await execFileP("git", ["-C", wt, "merge", "--ff-only", "origin/" + head], { windowsHide: true });
    else facts.push(`This worktree is on the local branch ${head}, which has commits that the PR's branch on GitHub does not, and lacks some that it has; change neither branch until the developer says how to reconcile them.`);
  }
  if (prBase && prBase !== main) facts.push(branchFact(head, prBase, main));
  const launch = await launchClaude(wt, firstMessage(facts, prompt));
  log("created " + wt + " on " + head + " for " + (card || "PR " + prNumber));
  return { path: wt, branch: head, base: prBase || main, launch };
}

// Makes the worktree the one Orca shows, without bringing Orca's window to the front.
export async function activateWorktree(wt) {
  await orca("worktree", "activate", "--worktree", "path:" + wt);
}

// Starts Claude in a worktree that exists, with `prompt` as its first message when given, as a
// chat or in a terminal per the developer's Orca setting, and shows it unless `focus` is false
// (its tab then opens beside the one shown). Returns launchSummary.
export async function launchClaude(wt, prompt, { focus = true } = {}) {
  const r = await orca("agent", "launch", "--agent", "claude", "--worktree", "path:" + wt, ...(prompt ? ["--prompt", prompt] : []), ...(focus ? ["--focus"] : []));
  return launchSummary(r.launch || r);
}

// What Orca's reply to an agent launch says started: { kind: "structured" (a chat) | "terminal",
// handle, delivered }. `delivered` is Orca's word on whether the first message arrived, or null when
// none was sent or Orca did not say.
export function launchSummary(launch) {
  return { kind: launch?.outcome?.kind ?? null, handle: launch?.outcome?.handle ?? null, delivered: launch?.prompt?.outcome ?? null };
}
