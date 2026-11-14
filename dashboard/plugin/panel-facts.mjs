// What only Orca and Claude Code's transcripts know about the worktree that Orca has focused, for
// the Worktree panel: which worktree it is, the Claude sessions in it, the pane the developer has
// selected, and the developer's last prompts in the followed session. The card's row and the
// checkout come from the dashboard service (worker.ts asks it).
//
// Plain JavaScript, so that `node panel-facts.mjs <worktree path>` prints it without Orca loading
// the plugin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { oneLine, promptText, typedPrompt } from "../transcripts.mjs";
import { agentState, norm, orca } from "../../orca-worktrees.mjs";

const home = os.homedir();
const PROMPTS_SHOWN = 3;
const stripRef = b => (b || "").replace(/^refs\/heads\//, "");
// The question a waiting agent asks in its terminal, or "".
const questionOf = a => a?.state === "waiting" && a.programStatus?.kind === "question" ? String(a.programStatus.message || "").replace(/^answer:\s*/, "") : "";

// The Orca worktree that a workspace context (from Orca's workspace.changed event) names. Many
// worktrees share a name and branch (every repo's own checkout is "main" on main); the context's
// terminals belong to exactly one.
async function findWorktree({ displayName, branch, terminalIds = [], path: wt }) {
  const list = (await orca("worktree", "ps")).worktrees.filter(w => !w.isArchived);
  if (wt) return list.find(x => norm(x.path) === norm(wt)) ?? null;
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

// The Claude sessions in the worktree, for the panel's session picker. Orca gives each one's
// Claude Code session id and transcript as `providerSession` on builds that report it.
function sessionsOf(w) {
  return (w.agents || []).filter(a => !a.parentPaneKey).map(a => ({
    paneKey: a.paneKey,
    sessionId: a.providerSession?.id ?? null,
    transcriptPath: a.providerSession?.transcriptPath ?? null,
    agent: a.agentType || "agent",
    title: a.conversationName || a.displayName || a.taskTitle || "",
    state: agentState(a),
    question: questionOf(a),
    prompt: oneLine(promptText(a.prompt || "")),
    updatedAt: a.updatedAt || 0,
    lastMessage: String(a.lastAssistantMessage || "").slice(0, 600),
  }));
}

// The pane the worktree has selected, the one the developer sees in it, as `tabId:leafId`. Orca
// marks that terminal `activeInWorkspace`; a build without the mark still reports each tab group's
// selected tab and each tab's selected pane, which settle it when the worktree has one tab group.
async function selectedPane(wt) {
  let list;
  try { list = await orca("terminal", "list", "--worktree", "path:" + wt, "--include-visual-layouts"); } catch { return null; }
  const marked = list.terminals.find(t => t.activeInWorkspace);
  if (marked) return `${marked.tabId}:${marked.leafId}`;
  const root = list.visualLayouts?.find(l => norm(l.worktreePath) === norm(wt))?.root;
  if (root?.type !== "group") return null;
  const tab = root.tabs.find(t => t.tabId === root.activeTabId);
  return tab?.activeLeafId ? `${tab.tabId}:${tab.activeLeafId}` : null;
}

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
  } catch { return null; }
}

// A session's transcript: the file Orca reports for it, or the one its session id names, or with
// neither, the worktree's newest.
function sessionTranscript(wt, session) {
  try {
    if (session?.transcriptPath && fs.existsSync(session.transcriptPath)) {
      const t = readTranscript(session.transcriptPath);
      return { id: session.sessionId, title: t.title, prompts: t.prompts, updatedAt: t.mtimeMs };
    }
    const folder = projectFolder(wt);
    if (!folder) return null;
    let file = session?.sessionId ? path.join(folder, session.sessionId + ".jsonl") : null;
    if (file && !fs.existsSync(file)) file = null;
    if (!file) {
      file = fs.readdirSync(folder).filter(n => n.endsWith(".jsonl")).map(n => path.join(folder, n))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (!file) return null;
    }
    const t = readTranscript(file);
    return { id: path.basename(file, ".jsonl"), title: t.title, prompts: t.prompts, updatedAt: t.mtimeMs };
  } catch { return null; }
}

/**
 * { found, path, repo, branch, sessions, followed, selectedPane, session } for the worktree that
 * the workspace context names. `paneKey` picks the session to follow when the worktree runs
 * several; without it the panel follows the selected pane, or failing that the session that the
 * developer last prompted.
 */
export async function panelFacts({ displayName, branch, paneKey, terminalIds, path: wtPath }) {
  const w = await findWorktree({ displayName, branch, terminalIds, path: wtPath });
  if (!w) return { found: false, reason: `Orca lists no worktree named ${displayName || branch}.` };
  const sessions = sessionsOf(w);
  const selected = await selectedPane(w.path);
  const lastPrompt = a => sessionTranscript(w.path, a)?.prompts.at(-1)?.at ?? 0;
  const followed = sessions.find(a => a.paneKey === paneKey)
    ?? sessions.find(a => a.paneKey === selected)
    ?? [...sessions].map(a => ({ a, at: a.sessionId ? lastPrompt(a) : 0 })).sort((x, y) => y.at - x.at || y.a.updatedAt - x.a.updatedAt)[0]?.a
    ?? null;
  return {
    found: true,
    path: w.path,
    repo: w.repo || path.basename(w.path),
    branch: stripRef(w.branch),
    sessions: sessions.map(({ updatedAt, transcriptPath, ...a }) => a),
    followed: followed?.paneKey ?? null,
    selectedPane: selected,
    session: sessionTranscript(w.path, followed),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const wt = process.argv[2];
  if (!wt) { console.error("usage: node panel-facts.mjs <worktree path>"); process.exit(1); }
  console.log(JSON.stringify(await panelFacts({ path: wt }), null, 2));
}
