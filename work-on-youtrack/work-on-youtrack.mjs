// Finds the Orca worktree for a YouTrack card, or makes one, and shows it in Orca with Claude
// running in it.
//
// Usage: node work-on-youtrack.mjs <card> [--repo <owner/name>] [--dry-run] [--json]
//   <card>      BL-16627 (or BL16627), or a YouTrack URL that contains it
//   --repo      the GitHub repo for a new worktree when the card has no PR (default
//               bloombooks/bloomdesktop); also limits the search for worktrees and PRs to that repo
//   --dry-run   reads the card, finds or names the worktree, then prints what it would do
//   --json      prints one JSON object instead of text: { ok, action, card, summary, state,
//               pr, worktree, branch, words, wordsFrom, terminal, others, error }
//
// Exit code 0 on success, 1 on any failure (the text or JSON says why).
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  orca, norm, parsePr, orcaRepoId, prHeadBranch, titleWords, agentTerminal,
  openWorktree, createWorktree, bringOrcaToFront,
} from "../orca-worktrees.mjs";

const execFileP = promisify(execFile);
const YT = "https://issues.bloomlibrary.org/youtrack/api";
const DEFAULT_REPO = "bloombooks/bloomdesktop";

// ---- arguments ------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const dryRun = flag("--dry-run");
const asJson = flag("--json");
const repoAt = argv.indexOf("--repo");
const repoArg = repoAt >= 0 ? (argv[repoAt + 1] || "").toLowerCase() : null;
const cardArg = argv.find((a, i) => !a.startsWith("--") && !(repoAt >= 0 && i === repoAt + 1));

function finish(result) {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.log("work-on-youtrack failed: " + result.error);
  else console.log(describe(result));
  process.exit(result.ok ? 0 : 1);
}

// ---- YouTrack -------------------------------------------------------------------------------
function userEnv(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== "win32") return "";
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch { return ""; }
}
async function readCard(id) {
  const token = userEnv("YOUTRACK_BOT");
  if (!token) throw new Error("YOUTRACK_BOT is not set, so the card cannot be read (see the youtrack-api skill)");
  const url = `${YT}/issues/${id}?fields=idReadable,summary,description,customFields(name,value(name)),comments(text,deleted)`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (r.status === 404) throw new Error(`YouTrack has no card ${id}`);
  if (!r.ok) throw new Error(`YouTrack ${id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const i = await r.json();
  return {
    summary: i.summary || "",
    description: i.description || "",
    state: i.customFields?.find(c => c.name === "State")?.value?.name ?? null,
    comments: (i.comments || []).filter(c => !c.deleted).map(c => c.text || ""),
  };
}

// ---- the card's PR --------------------------------------------------------------------------
// The open PRs that name the card in their title or branch (the rule dashboard/gather.mjs uses),
// found among the GitHub PR links on the card and a GitHub search of BloomBooks for the card id.
async function openPrs(card, info) {
  const urls = new Set();
  for (const text of [info.description, ...info.comments]) {
    for (const m of text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) urls.add(m[0]);
  }
  try {
    const { stdout } = await execFileP("gh", ["search", "prs", card, "--owner", "BloomBooks", "--state", "open", "--json", "url", "--limit", "20"], { windowsHide: true });
    for (const p of JSON.parse(stdout || "[]")) urls.add(p.url);
  } catch (e) {
    throw new Error("could not search GitHub for the card's PRs (is gh signed in?): " + String(e.stderr || e.message).split("\n")[0]);
  }
  const names = new RegExp(`\\b${card}\\b`, "i");
  const prs = [];
  const seen = new Set();
  for (const url of urls) {
    const parsed = parsePr(url);
    if (!parsed || seen.has(parsed.repo + "#" + parsed.number)) continue;
    seen.add(parsed.repo + "#" + parsed.number);
    if (repoArg && parsed.repo !== repoArg) continue;
    let p;
    try {
      const { stdout } = await execFileP("gh", ["pr", "view", parsed.number, "-R", parsed.repo, "--json", "url,title,state,headRefName,number"], { windowsHide: true });
      p = JSON.parse(stdout);
    } catch { continue; }
    if (p.state !== "OPEN" || !(names.test(p.title) || names.test(p.headRefName))) continue;
    prs.push({ url: p.url, repo: parsed.repo, number: p.number, title: p.title, head: p.headRefName });
  }
  return prs.sort((a, b) => a.number - b.number);
}

// ---- existing worktrees ---------------------------------------------------------------------
const branchOf = w => (w.branch || "").replace(/^refs\/heads\//, "");
const repoOf = w => (w.projectId || "").replace(/^github:/, "");
// Worktrees (not archived) for the card: a branch that, after any "<prefix>/", starts with
// "<card>-" or is the card id; a branch that is one of the PRs' head branches; a worktree Orca
// links to one of the PRs; or one that `orca reference find` returns for the card or a PR.
async function cardWorktrees(card, prs) {
  const list = (await orca("worktree", "list")).worktrees.filter(w => !w.isArchived && (!repoArg || repoOf(w) === repoArg));
  const byPath = new Map(list.map(w => [norm(w.path), w]));
  const found = new Map();
  const add = (w, why) => { if (w && !found.has(norm(w.path))) found.set(norm(w.path), { w, why }); };
  const named = new RegExp(`(^|/)${card}(-|$)`, "i");
  for (const w of list) {
    const pr = prs.find(p => p.repo === repoOf(w) && (branchOf(w) === p.head || branchOf(w).endsWith("/" + p.head) || w.linkedPR === p.number));
    if (pr) add(w, "pr");
    else if (named.test(branchOf(w))) add(w, "branch");
  }
  for (const query of [card, ...prs.map(p => p.url)]) {
    let r;
    try { r = await orca("reference", "find", query); } catch { continue; }
    for (const m of r.matches || []) {
      if (m.workspace?.archived) continue;
      const p = String(m.workspace?.id || "").split("::")[1];
      add(byPath.get(norm(p)), "reference");
    }
  }
  // A worktree on the PR's branch first, then the one Orca saw activity in most recently.
  const rank = { pr: 0, reference: 1, branch: 2 };
  return [...found.values()]
    .sort((a, b) => rank[a.why] - rank[b.why] || (b.w.lastActivityAt || 0) - (a.w.lastActivityAt || 0))
    .map(({ w }) => ({ path: w.path, branch: branchOf(w), repo: repoOf(w) }));
}

// ---- words for a new branch -----------------------------------------------------------------
const WORDS = /^[a-z0-9]+(-[a-z0-9]+){0,2}$/;
// Asks Claude (haiku) for 1-3 lowercase hyphenated words naming what the card is about. Returns
// the words, or null when the call fails, takes more than 30 s, or answers with anything else.
function claudeWords(card, info) {
  const description = info.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
  const prompt = [
    `Name a git branch for YouTrack card ${card}. Reply with only 1 to 3 lowercase English words joined`,
    `by hyphens that say what the card is about, for example shrink-image-pane. No card id, no quotes,`,
    `no other text.`,
    ``,
    `Title: ${info.summary}`,
    `Description: ${description || "(none)"}`,
  ].join("\n");
  return new Promise(resolve => {
    let out = "", done = false;
    const end = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawn("claude", ["-p", "--model", "haiku"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { child.kill(); end(null); }, 30000);
    child.on("error", () => end(null));
    child.stdout.on("data", d => { out += d; });
    child.on("close", code => {
      const answer = out.trim().split(/\r?\n/).filter(Boolean).pop()?.trim().replace(/^[`"']+|[`"'.]+$/g, "").toLowerCase() || "";
      end(code === 0 && WORDS.test(answer) && answer.length <= 40 ? answer.split("-") : null);
    });
    child.stdin.end(prompt);
  });
}

// ---- output ---------------------------------------------------------------------------------
function describe(r) {
  const lines = [`${r.card}: ${r.summary}${r.state ? ` (${r.state})` : ""}`];
  if (r.pr) lines.push(`PR: ${r.pr}`);
  const would = r.action.startsWith("would-");
  if (r.action.endsWith("open")) {
    lines.push(`${would ? "Would open" : "Opened"} ${r.worktree} (branch ${r.branch})`);
    lines.push(r.terminal ? `${would ? "Would switch" : "Switched"} to its Claude terminal (${r.terminal}).` : `${would ? "Would start" : "Started"} Claude there (claude --continue || claude).`);
  } else {
    const from = r.pr ? `on the PR's branch ${r.branch}` : `on a new branch ${r.branch}` + (r.wordsFrom === "claude" ? " (words from Claude)" : " (words from the title; Claude gave no usable answer)");
    lines.push(`${would ? "Would create" : "Created"} a worktree in ${r.repo} ${from}${r.worktree ? ` at ${r.worktree}` : ""}, with Claude running in it.`);
  }
  if (r.others?.length) lines.push("Other worktrees for this card: " + r.others.join(", "));
  if (r.otherPrs?.length) lines.push("Other open PRs for this card: " + r.otherPrs.join(", "));
  if (r.frontError) lines.push("Could not bring Orca to the front: " + r.frontError);
  return lines.join("\n");
}

// ---- main -----------------------------------------------------------------------------------
async function main() {
  const digits = (String(cardArg || "").match(/\bBL-?(\d+)\b/i) || [])[1];
  const card = digits && "BL-" + digits;
  if (!card) throw new Error("usage: node work-on-youtrack.mjs <BL-nnnnn> [--repo <owner/name>] [--dry-run] [--json]");
  if (repoArg !== null && !/^[\w.-]+\/[\w.-]+$/.test(repoArg)) throw new Error("--repo needs <owner/name>, e.g. bloombooks/bloomdesktop");

  const info = await readCard(card);
  const prs = await openPrs(card, info);
  const worktrees = await cardWorktrees(card, prs);
  const result = { ok: true, card, summary: info.summary, state: info.state, dryRun };
  if (prs.length > 1) result.otherPrs = prs.slice(1).map(p => p.url);

  if (worktrees.length) {
    const [wt, ...others] = worktrees;
    // The PR this worktree is on, if any.
    const pr = prs.find(p => p.repo === wt.repo && (wt.branch === p.head || wt.branch.endsWith("/" + p.head))) || prs[0];
    Object.assign(result, { action: dryRun ? "would-open" : "open", worktree: wt.path, branch: wt.branch, repo: wt.repo, pr: pr?.url || null, others: others.map(o => o.path) });
    if (pr) result.otherPrs = prs.filter(p => p !== pr).map(p => p.url);
    result.terminal = (await agentTerminal(wt.path))?.handle || null;
    if (!dryRun) await openWorktree(wt.path);
  } else if (prs.length) {
    const pr = prs[0];
    await orcaRepoId(pr.repo);
    const head = await prHeadBranch(pr.repo, String(pr.number));
    Object.assign(result, { action: dryRun ? "would-create" : "create", repo: pr.repo, pr: pr.url, branch: head });
    if (!dryRun) result.worktree = (await createWorktree({ card, title: info.summary, pr: pr.url })).path;
  } else {
    const repo = repoArg || DEFAULT_REPO;
    await orcaRepoId(repo);
    let words = await claudeWords(card, info);
    result.wordsFrom = words ? "claude" : "title";
    words ||= titleWords(info.summary);
    Object.assign(result, { action: dryRun ? "would-create" : "create", repo, pr: null, words: words.join("-"), branch: [card, ...words].join("-") });
    if (!dryRun) {
      const made = await createWorktree({ card, title: info.summary, words, repo });
      result.worktree = made.path;
      if (made.branch) result.branch = made.branch;
    }
  }
  if (!dryRun) await bringOrcaToFront().catch(e => { result.frontError = e.message; });
  return result;
}

main().then(finish, e => finish({ ok: false, error: e.message }));
