// Finds the Orca worktree for a YouTrack card, or makes one, and shows it in Orca with Claude
// running in it. Assigns the card to the developer and moves it to In Progress; stops before
// touching anything when the card is assigned to someone else.
//
// Usage: node work-on-youtrack.mjs <card> [--repo <owner/name>] [--prompt <text>] [--dry-run] [--json]
//   <card>      BL-16627 (or BL16627), or a YouTrack URL that contains it
//   --repo      the GitHub repo for a new worktree when the card has no PR (default
//               bloombooks/bloomdesktop); also limits the search for worktrees and PRs to that repo
//   --prompt    the first message for the Claude this starts (a hand-off's brief). Claude starts as
//               a chat or in a terminal per the developer's Orca setting, and Orca can give a chat
//               only its first message, so a brief goes here. Not sent when the worktree already
//               has a Claude session (`agent` true).
//   --dry-run   reads the card, finds or names the worktree, then prints what it would do; changes
//               nothing on the card
//   --json      prints one JSON object instead of text: { ok, action, card, summary, state,
//               pr, worktree, branch, words, wordsFrom, agent, terminal, launch, others, assigned,
//               movedTo, placedAfter, placeError, dashboard, error }. `agent` is true when the
//               worktree already had a Claude session (a chat or a terminal, whose handle is
//               `terminal`); `launch` is what this started: { kind ("structured" for a chat, or
//               "terminal"), handle, delivered (Orca's word on the first message) }.
//
// Exit code 0 on success, 1 on any failure (the text or JSON says why).
import { spawn } from "node:child_process";
import {
  orca, norm, orcaRepoId, prHeadBranch, titleWords, agentTerminal, cardWorktrees,
  openWorktree, createWorktree, launchClaude, bringOrcaToFront,
} from "../orca-worktrees.mjs";
import { cardId, yt, readCard, cardFields, openPrs } from "../youtrack-card.mjs";
import { developer } from "../developer.mjs";
import { tellDashboard } from "../orca-bloom-dashboard-plugin/report/tell.mjs";

const DEFAULT_REPO = "bloombooks/bloomdesktop";
const IN_PROGRESS = "In Progress";

// ---- arguments ------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const dryRun = flag("--dry-run");
const asJson = flag("--json");
const repoAt = argv.indexOf("--repo");
const repoArg = repoAt >= 0 ? (argv[repoAt + 1] || "").toLowerCase() : null;
const promptAt = argv.indexOf("--prompt");
const promptArg = promptAt >= 0 ? argv[promptAt + 1] || "" : null;
const cardArg = argv.find((a, i) => !a.startsWith("--") && !(repoAt >= 0 && i === repoAt + 1) && !(promptAt >= 0 && i === promptAt + 1));

function finish(result) {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.log("work-on-youtrack failed: " + result.error);
  else console.log(describe(result));
  process.exit(result.ok ? 0 : 1);
}

// ---- YouTrack -------------------------------------------------------------------------------
// The ordinal of In Progress in the card's project, so a card further along (in review, in
// testing) stays where it is.
async function inProgressOrdinal(id) {
  const project = (await yt(`/issues/${id}?fields=project(shortName)`)).project.shortName;
  const fields = await yt(`/admin/projects/${project}/customFields?fields=field(name),bundle(values(name,ordinal))`);
  const v = fields.find(f => f.field?.name === "State")?.bundle?.values?.find(x => x.name === IN_PROGRESS);
  if (!v) throw new Error(`the ${project} project has no "${IN_PROGRESS}" state`);
  return v.ordinal;
}
// Assigns the card to `login` when it has no assignee and moves it to In Progress when its State
// comes before that. Reads both fields back. Returns { assigned, movedTo }.
async function takeCard(id, info, login, target) {
  const out = { assigned: false, movedTo: null };
  if (!info.assignee) {
    await yt("/commands", { query: `Assignee ${login}`, issues: [{ idReadable: id }] });
    out.assigned = true;
  }
  if (info.stateOrdinal === null || info.stateOrdinal < target) {
    await yt(`/issues/${id}?fields=id`, { customFields: [{ name: "State", $type: "StateIssueCustomField", value: { name: IN_PROGRESS } }] });
    out.movedTo = IN_PROGRESS;
  }
  const now = await cardFields(id);
  if (now.assignee?.login !== login) throw new Error(`assigning ${id} to ${login} did not take (the Assignee is ${now.assignee?.login ?? "empty"}); see the youtrack-api skill, §1`);
  if (out.movedTo && now.state !== IN_PROGRESS) throw new Error(`moving ${id} to ${IN_PROGRESS} did not take (the State is ${now.state})`);
  return out;
}

// The developer's last card in the In Progress column of the card's board (the agile board's
// sprint named by the card's "Kanban Board" field), in the board's order, leaving the card itself
// out. Returns { board, column, cell, after: { id, idReadable } | null, card: <internal id> | null }.
const AGILE = "89-5"; // Bloom Kanban
async function inProgressCell(id, login) {
  const kanban = (await yt(`/issues/${id}?fields=customFields(name,value(name))`)).customFields?.find(c => c.name === "Kanban Board")?.value?.name;
  if (!kanban) throw new Error(`${id} has no Kanban Board`);
  const sprint = (await yt(`/agiles/${AGILE}?fields=sprints(id,name)`)).sprints.find(s => s.name === kanban);
  if (!sprint) throw new Error(`the Bloom Kanban board has no sprint named "${kanban}"`);
  const base = `/agiles/${AGILE}/sprints/${sprint.id}/board`;
  const cells = "cells(id,column(id,presentation),issues(id,idReadable,customFields(name,value(login))))";
  const b = await yt(`${base}?fields=sortByQuery,orphanRow(${cells}),trimmedSwimlanes(${cells})`);
  if (b.sortByQuery) throw new Error(`the ${kanban} board sorts by a query, so it has no order to set`);
  // Swimlanes are cards with subtasks; a card's own row holds it, so look for the card's row first.
  const rows = [b.orphanRow, ...(b.trimmedSwimlanes || [])].map(r => r.cells.find(c => c.column.presentation === IN_PROGRESS)).filter(Boolean);
  const cell = rows.find(c => c.issues.some(i => i.idReadable === id)) || b.orphanRow.cells.find(c => c.column.presentation === IN_PROGRESS);
  if (!cell) throw new Error(`the ${kanban} board has no ${IN_PROGRESS} column`);
  const assignee = i => i.customFields?.find(f => f.name === "Assignee")?.value?.login;
  const after = cell.issues.filter(i => i.idReadable !== id && assignee(i) === login).at(-1) || null;
  return { board: kanban, base, cell, after, card: cell.issues.find(i => i.idReadable === id)?.id ?? null };
}
// Puts the card, just moved to In Progress, right after the developer's last card in that column,
// so the developer's cards stay together and in the order they took them. Leaves it alone when the
// developer has no other card there. Returns the card it now follows, or null.
async function placeAfterMine(id, login) {
  let c;
  // YouTrack can take a moment to show a card in its new column.
  for (let tries = 0; tries < 5; tries++) {
    c = await inProgressCell(id, login);
    if (c.card || !c.after) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!c.after) return null;
  if (!c.card) throw new Error(`${id} does not show in the ${c.board} board's ${IN_PROGRESS} column`);
  const ids = c.cell.issues.map(i => i.id);
  if (ids.indexOf(c.card) !== ids.indexOf(c.after.id) + 1) {
    await yt(`${c.base}/columns/${c.cell.column.id}/cells/${c.cell.id}/issueOrder?fields=leading(id),moved(id)`, { leading: { id: c.after.id }, moved: { id: c.card } });
  }
  return c.after.idReadable;
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

// ---- the dashboard -------------------------------------------------------------------------
// Tells the dashboard service that a card changed, so the card shows up with its new Assignee,
// State and worktree now. Returns true when a service took the request, false when none is running.
const refreshDashboard = () => tellDashboard("card-changed");

// ---- output ---------------------------------------------------------------------------------
function describe(r) {
  const lines = [`${r.card}: ${r.summary}${r.state ? ` (${r.state})` : ""}`];
  if (r.pr) lines.push(`PR: ${r.pr}`);
  const would = r.action.startsWith("would-");
  if (r.action.endsWith("open")) {
    lines.push(`${would ? "Would open" : "Opened"} ${r.worktree} (branch ${r.branch})`);
    if (r.terminal) lines.push(`${would ? "Would switch" : "Switched"} to its Claude terminal (${r.terminal}).`);
    else if (r.agent) lines.push("It already has a Claude chat; open it in Orca.");
    else if (promptArg !== null) lines.push(`${would ? "Would start" : "Started"} Claude there with the prompt.`);
    else lines.push(`${would ? "Would start" : "Started"} Claude there (claude --continue || claude).`);
  } else {
    const from = r.pr ? `on the PR's branch ${r.branch}` : `on a new branch ${r.branch}` + (r.base ? ` from origin/${r.base}` : "") + (r.wordsFrom === "claude" ? " (words from Claude)" : " (words from the title; Claude gave no usable answer)");
    lines.push(`${would ? "Would create" : "Created"} a worktree in ${r.repo} ${from}${r.worktree ? ` at ${r.worktree}` : ""}, with Claude running in it.`);
  }
  if (r.others?.length) lines.push("Other worktrees for this card: " + r.others.join(", "));
  if (r.otherPrs?.length) lines.push("Other open PRs for this card: " + r.otherPrs.join(", "));
  const changes = [r.assigned && `assigned to ${r.login}`, r.movedTo && `moved to ${r.movedTo}`].filter(Boolean);
  if (changes.length) lines.push(`${would ? "Would mark" : "Marked"} the card ${changes.join(" and ")}.`);
  if (r.placedAfter) lines.push(`${would ? "Would place" : "Placed"} it after ${r.placedAfter}, your last card in ${IN_PROGRESS}.`);
  if (r.placeError) lines.push(`Could not place it after your other ${IN_PROGRESS} cards: ${r.placeError}`);
  if (r.dashboard) lines.push("Asked the dashboard to refresh.");
  if (r.frontError) lines.push("Could not bring Orca to the front: " + r.frontError);
  return lines.join("\n");
}

// ---- main -----------------------------------------------------------------------------------
async function main() {
  const card = cardId(cardArg);
  if (!card) throw new Error("usage: node work-on-youtrack.mjs <BL-nnnnn> [--repo <owner/name>] [--prompt <text>] [--dry-run] [--json]");
  if (repoArg !== null && !/^[\w.-]+\/[\w.-]+$/.test(repoArg)) throw new Error("--repo needs <owner/name>, e.g. bloombooks/bloomdesktop");

  const info = await readCard(card);
  const me = (await developer()).youtrack.login;
  if (info.assignee && info.assignee.login !== me) {
    throw new Error(`${card} is assigned to ${info.assignee.fullName} (${info.assignee.login}), not to you (${me}). Nothing was opened or changed.`);
  }
  const target = await inProgressOrdinal(card);
  const prs = await openPrs(card, info, repoArg);
  const worktrees = await cardWorktrees(card, prs, repoArg);
  const result = { ok: true, card, summary: info.summary, state: info.state, dryRun };
  if (prs.length > 1) result.otherPrs = prs.slice(1).map(p => p.url);

  if (worktrees.length) {
    const [wt, ...others] = worktrees;
    const pr = wt.onPr || prs[0];
    Object.assign(result, { action: dryRun ? "would-open" : "open", worktree: wt.path, branch: wt.branch, repo: wt.repo, pr: pr?.url || null, others: others.map(o => o.path) });
    if (pr) result.otherPrs = prs.filter(p => p !== pr).map(p => p.url);
    result.terminal = (await agentTerminal(wt.path))?.handle || null;
    // A chat has no terminal, but Orca lists it among the worktree's agents.
    result.agent = !!result.terminal || !!(await orca("worktree", "ps")).worktrees.find(x => norm(x.path) === norm(wt.path))?.agents?.length;
    if (!dryRun) {
      // Orca cannot show a chat tab from outside; bringOrcaToFront below shows the worktree's window.
      if (result.terminal) await openWorktree(wt.path);
      else if (!result.agent && promptArg !== null) result.launch = await launchClaude(wt.path, promptArg);
      else if (!result.agent) await openWorktree(wt.path);
    }
  } else if (prs.length) {
    const pr = prs[0];
    await orcaRepoId(pr.repo);
    const head = await prHeadBranch(pr.repo, String(pr.number));
    Object.assign(result, { action: dryRun ? "would-create" : "create", repo: pr.repo, pr: pr.url, branch: head });
    if (!dryRun) {
      const made = await createWorktree({ card, title: info.summary, pr: pr.url, prompt: promptArg });
      Object.assign(result, { worktree: made.path, launch: made.launch });
    }
  } else {
    const repo = repoArg || DEFAULT_REPO;
    await orcaRepoId(repo);
    let words = await claudeWords(card, info);
    result.wordsFrom = words ? "claude" : "title";
    words ||= titleWords(info.summary);
    Object.assign(result, { action: dryRun ? "would-create" : "create", repo, pr: null, words: words.join("-"), branch: [card, ...words].join("-") });
    if (!dryRun) {
      const made = await createWorktree({ card, title: info.summary, words, repo, prompt: promptArg });
      result.worktree = made.path;
      if (made.branch) result.branch = made.branch;
      result.base = made.base;
      result.launch = made.launch;
    }
  }
  result.login = me;
  if (dryRun) {
    Object.assign(result, { assigned: !info.assignee, movedTo: info.stateOrdinal === null || info.stateOrdinal < target ? IN_PROGRESS : null });
    if (result.movedTo) {
      try { result.placedAfter = (await inProgressCell(card, me)).after?.idReadable || null; } catch (e) { result.placeError = e.message; }
    }
  } else {
    Object.assign(result, await takeCard(card, info, me, target));
    if (result.movedTo) {
      try { result.placedAfter = await placeAfterMine(card, me); } catch (e) { result.placeError = e.message; }
    }
    result.dashboard = await refreshDashboard();
  }
  if (!dryRun) await bringOrcaToFront().catch(e => { result.frontError = e.message; });
  return result;
}

main().then(finish, e => finish({ ok: false, error: e.message }));
