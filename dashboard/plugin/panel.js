// The Worktree panel: the dashboard's row for the worktree that Orca has focused, drawn by the
// dashboard's own code (../row.js) from what the dashboard service computed, then the checkout
// and the worktree's Claude session with the developer's last prompts in it. The plugin's worker
// (worker.ts) answers "worktree.state" and passes "action" on to the service.
//
// The panel reads again when the worker says that the service's state changed ("state"), when Orca
// says that the focused workspace or an agent's status changed, and every SLOW_MS, which is what
// notices the developer moving to another pane of the same worktree.
const FRONT = false;
const SLOW_MS = 5000;

let current = null;      // the focused workspace: { displayName, branch, terminalIds }
let paneKey = null;      // the Claude session picked, when the worktree runs several
let lastJson = "";
let lastState = null;
let lastSelectedPane;    // the pane the worktree had selected at the last read

function showNote(text) {
  const n = document.getElementById("note");
  n.textContent = text || "";
  n.hidden = !text;
}

// The same actions as the dashboard page's buttons, sent through the worker to the service, on
// the session the selector shows: the one picked, or else the one the worker chose to follow.
async function act(body, failure = "Couldn't do that") {
  showNote("");
  try {
    const answer = await orca.plugin.request("action", { ...body, paneKey: paneKey ?? lastState?.followed ?? null }, { timeoutMs: 90000 });
    refresh();
    return answer;
  } catch (e) {
    showNote(failure + ": " + (e.message || e.code || e));
    return null;
  }
}

let reading = false, again = false;
async function refresh() {
  if (reading) { again = true; return; }
  const c = current;
  if (!c) return;
  reading = true;
  let s;
  try {
    s = await orca.plugin.request("worktree.state", { ...c, paneKey }, { timeoutMs: 60000 });
  } catch (e) {
    if (c === current) showNote("Couldn't read this worktree: " + (e.message || e.code || e));
    return;
  } finally {
    reading = false;
    if (again) { again = false; setTimeout(refresh, 0); }
  }
  if (c !== current) return;
  if (document.getElementById("note").textContent.startsWith("Couldn't read this worktree")) showNote("");
  // Moving to another pane in the worktree supersedes a session picked earlier: the panel follows
  // the pane the developer is looking at.
  if (s.found && s.selectedPane !== lastSelectedPane) {
    const moved = lastSelectedPane !== undefined;
    lastSelectedPane = s.selectedPane;
    if (moved && paneKey && paneKey !== s.selectedPane && s.sessions.some(a => a.paneKey === s.selectedPane)) {
      paneKey = null;
      lastJson = "";
      return refresh();
    }
  }
  lastState = s;
  renderService();
  const json = JSON.stringify(s);
  if (json === lastJson) return;
  lastJson = json;
  render(s);
}

// ---- drawing ---------------------------------------------------------------------------------

const cell = (name, ...kids) => el("div", {}, el("p", { class: "cell-name" }, name), ...kids);

// The project's name from its repo's: "bloom" (BloomDesktop) reads "Bloom", "bloom-team-skills"
// "Bloom Team Skills", "bloom-bot-repo" "Bloom Bot", "BloomLibrary" "Bloom Library".
function projectName(repo) {
  const words = String(repo || "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[-_\s]+/).filter(Boolean);
  if (words.length > 1 && /^repo$/i.test(words[words.length - 1])) words.pop();
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// A button for a worktree that has no row: the service still opens its folder and types prompts.
const plainButton = { enabled: true, reason: "" };

// The row, as the dashboard draws its cells (without its Orca button: this is Orca), stacked for
// the sidebar. Only a card's worktree has one.
function rowBox(s) {
  const d = s.row;
  const links = el("span", { class: "links" });
  if (d.pr) links.append(prLinks(d.pr, PR_TONE[d.prState]));
  links.append(folderButton(d));
  const card = el("div", { class: "card-cell" },
    el("span", { class: "title" }, d.title || ""),
    el("span", { class: "meta" }, el("span", { class: "id" }, stateIcon(d.ytState), cardLabel(d))),
    links);
  const box = el("section", { class: "row-box" + (d.busy ? " agent-row" : "") }, el("div", { class: "head" }, card));
  box.append(cell("Process", processCell(d)), cell("Where it stands", standsCell(d)));
  return box;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function checkout(s) {
  const g = s.git;
  const item = (label, value, warn, link) =>
    [el("dt", {}, label), el("dd", {}, el("span", warn ? { class: "warn" } : {}, value), link || null)];
  if (!g) return el("section", { class: "group" }, el("dl", { class: "kv" }, ...item("Branch", el("code", {}, s.branch)), ...item("Checkout", s.gitError || (s.connected ? "not read yet" : "the dashboard service is not answering"), true)));
  // A link that asks the worktree's Claude session to commit, or to commit and push.
  const ask = (prompt, text) => action("orca ask", `Ask this worktree's Claude session to ${text.toLowerCase()}`, text,
    () => act({ action: "prompt", path: s.path, prompt }), prompt + ":" + s.path);
  const changed = g.uncommitted + g.untracked;
  return el("section", { class: "group" },
    el("dl", { class: "kv" },
      ...item("Branch", el("code", {}, s.branch)),
      ...(s.row ? [] : item("Folder", serviceButton(plainButton, { action: "vscode", path: s.path }, "orca wt", s.path, "vscode:" + s.path))),
      ...item("Uncommitted", changed ? plural(changed, "file") : "nothing", changed > 0, changed > 0 ? ask("commit", "Commit") : null),
      ...item("Unpushed", g.unpushed === null ? "branch not pushed" : g.unpushed ? plural(g.unpushed, "commit") : "nothing", g.unpushed !== 0,
        changed > 0 || g.unpushed !== 0 ? ask("commit-push", "Commit and Push") : null),
      ...item("Behind " + g.base, g.behind === null ? "unknown" : g.behind ? plural(g.behind, "commit") : "up to date", g.behind > 0)));
}

// A session's state as one of the page's status chips.
function stateChip(a) {
  if (a.state === "working") return withIcon(el("span", { class: "chip agent" }, "Working"), "half");
  if (a.state === "waiting" || a.state === "blocked") return withIcon(el("span", { class: "chip asking" }, a.question ? "Has a question" : "Waiting"), "question");
  return withIcon(el("span", { class: "chip" }, "Idle"), "empty");
}
const short = (text, max) => text.length > max ? text.slice(0, max - 1) + "…" : text;

function session(s) {
  const a = s.sessions.find(x => x.paneKey === s.followed) || null;
  // The heading, with the session picker to its right when the worktree runs several.
  const heading = el("div", { class: "session-title" }, el("h2", {}, "Claude session"));
  const out = el("section", { class: "group" }, heading);
  if (s.sessions.length > 1) {
    const pick = el("select", { "aria-label": "The Claude session to follow" });
    for (const x of s.sessions) {
      const o = el("option", { value: x.paneKey }, `${x.title || x.prompt || x.agent} (${stateChip(x).textContent.toLowerCase()})`);
      o.selected = x.paneKey === s.followed;
      pick.append(o);
    }
    pick.addEventListener("change", () => { paneKey = pick.value; lastJson = ""; refresh(); });
    heading.append(pick);
  }
  if (a) {
    // With several sessions, the picker already names this one and its state.
    if (s.sessions.length < 2) out.append(el("div", { class: "session-head" }, stateChip(a), el("span", { class: "name", title: a.title }, a.title || s.session?.title || a.agent)));
    if (a.lastMessage) out.append(el("div", { class: "said" }, short(a.lastMessage.replace(/\s+/g, " "), 320)));
  } else {
    out.append(el("p", { class: "quiet" }, "No Claude session is running here" + (s.session?.title ? `; the last one was "${s.session.title}".` : ".")));
  }
  return out;
}

// The developer's last prompts in the session, docked at the bottom of the panel.
function recentPrompts(s) {
  const prompts = s.session?.prompts || [];
  return el("section", { class: "prompts-dock" }, el("h4", {}, "Recent prompts"),
    prompts.length
      ? el("ul", { class: "lines prompts" }, ...prompts.map((p, i) =>
          el("li", i === prompts.length - 1 ? { class: "newest" } : {}, el("span", { class: "title" }, short(p.text, 400)))))
      : el("p", { class: "quiet" }, "No prompts yet."));
}

// The service indicator, from the last answer: the service's own status, or that it did not answer.
let lostAt = 0;
function renderService() {
  const up = !!lastState?.connected;
  if (up) lostAt = 0; else lostAt ||= Date.now();
  drawService(lastState?.service ?? null, up, lostAt);
}

function render(s) {
  const main = document.getElementById("main");
  const title = document.getElementById("project");
  if (!s.found) { title.textContent = ""; main.replaceChildren(el("p", { class: "quiet" }, s.reason)); return; }
  title.textContent = projectName(s.repo);
  const gone = s.connected ? null : el("p", { class: "quiet" }, "The dashboard service is not answering, so this worktree's card and checkout are not shown. The plugin is starting it.");
  const forms = (s.deciders || []).map(d => { const a = link("http://127.0.0.1:47600" + d.path, "Needs your decision: " + (d.topic || d.name)); a.className = "chip you pill-link"; return a; });
  main.replaceChildren(el("div", { class: "panel-main" }, gone, ...forms, s.row ? rowBox(s) : null, checkout(s), session(s)), recentPrompts(s));
}

// ---- wiring ----------------------------------------------------------------------------------

// Links open in the browser; the panel's frame cannot navigate away.
document.addEventListener("click", e => {
  const a = e.target.closest?.("a[href]");
  if (!a || !/^https?:/.test(a.href)) return;
  e.preventDefault();
  orca.shell.openExternal(a.href).catch(err => showNote("Couldn't open the link: " + (err.message || err.code)));
});

orca.on("workspace.changed", ({ context }) => {
  // The terminals tell apart workspaces that share a name and branch (every repo's "main").
  const next = context ? { displayName: context.displayName, branch: context.branch, terminalIds: (context.terminals || []).map(t => t.id) } : null;
  const sameTerminals = !next?.terminalIds.length || !current?.terminalIds.length || next.terminalIds.some(id => current.terminalIds.includes(id));
  const moved = next?.displayName !== current?.displayName || next?.branch !== current?.branch || !sameTerminals;
  current = next;
  if (moved) {
    paneKey = null;
    lastSelectedPane = undefined;
    lastJson = "";
    lastState = null;
    showNote("");
    document.getElementById("project").textContent = "";
    document.getElementById("main").replaceChildren(el("p", { class: "quiet" }, next ? "Reading the worktree…" : "Open a worktree in Orca to see it here."));
  }
  refresh();
});
wireService(renderService);
orca.on("agent.status.changed", () => refresh());
orca.on("state", () => refresh());
setInterval(() => { if (document.visibilityState === "visible") refresh(); }, SLOW_MS);
setInterval(() => {
  for (const e of document.querySelectorAll(".elapsed[data-since]")) e.textContent = elapsedText(Number(e.dataset.since));
  for (const e of document.querySelectorAll("small[data-ago]")) e.textContent = ` ${e.dataset.source}, read ${agoText(Number(e.dataset.ago))}`;
  if (!document.getElementById("service-pop").hidden) renderService();
}, 15000);
