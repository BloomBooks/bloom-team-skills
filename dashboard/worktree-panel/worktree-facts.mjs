// What the Worktree panel shows about one Orca worktree: the dashboard's row for it, worked out
// with the dashboard's own rules (../row-facts.mjs) from the same places the dashboard server reads
// (the rows the dashboard session wrote, the preflight run progress.mjs records, Orca's agents),
// with the PR and the card read live from GitHub and YouTrack; then the checkout's git state and
// the transcript of the Claude session that runs there.
//
// Plain JavaScript, so that `node worktree-facts.mjs <worktree path>` prints the panel's state
// without loading the plugin into Orca. Under Orca, worker.ts imports worker-env.mjs first, which
// gives the worker the environment that gh, reviewable and orca need.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { agentState, cardOf, checkoutState, checksState, enrichRows, liveAgents, norm, panelRow, questionOf, readJson, readProgress, readRows, reportDecisions, reportOf, rowOfWorktree, skillOf } from "../row-facts.mjs";
import { oneLine, promptText, typedPrompt } from "../transcripts.mjs";
import { ownReview } from "../own-review.mjs";
import { orca, openWorktree, openInVsCode as openFolder, runSkill as runSkillIn, sendPrompt as sendPromptTo } from "../../orca-worktrees.mjs";

const execFileP = promisify(execFile);
const home = os.homedir();
const YT = "https://issues.bloomlibrary.org/youtrack/api";
// The PR and the card come over the network, so they are read again at most this often.
const SLOW_MS = 60_000;
const OWN_REVIEW_MS = 120_000;
const PROMPTS_SHOWN = 3;

// Every command runs from the home folder: Orca starts its plugin workers in its own install
// folder, where a command named `orca` would find Orca.exe.
async function run(cmd, args, more = {}) {
  try {
    return (await execFileP(cmd, args, { cwd: home, windowsHide: true, maxBuffer: 64 << 20, encoding: "utf8", timeout: 30_000, ...more })).stdout.trim();
  } catch {
    return null;
  }
}
const git = (wt, ...args) => run("git", ["-C", wt, ...args]);

// ---- the worktree and its sessions -----------------------------------------------------------

const stripRef = b => (b || "").replace(/^refs\/heads\//, "");

// The Orca worktree that a workspace context (from workspace.readContext) names: same display name
// and branch, or failing that, the only one on that branch.
async function findWorktree({ displayName, branch, terminalIds = [], path: wt }) {
  const list = (await orca("worktree", "ps")).worktrees.filter(w => !w.isArchived);
  if (wt) return list.find(x => norm(x.path) === norm(wt)) ?? null;
  // Many worktrees share a name and branch (every repo's own checkout is "main" on main); the
  // context's terminals belong to exactly one.
  if (terminalIds.length) {
    const ids = new Set(terminalIds);
    const owner = (await orca("terminal", "list")).terminals.find(t => ids.has(t.handle) || ids.has(t.ptyId));
    const w = owner && list.find(x => norm(x.path) === norm(owner.worktreePath));
    if (w) return w;
  }
  const b = stripRef(branch);
  const onBranch = list.filter(w => stripRef(w.branch) === b);
  return list.find(w => w.displayName === displayName && stripRef(w.branch) === b)
    ?? (onBranch.length === 1 ? onBranch[0] : null)
    ?? list.find(w => w.displayName === displayName)
    ?? null;
}

// The Claude sessions in the worktree, for the panel's session picker, each with its Claude Code
// session id and transcript. Orca gives both as `providerSession`; an Orca without that field
// leaves the id to Orca's agent-hook record.
function sessionsOf(w) {
  const agents = (w.agents || []).filter(a => !a.parentPaneKey);
  const ids = agents.every(a => a.providerSession?.id) ? new Map() : claudeSessionIds();
  return agents.map(a => ({
    paneKey: a.paneKey,
    sessionId: a.providerSession?.id ?? ids.get(a.paneKey) ?? null,
    transcriptPath: a.providerSession?.transcriptPath ?? null,
    agent: a.agentType || "agent",
    title: a.conversationName || a.displayName || a.taskTitle || "",
    state: agentState(a),
    question: questionOf(a),
    skill: skillOf(a),
    prompt: oneLine(promptText(a.prompt || "")),
    updatedAt: a.updatedAt || 0,
    lastMessage: String(a.lastAssistantMessage || "").slice(0, 600),
  }));
}

// The pane the worktree has selected, the one the developer sees in it, as `tabId:leafId`. Orca
// marks that terminal `activeInWorkspace`; an Orca without the mark still reports each tab group's
// selected tab and each tab's selected pane, which settle it when the worktree has one tab group.
async function selectedPane(wt) {
  let list;
  try {
    list = await orca("terminal", "list", "--worktree", "path:" + wt, "--include-visual-layouts");
  } catch {
    return null;
  }
  const marked = list.terminals.find(t => t.activeInWorkspace);
  if (marked) return `${marked.tabId}:${marked.leafId}`;
  const root = list.visualLayouts?.find(l => norm(l.worktreePath) === norm(wt))?.root;
  if (root?.type !== "group") return null;
  const tab = root.tabs.find(t => t.tabId === root.activeTabId);
  return tab?.activeLeafId ? `${tab.tabId}:${tab.activeLeafId}` : null;
}

// The session the panel follows when neither the developer's pick nor the worktree's selected pane
// names one: the one they last typed a prompt into, from its transcript.
function defaultSession(wt, sessions) {
  const lastPrompt = a => sessionTranscript(wt, a)?.prompts.at(-1)?.at ?? 0;
  return [...sessions].map(a => ({ a, at: a.sessionId ? lastPrompt(a) : 0 }))
    .sort((x, y) => y.at - x.at || y.a.updatedAt - x.a.updatedAt)[0]?.a ?? null;
}

// ---- git -------------------------------------------------------------------------------------

async function gitFacts(wt) {
  const [status, base] = await Promise.all([
    git(wt, "status", "--porcelain=v2", "--branch"),
    git(wt, "rev-parse", "--abbrev-ref", "origin/HEAD"),
  ]);
  let changed = 0, unpushed = null;
  for (const line of (status || "").split(/\r?\n/)) {
    if (line.startsWith("# branch.ab ")) unpushed = Number((/\+(\d+)/.exec(line) || [])[1] ?? 0);
    else if (line && !line.startsWith("#")) changed++;
  }
  const b = base || "origin/master";
  const behind = await git(wt, "rev-list", "--count", `HEAD..${b}`);
  return { changed, unpushed, base: b.replace(/^origin\//, ""), behind: behind == null ? null : Number(behind) };
}

// ---- the PR and the card, as gather.mjs reads them -------------------------------------------

async function prFacts(wt) {
  const text = await run("gh", ["pr", "view", "--json", "number,url,state,isDraft,mergeable,statusCheckRollup,body"], { cwd: wt });
  if (!text) return null;
  const { statusCheckRollup, body, ...p } = JSON.parse(text);
  const report = reportOf(body);
  return { ...p, checks: checksState(statusCheckRollup), report, reportDecisions: report ? await reportDecisions(report) : null };
}

let botToken = null;
async function youtrackToken() {
  botToken ??= process.env.YOUTRACK_BOT || (await run("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('YOUTRACK_BOT','User')"])) || "";
  return botToken;
}
async function cardFacts(id) {
  const url = "https://issues.bloomlibrary.org/youtrack/issue/" + id;
  try {
    const r = await fetch(`${YT}/issues/${id}?fields=summary,customFields(name,value(name)),tags(name)`, {
      headers: { Authorization: "Bearer " + (await youtrackToken()), Accept: "application/json" }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const i = await r.json();
    return {
      id, url, summary: i.summary,
      state: i.customFields?.find(c => c.name === "State")?.value?.name ?? null,
      approvedPlan: (i.tags || []).some(t => t.name === "Approved Plan"),
    };
  } catch {
    return { id, url, summary: "", state: null, approvedPlan: false };
  }
}

const slow = new Map();     // worktree -> { at, cardId, card, pr }
async function slowFacts(wt, cardId) {
  let s = slow.get(wt);
  if (!s || s.cardId !== cardId || Date.now() - s.at > SLOW_MS) {
    const [card, pr] = await Promise.all([cardId ? cardFacts(cardId) : null, prFacts(wt)]);
    s = { at: Date.now(), cardId, card, pr };
    slow.set(wt, s);
  }
  return s;
}

// How much of the PR the developer has marked reviewed (own-review.mjs, as the server counts it
// once a minute). It reads every file's marks, which takes a while, so this answers with the last
// count and counts again in the background.
const reviews = new Map();  // PR URL -> { at, value, pending }
function ownReviewOf(prUrl) {
  let r = reviews.get(prUrl);
  if (!r) { r = { at: 0, value: null, pending: false }; reviews.set(prUrl, r); }
  if (!r.pending && Date.now() - r.at > OWN_REVIEW_MS) {
    r.pending = true;
    Promise.resolve().then(() => ownReview(prUrl, readJson(path.join(home, ".claude", "bloom-developer.json")).github))
      .then(v => { r.value = v; }, () => {}).finally(() => { r.at = Date.now(); r.pending = false; });
  }
  return r.value;
}

// ---- the session's transcript ----------------------------------------------------------------

// Each transcript's title and last prompts, kept until the file changes.
const transcripts = new Map();
function readTranscript(file) {
  const st = fs.statSync(file);
  const known = transcripts.get(file);
  if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) return known;
  let customTitle = "", aiTitle = "", prompts = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    // A title the developer gave with /rename beats the one Claude Code made up.
    if (j.type === "custom-title" && j.customTitle) customTitle = j.customTitle;
    else if (j.type === "ai-title" && j.aiTitle) aiTitle = j.aiTitle;
    const text = typedPrompt(j);
    // "[Image #3]" stands where the developer pasted a picture, which the panel cannot show.
    if (text) prompts.push({ text: oneLine(promptText(text).replace(/\[Image #\d+\]/g, "")), at: Date.parse(j.timestamp) || 0 });
  }
  prompts = prompts.filter(p => p.text).slice(-PROMPTS_SHOWN);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, title: customTitle || aiTitle, prompts };
  transcripts.set(file, entry);
  return entry;
}

// The folder of ~/.claude/projects that holds the transcripts of sessions started in `wt`: Claude
// Code names it after the path with every character other than a letter or digit made "-".
function projectFolder(wt) {
  const want = wt.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  const root = path.join(home, ".claude", "projects");
  try {
    const name = fs.readdirSync(root).find(n => n.toLowerCase() === want);
    return name ? path.join(root, name) : null;
  } catch {
    return null;
  }
}

// The Claude Code session id that runs in each Orca pane, from the record Orca's agent hooks keep
// (agent-hooks/last-status.json, `entries[paneKey].agentPresence.session`). It names the
// session's transcript, <id>.jsonl.
function claudeSessionIds() {
  try {
    const j = readJson(path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "orca", "agent-hooks", "last-status.json"));
    return new Map(Object.values(j.entries || {}).filter(e => e.agentPresence?.agent === "claude" && e.agentPresence.session)
      .map(e => [e.paneKey, e.agentPresence.session]));
  } catch {
    return new Map();
  }
}

// A session's transcript: the file Orca reports for it, or the one its session id names, or with
// no session (none is running in the worktree), the worktree's newest.
function sessionTranscript(wt, session) {
  if (session?.transcriptPath && fs.existsSync(session.transcriptPath)) {
    const t = readTranscript(session.transcriptPath);
    return { id: session.sessionId, title: t.title, prompts: t.prompts, updatedAt: t.mtimeMs };
  }
  const folder = projectFolder(wt);
  if (!folder) return null;
  let file = session?.sessionId ? path.join(folder, session.sessionId + ".jsonl") : null;
  if (file && !fs.existsSync(file)) return null;
  if (!file) {
    file = fs.readdirSync(folder).filter(n => n.endsWith(".jsonl")).map(n => path.join(folder, n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!file) return null;
  }
  const t = readTranscript(file);
  return { id: path.basename(file, ".jsonl"), title: t.title, prompts: t.prompts, updatedAt: t.mtimeMs };
}

// ---- the whole state -------------------------------------------------------------------------

const workingSeen = new Map();

/**
 * Everything the panel shows about the worktree that Orca's focused workspace context names:
 * `d`, the dashboard's row for it in the shape row.js draws (before Orca's live agents, which the
 * panel applies with row.js's withLiveAgents), `live`, what liveAgents() makes of the worktree's
 * agents, and the checkout and the followed session. `paneKey` picks the session to follow when
 * the worktree runs several.
 */
export async function worktreeState({ displayName, branch, paneKey, terminalIds, path: wtPath }) {
  const w = await findWorktree({ displayName, branch, terminalIds, path: wtPath });
  if (!w) return { found: false, reason: `Orca lists no worktree named ${displayName || branch}.` };
  const wt = w.path;
  const b = stripRef(w.branch);
  const branchCard = cardOf(b, wt);
  const row = rowOfWorktree(readRows(), wt, branchCard);
  const cardId = cardOf(row?.card) ?? branchCard;
  const runs = readProgress();
  const run = runs.get(norm(wt));
  const [gitState, checkout, { card, pr }] = await Promise.all([gitFacts(wt), checkoutState(wt), slowFacts(wt, cardId)]);

  const d = panelRow({ row, cardId, card, pr, run, checkout, worktree: wt, title: w.displayName || b });
  // The card's State and the PR are read live here, where the server reads them from facts.json.
  if (card?.state) d.ytState = card.state;
  const openPr = pr && pr.state === "OPEN" ? [{ url: pr.url, isDraft: pr.isDraft, mergeable: pr.mergeable, checks: pr.checks }] : [];
  const reviewed = d.pr && d.nextSkill === "request-peer-review" ? ownReviewOf(d.pr) : null;
  enrichRows([d], { prs: openPr, cards: card ? [{ id: card.id, approvedPlan: card.approvedPlan }] : [] },
    new Map(reviewed ? [[d.pr, reviewed]] : []), runs, new Map(checkout ? [[norm(wt), checkout]] : []));
  if (pr && pr.state !== "OPEN" && pr.url === d.pr) d.prState = pr.state.toLowerCase();

  const sessions = sessionsOf(w);
  const selected = await selectedPane(wt);
  const followed = sessions.find(a => a.paneKey === paneKey)
    ?? sessions.find(a => a.paneKey === selected)
    ?? defaultSession(wt, sessions);
  return {
    found: true,
    d,
    live: liveAgents(w, run, workingSeen),
    hasRow: !!row,
    repo: w.repo || path.basename(wt),
    branch: b,
    git: gitState,
    sessions: sessions.map(({ updatedAt, transcriptPath, ...a }) => a),
    followed: followed?.paneKey ?? null,
    selectedPane: selected,
    session: sessionTranscript(wt, followed),
  };
}

// ---- the panel's buttons ---------------------------------------------------------------------
// Each acts on the Claude session the panel follows (`paneKey`); a named session that is gone is
// an error, never another session. orca-worktrees.mjs does the work, as it does for the server.

// The Code step's button: shows the worktree's Claude terminal, or starts Claude there.
export const openSession = ({ path: wt, paneKey }) => openWorktree(wt, paneKey);
// The worktree's path: opens the folder in VS Code.
export const openInVsCode = ({ path: wt }) => openFolder(wt);
// Types /<skill> into the session, or starts Claude there with it when the worktree has no agent.
export const runSkill = ({ path: wt, skill, paneKey }) => runSkillIn(wt, skill, paneKey);

// The prompts the Checkout's links type into the session: Commit, and Commit and Push.
export const PROMPTS = { commit: "commit", "commit-push": "commit and push" };
export function sendPrompt({ path: wt, prompt, paneKey }) {
  const text = PROMPTS[prompt];
  if (!text) throw new Error("not a prompt this panel sends: " + prompt);
  return sendPromptTo(wt, text, paneKey);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const wt = process.argv[2];
  if (!wt) { console.error("usage: node worktree-facts.mjs <worktree path>"); process.exit(1); }
  const w = (await orca("worktree", "ps")).worktrees.find(x => norm(x.path) === norm(wt));
  if (!w) { console.error("Orca has no worktree at " + wt); process.exit(1); }
  let state = await worktreeState({ path: w.path });
  // Let the background own-review count finish, then ask again to show it.
  if (state.d?.pr && state.d.nextSkill === "request-peer-review" && !state.d.ownReview) {
    for (let i = 0; i < 90 && reviews.get(state.d.pr)?.pending; i++) await new Promise(r => setTimeout(r, 1000));
    state = await worktreeState({ path: w.path });
  }
  console.log(JSON.stringify(state, null, 2));
}
