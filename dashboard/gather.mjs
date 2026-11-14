// Reads the facts that live outside this machine's sessions: the developer's cards from YouTrack,
// their open PRs from GitHub, Orca's worktrees, and (unless `core`) the lists that take longer:
// each worktree's git state, "Back with you for review", History and the worktrees of resolved
// cards. The dashboard service calls gather() while a surface is visible; it also runs on its own:
//
// Usage: node gather.mjs <out.json> [board] [--core]
// board: a YouTrack "Kanban Board" value such as "Bloom 6.6" (or just "6.6"); only cards on that
// board are kept, and worktrees and PRs whose card is not on it are dropped. "all" keeps every
// board. With no board, the current version's board is used (see currentVersionBoard).
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { developer } from "../developer.mjs";
import { callService } from "../bloom-services/sources.mjs";
import { reviewedCards, backForReview as cardsBackForReview } from "./reviewed.mjs";
import { bloomRepos, standupDays } from "./standup.mjs";
import { cardOf, checksState, reportDecisions, reportOf } from "./row-facts.mjs";
import { agentState, orca as orcaCli } from "../orca-worktrees.mjs";
import { removalWarnings } from "./stale-worktrees.mjs";

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts }).trim();
  } catch (e) {
    return null;
  }
}
// The server logs the line that starts "Error:" when a gather fails, so the message says what to check.
async function orca(...args) {
  try {
    return await orcaCli(...args);
  } catch (e) {
    throw new Error(`orca ${args.join(" ")} failed; is Orca running? (${String(e.message).split("\n")[0]})`);
  }
}
// YouTrack, through the team's tool server (bloom-services), as the Bot account.
async function yt(path, params) {
  return (await callService("youtrack", `${path}?${new URLSearchParams(params)}`)).json();
}
const field = (issue, name) => issue.customFields?.find(c => c.name === name)?.value?.name ?? null;

// The current version's board: of the Kanban Board values named "Bloom <version>" that are not
// archived, the one with the most BL cards (anyone's) updated in the last 14 days; on a tie, the
// lower version. Returns { board, activity } where activity counts the cards per candidate.
async function currentVersionBoard() {
  const fields = await yt("/admin/projects/BL/customFields", { fields: "field(name),bundle(values(name,archived))", $top: "100" });
  const values = fields.find(f => f.field.name === "Kanban Board").bundle.values;
  const candidates = values.filter(v => !v.archived && /^Bloom \d+(\.\d+)*$/.test(v.name)).map(v => v.name);
  if (!candidates.length) throw new Error("no unarchived Kanban Board value is named Bloom <version>");
  const activity = Object.fromEntries(candidates.map(c => [c, 0]));
  for (let skip = 0; ; skip += 500) {
    const page = await yt("/issues", { query: "project: BL updated: {minus 14d} .. Today", fields: "customFields(name,value(name))", $top: "500", $skip: String(skip) });
    for (const i of page) { const b = field(i, "Kanban Board"); if (b in activity) activity[b]++; }
    if (page.length < 500) break;
  }
  const version = name => name.slice(6).split(".").map(Number);
  const lower = (a, b) => { const x = version(a), y = version(b); for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0); return 0; };
  const board = [...candidates].sort((a, b) => activity[b] - activity[a] || lower(a, b))[0];
  return { board, activity };
}

/**
 * Gathers the facts and returns them: { gatheredAt, core, board, boardActivity, cards, worktrees,
 * prs, standup, backForReview, staleWorktrees }. `board` as on the command line; `core` leaves
 * out the last three and each worktree's git state, which makes it one YouTrack query, one
 * `orca worktree list` and one `gh pr list` per repo. Throws when Orca, YouTrack or GitHub cannot
 * be read: a failed read is an error, never an empty list.
 */
export async function gather({ board: boardArg = null, core = false } = {}) {
  // Worktrees and the agents in them.
  const list = (await orca("worktree", "list")).worktrees.filter(w => !w.isArchived);
  const ps = core ? new Map() : new Map((await orca("worktree", "ps")).worktrees.map(w => [w.path, w]));

  const worktrees = [];
  for (const w of list) {
    const branch = (w.branch || "").replace("refs/heads/", "");
    const card = cardOf(branch, w.path);
    if (!card) continue;
    if (core) { worktrees.push({ card, path: w.path, repo: w.projectId, branch, main: !!w.isMainWorktree, name: w.displayName || "" }); continue; }
    const git = (...a) => run("git", ["-C", w.path, ...a]);
    const status = (git("status", "--porcelain") || "").split("\n").filter(Boolean);
    const base = git("rev-parse", "--abbrev-ref", "origin/HEAD") || "origin/master";
    const p = ps.get(w.path);
    worktrees.push({
      card,
      path: w.path,
      repo: w.projectId,
      branch,
      // A repo's main checkout, which the page never offers to remove.
      main: !!w.isMainWorktree,
      name: w.displayName || "",
      orcaComment: w.comment || "",
      modified: status.filter(l => !l.startsWith("??")).map(l => l.slice(3)),
      untracked: status.filter(l => l.startsWith("??")).length,
      hasUpstream: git("rev-parse", "--abbrev-ref", "@{u}") != null,
      // The branch's name on origin, which its PRs name, from git's config: it stays there after
      // GitHub deletes a merged PR's branch, when @{u} no longer resolves.
      upstreamBranch: git("config", "--get", `branch.${branch}.merge`)?.replace(/^refs\/heads\//, "") || null,
      // When Orca last saw anything happen in the worktree.
      lastActivity: w.lastActivityAt ? new Date(w.lastActivityAt).toISOString() : null,
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
  let board = null, boardActivity = null;
  if (!boardArg) ({ board, activity: boardActivity } = await currentVersionBoard());
  else if (boardArg.toLowerCase() !== "all") board = /^\d/.test(boardArg) ? "Bloom " + boardArg : boardArg;
  const FIELDS = "idReadable,summary,updated,resolved,customFields(name,value(name)),tags(name)";
  // Searching by assignee needs the Bot's global "Read User Basic Role".
  const assigned = await yt("/issues", { query: `Assignee: {${dev.youtrack.login}} #Unresolved`, fields: FIELDS, $top: "500" });
  const ids = new Set([...assigned.map(i => i.idReadable), ...worktrees.map(w => w.card)]);
  const cards = [];
  for (const id of ids) {
    const i = assigned.find(a => a.idReadable === id) ?? (await yt("/issues/" + id, { fields: FIELDS }).catch(() => null));
    if (!i) continue;
    cards.push({
      id,
      url: "https://issues.bloomlibrary.org/youtrack/issue/" + id,
      summary: i.summary,
      state: field(i, "State"),
      board: field(i, "Kanban Board"),
      assignedToDeveloper: assigned.some(a => a.idReadable === id),
      // A card tagged "Approved Plan" may be merged without peer review (merge-without-peer-review).
      approvedPlan: (i.tags || []).some(t => t.name === "Approved Plan"),
      updated: new Date(i.updated).toISOString().slice(0, 10),
      // Done, Closed, Won't Fix and the like: its worktrees are offered for removal (staleWorktrees).
      resolved: i.resolved ? new Date(i.resolved).toISOString() : null,
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
    // A failed list is an error, never an empty one: the server would report every PR in the repo
    // as merged or closed. Failing keeps the last facts, and the server reports the error once.
    if (text == null) throw new Error(`gh pr list failed for ${repo}; is gh signed in and GitHub reachable?`);
    for (const { statusCheckRollup, body, ...p } of JSON.parse(text)) {
      prs.push({
        ...p, repo, card: cardOf(p.headRefName, p.title),
        reviewRequests: p.reviewRequests.map(r => r.login), checks: checksState(statusCheckRollup),
        report: reportOf(body),
      });
    }
  }
  await Promise.all(prs.filter(p => p.report).map(async p => { p.reportDecisions = await reportDecisions(p.report); }));

  // board is null when every board was kept; boardActivity is set only when the board was chosen
  // by currentVersionBoard.
  // The cards whose PRs the developer reviewed lately, from every board (reviewed.mjs), and of
  // those, the cards in Ready For Code Review that need the developer, judged from all of each card's
  // PRs: backForReview. null when GitHub or YouTrack would not give them, so the page keeps no stale
  // list and the rest of the gather still counts.
  let reviewed = null;
  if (!core) try { reviewed = await reviewedCards(yt, dev.github, dev.youtrack.login); }
  catch (e) { console.warn("could not list reviewed cards: " + e.message); }
  let backForReview = null;
  if (reviewed) {
    try { backForReview = cardsBackForReview(reviewed, dev.github); }
    catch (e) { console.warn("could not judge the reviewed cards' PRs: " + e.message); }
  }
  // What the developer did on their most recent working days, from every board (standup.mjs);
  // null in the same way.
  let standup = null;
  if (!core) try {
    standup = await standupDays({ yt, githubLogin: dev.github, youtrackLogin: dev.youtrack.login, gitName: dev.git, worktrees, repos: bloomRepos((await orca("repo", "list")).repos), reviewed: reviewed || [] });
  } catch (e) { console.warn("could not list the standup days: " + e.message); }

  // The worktrees whose card is resolved, from every board, with the signs of work left in each
  // (stale-worktrees.mjs); the page's last section offers to remove them. null when GitHub would not
  // say, so the page offers none on facts it could not check.
  let staleWorktrees = null;
  if (!core) try { staleWorktrees = await listStaleWorktrees(); }
  catch (e) { console.warn("could not list the worktrees of resolved cards: " + e.message); }

  async function listStaleWorktrees() {
    const execFileP = promisify(execFile);
    const ghJson = async args => JSON.parse((await execFileP("gh", args, { maxBuffer: 64 << 20, windowsHide: true })).stdout);
    const resolved = new Map(cards.filter(c => c.resolved).map(c => [c.id, c]));
    const stale = worktrees.filter(w => resolved.has(w.card) && !w.main);
    const repoOf = w => w.repo?.startsWith("github:") ? w.repo.slice(7) : null;
    // Every open PR, by anyone, in the repos these worktrees belong to; a card's are those that name it.
    const open = new Map(await Promise.all([...new Set(stale.map(repoOf).filter(Boolean))].map(async repo =>
      [repo, await ghJson(["pr", "list", "-R", repo, "--state", "open", "--limit", "500", "--json", "url,title,headRefName,isDraft,author"])])));
    const list = await Promise.all(stale.map(async w => {
      const repo = repoOf(w), card = resolved.get(w.card);
      const prs = (open.get(repo) || []).filter(p => cardOf(p.headRefName, p.title) === w.card)
        .map(p => ({ url: p.url, title: p.title, headRefName: p.headRefName, isDraft: p.isDraft, author: p.author?.login === dev.github ? "" : p.author?.login || "" }));
      // The newest merged PR from the branch, and the commits the branch has beyond it and its base.
      let branchPr = null, afterMerge = null;
      if (repo && w.upstreamBranch) {
        const merged = (await ghJson(["pr", "list", "-R", repo, "--head", w.upstreamBranch, "--state", "merged", "--json", "url,headRefOid,baseRefName,mergedAt"]))
          .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
        if (merged) {
          branchPr = { url: merged.url };
          const n = run("git", ["-C", w.path, "rev-list", "--count", "--no-merges", "HEAD", "^" + merged.headRefOid, "^origin/" + merged.baseRefName]);
          afterMerge = n == null ? null : Number(n);
        }
      }
      const agents = (ps.get(w.path)?.agents || []).map(a => ({ state: agentState(a) }));
      return {
        card: w.card, cardUrl: card.url, title: card.summary, state: card.state,
        path: w.path, name: w.name, branch: w.branch, orcaComment: w.orcaComment, lastCommit: w.lastCommit, pr: branchPr?.url || null,
        warnings: removalWarnings(w, { prs, branchPr, afterMerge, agents, resolvedAt: card.resolved }),
      };
    }));
    // The ones with nothing left in them first.
    return list.sort((a, b) => a.warnings.length - b.warnings.length || a.card.localeCompare(b.card, undefined, { numeric: true }));
  }

return { gatheredAt: new Date().toISOString(), core, board, boardActivity, cards: kept, standup, backForReview, staleWorktrees, worktrees: worktrees.filter(w => onBoard(w.card)), prs: prs.filter(p => onBoard(p.card)) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2).filter(a => a !== "--core");
  const out = args[0];
  if (!out) throw new Error("usage: node gather.mjs <out.json> [board|all] [--core]");
  const result = await gather({ board: args[1]?.trim() || null, core: process.argv.includes("--core") });
  writeFileSync(out, JSON.stringify(result, null, 2));
  if (result.boardActivity) console.log(`chose ${result.board}, the board with the most cards updated in the last 14 days: ${Object.entries(result.boardActivity).map(([b, n]) => `${b} ${n}`).join(", ")}`);
  console.log(`wrote ${out}${result.board ? ` for ${result.board}` : " for every board"}:${result.cards.length} cards, ${result.worktrees.length} worktrees, ${result.prs.length} PRs, ${result.staleWorktrees?.length ?? "?"} worktrees of resolved cards`);
}
