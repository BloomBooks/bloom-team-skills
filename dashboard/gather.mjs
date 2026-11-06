// Collects the facts the dashboard needs into one JSON file, so the agent reads one file
// instead of running dozens of commands.
// Usage: node gather.mjs <out.json> [board]
// board: a YouTrack "Kanban Board" value such as "Bloom 6.6" (or just "6.6"); only cards on that
// board are kept, and worktrees and PRs whose card is not on it are dropped. "all" keeps every
// board. With no board, the current version's board is used (see currentVersionBoard).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { developer } from "../developer.mjs";
import { finishedCards } from "./finished.mjs";
import { reviewedCards } from "./reviewed.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: node gather.mjs <out.json> [board|all]");
const boardArg = process.argv[3]?.trim() || null;

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

// The current version's board: of the Kanban Board values named "Bloom <version>" that are not
// archived, the one with the most BL cards (anyone's) updated in the last 14 days; on a tie, the
// lower version. Returns { board, activity } where activity counts the cards per candidate.
async function currentVersionBoard(token) {
  const fields = await yt(token, "/admin/projects/BL/customFields", { fields: "field(name),bundle(values(name,archived))", $top: "100" });
  const values = fields.find(f => f.field.name === "Kanban Board").bundle.values;
  const candidates = values.filter(v => !v.archived && /^Bloom \d+(\.\d+)*$/.test(v.name)).map(v => v.name);
  if (!candidates.length) throw new Error("no unarchived Kanban Board value is named Bloom <version>");
  const activity = Object.fromEntries(candidates.map(c => [c, 0]));
  for (let skip = 0; ; skip += 500) {
    const page = await yt(token, "/issues", { query: "project: BL updated: {minus 14d} .. Today", fields: "customFields(name,value(name))", $top: "500", $skip: String(skip) });
    for (const i of page) { const b = field(i, "Kanban Board"); if (b in activity) activity[b]++; }
    if (page.length < 500) break;
  }
  const version = name => name.slice(6).split(".").map(Number);
  const lower = (a, b) => { const x = version(a), y = version(b); for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0); return 0; };
  const board = [...candidates].sort((a, b) => activity[b] - activity[a] || lower(a, b))[0];
  return { board, activity };
}

// One word for a PR's CI checks: FAILURE if any failed, PENDING if any have not finished,
// SUCCESS when all passed, "" when it has none. Reviewable's status (code-review/reviewable) is
// left out: it stays PENDING until reviewers have seen every file, which says nothing about CI.
function checksState(rollup) {
  const results = (rollup || []).filter(c => c.context !== "code-review/reviewable").map(c => c.__typename === "StatusContext" ? c.state : (c.status === "COMPLETED" ? c.conclusion : "PENDING"));
  if (!results.length) return "";
  if (results.some(r => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(r))) return "FAILURE";
  if (results.some(r => ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"].includes(r))) return "PENDING";
  return "SUCCESS";
}

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
let board = null, boardActivity = null;
if (!boardArg) ({ board, activity: boardActivity } = await currentVersionBoard(bot));
else if (boardArg.toLowerCase() !== "all") board = /^\d/.test(boardArg) ? "Bloom " + boardArg : boardArg;
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
    "number,url,title,headRefName,baseRefName,isDraft,mergeable,reviewDecision,reviewRequests,additions,deletions,changedFiles,updatedAt,statusCheckRollup,body"]);
  for (const { statusCheckRollup, body, ...p } of JSON.parse(text || "[]")) {
    prs.push({
      ...p, repo, card: (p.headRefName.match(CARD) || p.title.match(CARD) || [])[0]?.toUpperCase() ?? null,
      reviewRequests: p.reviewRequests.map(r => r.login), checks: checksState(statusCheckRollup),
      // preflight puts "Preflight report: <url>" in the PR description.
      report: (String(body || "").match(/Preflight report:[^\n]*?(https:\/\/[^\s)\]>]+)/) || [])[1] ?? null,
    });
  }
}
// The number of decision items in the preflight report. Each item's options end with a
// "Leave as is" option (preflight's references/report-artifact.md), so this counts those labels;
// the report's own wording of "nothing is waiting" varies from run to run. null when the report
// cannot be read.
await Promise.all(prs.filter(p => p.report).map(async p => {
  try {
    const r = await fetch(p.report);
    if (!r.ok) throw new Error(String(r.status));
    p.reportDecisions = (await r.text()).split(/<[^>]*>/).filter(t => /^\s*Leave as is\s*$/i.test(t)).length;
  } catch { p.reportDecisions = null; }
}));

// board is null when every board was kept; boardActivity is set only when the board was chosen
// by currentVersionBoard.
// The developer's finished cards, from every board (finished.mjs). null when YouTrack would not
// give them, so the page keeps no stale list and the rest of the gather still counts.
let finished = null;
try { finished = await finishedCards((p, params) => yt(bot, p, params), dev.youtrack.login); }
catch (e) { console.warn("could not list finished cards: " + e.message); }
// The cards whose PRs the developer reviewed lately (reviewed.mjs); null in the same way.
let reviewed = null;
try { reviewed = await reviewedCards((p, params) => yt(bot, p, params), dev.github, dev.youtrack.login); }
catch (e) { console.warn("could not list reviewed cards: " + e.message); }

const result = { gatheredAt: new Date().toISOString(), board, boardActivity, cards: kept, finished, reviewed, worktrees: worktrees.filter(w => onBoard(w.card)), prs: prs.filter(p => onBoard(p.card)) };
writeFileSync(out, JSON.stringify(result, null, 2));
if (boardActivity) console.log(`chose ${board}, the board with the most cards updated in the last 14 days: ${Object.entries(boardActivity).map(([b, n]) => `${b} ${n}`).join(", ")}`);
console.log(`wrote ${out}${board ? ` for ${board}` : " for every board"}:${result.cards.length} cards, ${result.worktrees.length} worktrees, ${result.prs.length} PRs`);
