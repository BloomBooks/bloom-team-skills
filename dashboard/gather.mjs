// Collects the facts the dashboard needs into one JSON file, so the agent reads one file
// instead of running dozens of commands.
// Usage: node gather.mjs <out.json> [board]
// board: a YouTrack "Kanban Board" value such as "Bloom 6.6" (or just "6.6"); when given, only
// cards on that board are kept, and worktrees and PRs whose card is not on it are dropped.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { developer } from "../developer.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: node gather.mjs <out.json> [board]");
const boardArg = process.argv[3]?.trim() || null;
const board = boardArg && /^\d/.test(boardArg) ? "Bloom " + boardArg : boardArg;

const YT = "https://issues.bloomlibrary.org/youtrack/api";
const CARD = /\bBL-\d+/i;

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts }).trim();
  } catch (e) {
    return null;
  }
}
function userEnv(name) {
  return process.env[name] || run("powershell.exe", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`]) || "";
}
function orca(...args) {
  const text = run("orca", [...args, "--json"], { shell: true });
  if (!text) throw new Error("orca " + args.join(" ") + " failed; is Orca running?");
  return JSON.parse(text.slice(text.indexOf("{"))).result;
}
async function yt(token, path, params) {
  const url = new URL(YT + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!r.ok) throw new Error(`YouTrack ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const field = (issue, name) => issue.customFields?.find(c => c.name === name)?.value?.name ?? null;

// Worktrees and the agents in them.
const list = orca("worktree", "list").worktrees.filter(w => !w.isArchived);
const ps = new Map(orca("worktree", "ps").worktrees.map(w => [w.path, w]));

const worktrees = [];
for (const w of list) {
  const branch = (w.branch || "").replace("refs/heads/", "");
  const card = (branch.match(CARD) || w.path.match(CARD) || [])[0]?.toUpperCase() ?? null;
  if (!card) continue;
  const git = (...a) => run("git", ["-C", w.path, ...a]);
  const status = (git("status", "--porcelain") || "").split("\n").filter(Boolean);
  const base = git("rev-parse", "--abbrev-ref", "origin/HEAD") || "origin/master";
  const p = ps.get(w.path);
  worktrees.push({
    card,
    path: w.path,
    repo: w.projectId,
    branch,
    orcaComment: w.comment || "",
    modified: status.filter(l => !l.startsWith("??")).map(l => l.slice(3)),
    untracked: status.filter(l => l.startsWith("??")).length,
    hasUpstream: git("rev-parse", "--abbrev-ref", "@{u}") != null,
    unpushed: Number(git("rev-list", "--count", "@{u}..HEAD") ?? -1),
    base,
    behindBase: Number(git("rev-list", "--count", `HEAD..${base}`) ?? -1),
    ownCommits: (git("log", "--oneline", "--no-merges", `${base}..HEAD`) || "").split("\n").filter(Boolean),
    lastCommit: git("log", "-1", "--format=%cs"),
    // state is "working", "waiting" (usually an AskUserQuestion for the developer) or "done".
    agents: (p?.agents || []).map(a => ({
      state: a.state,
      tool: a.toolName,
      question: a.programStatus?.kind === "question" ? a.programStatus.message : null,
      lastMessage: (a.lastAssistantMessage || "").slice(0, 600),
    })),
  });
}

// Cards: everything unresolved assigned to the developer, plus every card a worktree names.
const dev = await developer();
const bot = userEnv("YOUTRACK_BOT");
const FIELDS = "idReadable,summary,updated,customFields(name,value(name))";
// Searching by assignee needs the Bot's global "Read User Basic Role".
const assigned = await yt(bot, "/issues", { query: `Assignee: {${dev.youtrack.login}} #Unresolved`, fields: FIELDS, $top: "500" });
const ids = new Set([...assigned.map(i => i.idReadable), ...worktrees.map(w => w.card)]);
const cards = [];
for (const id of ids) {
  const i = assigned.find(a => a.idReadable === id) ?? (await yt(bot, "/issues/" + id, { fields: FIELDS }).catch(() => null));
  if (!i) continue;
  cards.push({
    id,
    url: "https://issues.bloomlibrary.org/youtrack/issue/" + id,
    summary: i.summary,
    state: field(i, "State"),
    board: field(i, "Kanban Board"),
    assignedToDeveloper: assigned.some(a => a.idReadable === id),
    updated: new Date(i.updated).toISOString().slice(0, 10),
  });
}

const kept = board ? cards.filter(c => c.board?.toLowerCase() === board.toLowerCase()) : cards;
if (board && !kept.length) console.warn(`no cards are on the board "${board}"; the values seen were: ${[...new Set(cards.map(c => c.board))].join(", ")}`);
const keptIds = new Set(kept.map(c => c.id));
const onBoard = card => !board || keptIds.has(card);

// The developer's open PRs in every GitHub repo a card's worktree belongs to.
const repos = new Set(worktrees.map(w => w.repo).filter(r => r?.startsWith("github:")).map(r => r.slice(7)));
repos.add("bloombooks/bloomdesktop");
const prs = [];
for (const repo of repos) {
  const text = run("gh", ["pr", "list", "-R", repo, "--author", "@me", "--state", "open", "--limit", "100", "--json",
    "number,url,title,headRefName,baseRefName,isDraft,mergeable,reviewDecision,reviewRequests,additions,deletions,changedFiles,updatedAt"]);
  for (const p of JSON.parse(text || "[]")) {
    prs.push({ ...p, repo, card: (p.headRefName.match(CARD) || p.title.match(CARD) || [])[0]?.toUpperCase() ?? null, reviewRequests: p.reviewRequests.map(r => r.login) });
  }
}

const result = { gatheredAt: new Date().toISOString(), board, cards: kept, worktrees: worktrees.filter(w => onBoard(w.card)), prs: prs.filter(p => onBoard(p.card)) };
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`wrote ${out}${board ? ` for ${board}` : ""}: ${result.cards.length} cards, ${result.worktrees.length} worktrees, ${result.prs.length} PRs`);
