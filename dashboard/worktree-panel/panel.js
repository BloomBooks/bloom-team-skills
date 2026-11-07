// The Worktree panel: the dashboard's row for the worktree that Orca has focused, drawn by the
// dashboard's own code (../row.js), then the checkout and the worktree's Claude session with the
// developer's last prompts in it. The worker (worker.ts, worktree-facts.mjs) answers
// "worktree.state" with the row and the worktree's live agents, as the dashboard server gives
// them to its page.
const POLL_MS = 5000;

let current = null;      // the focused workspace: { displayName, branch }
let paneKey = null;      // the Claude session picked, when the worktree runs several
let lastJson = "";
let lastState = null;

function showNote(text) {
  const n = document.getElementById("note");
  n.textContent = text || "";
  n.hidden = !text;
}

// The page's buttons post to its server; here the same paths go to the worker.
const ACTIONS = { "/api/run-skill": "worktree.runSkill", "/api/open": "worktree.open", "/api/vscode": "worktree.vscode", "/api/prompt": "worktree.prompt" };
async function post(path, body, failure = "Orca couldn't do that") {
  showNote("");
  try {
    if (!ACTIONS[path]) throw new Error("the panel has no " + path);
    // The session the selector shows: the one picked, or else the one the worker chose to follow.
    await orca.plugin.request(ACTIONS[path], { ...body, paneKey: paneKey ?? lastState?.followed ?? null }, { timeoutMs: 60000 });
    return true;
  } catch (e) {
    showNote(failure + ": " + (e.message || e.code || e));
    return false;
  }
}

async function refresh() {
  const c = current;
  if (!c) return;
  let s;
  try {
    s = await orca.plugin.request("worktree.state", { ...c, paneKey }, { timeoutMs: 90000 });
  } catch (e) {
    if (c === current) showNote("Couldn't read this worktree: " + (e.message || e.code || e));
    return;
  }
  if (c !== current) return;
  // A read that failed (the worker restarting, say) stops being news once one succeeds.
  if (document.getElementById("note").textContent.startsWith("Couldn't read this worktree")) showNote("");
  lastState = s;
  const json = JSON.stringify(s);
  if (json === lastJson && !launched.size) return;
  lastJson = json;
  render(s);
}

// ---- drawing ---------------------------------------------------------------------------------

const cell = (name, ...kids) => el("div", {}, el("p", { class: "cell-name" }, name), ...kids);

// What the page's "Where it stands" cell holds: a preflight run's phases while one runs, or the
// row's status, comments, question and next step.
function standsCell(s, d) {
  if (activeRun(d)) return preflightSteps(d.progress);
  if (!s.hasRow && !d.question) return el("p", { class: "quiet" }, "The dashboard has no row for this card; /dashboard writes one.");
  return el("div", { class: "stands" }, d.status || "",
    d.comments ? commentsLine(d.comments) : null,
    d.question ? el("span", { class: "question" }, el("b", {}, "Claude asks: "), d.question) : null,
    d.next ? el("span", { class: "next" }, el("b", {}, "Next: "), d.next) : null);
}

// The worktree's folder, which opens in VS Code, as the dashboard's row shows it.
const folderButton = p => action("orca wt", "Open this folder in VS Code", p, () => post("/api/vscode", { path: p }), "vscode:" + p);

// The project's name from its repo's: "bloom" (BloomDesktop) reads "Bloom", "bloom-team-skills"
// "Bloom Team Skills", "bloom-bot-repo" "Bloom Bot", "BloomLibrary" "Bloom Library".
function projectName(repo) {
  const words = String(repo || "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[-_\s]+/).filter(Boolean);
  if (words.length > 1 && /^repo$/i.test(words[words.length - 1])) words.pop();
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// The row, as the dashboard draws its cells (without its Orca button: this is Orca), stacked for
// the sidebar. Only a card's worktree has one.
function rowBox(s) {
  const [d] = withLiveAgents([s.d], { [normPath(s.d.worktree)]: s.live });
  const links = el("span", { class: "links" });
  if (d.pr) links.append(prLinks(d.pr, PR_TONE[d.prState]));
  links.append(folderButton(d.worktree));
  const card = el("div", { class: "card-cell" },
    el("span", { class: "title" }, d.title || ""),
    d.card ? el("span", { class: "meta" }, el("span", { class: "id" }, stateIcon(d.ytState), cardLabel(d))) : null,
    links);
  const box = el("section", { class: "row-box" + (d.who === "agent" ? " agent-row" : "") },
    el("div", { class: "head" }, card, el("div", { class: "upd" }, s.hasRow ? localTime(d.updated) : "")));
  box.append(cell("Process", processCell(d)), cell("Where it stands", standsCell(s, d)));
  return box;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function checkout(s) {
  const g = s.git;
  const item = (label, value, warn, link) =>
    [el("dt", {}, label), el("dd", {}, el("span", warn ? { class: "warn" } : {}, value), link || null)];
  // A link that asks the worktree's Claude session to commit, or to commit and push.
  const ask = (prompt, text) => action("orca ask", `Ask this worktree's Claude session to ${text.toLowerCase()}`, text,
    () => post("/api/prompt", { path: s.d.worktree, prompt }), prompt + ":" + s.d.worktree);
  return el("section", { class: "group" },
    el("dl", { class: "kv" },
      ...item("Branch", el("code", {}, s.branch)),
      ...(s.d.card ? [] : item("Folder", folderButton(s.d.worktree))),
      ...item("Uncommitted", g.changed ? plural(g.changed, "file") : "nothing", g.changed > 0, g.changed > 0 ? ask("commit", "Commit") : null),
      ...item("Unpushed", g.unpushed === null ? "branch not pushed" : g.unpushed ? plural(g.unpushed, "commit") : "nothing", g.unpushed !== 0,
        g.changed > 0 || g.unpushed !== 0 ? ask("commit-push", "Commit and Push") : null),
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

function render(s) {
  const main = document.getElementById("main");
  const title = document.getElementById("project");
  if (!s.found) { title.textContent = ""; main.replaceChildren(el("p", { class: "quiet" }, s.reason)); return; }
  title.textContent = projectName(s.repo);
  main.replaceChildren(el("div", { class: "panel-main" }, s.d.card ? rowBox(s) : null, checkout(s), session(s)), recentPrompts(s));
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
    lastJson = "";
    lastState = null;
    showNote("");
    document.getElementById("project").textContent = "";
    document.getElementById("main").replaceChildren(el("p", { class: "quiet" }, next ? "Reading the worktree…" : "Open a worktree in Orca to see it here."));
  }
  refresh();
});
orca.on("agent.status.changed", () => refresh());
setInterval(refresh, POLL_MS);
setInterval(() => { for (const e of document.querySelectorAll(".elapsed[data-since]")) e.textContent = elapsedText(Number(e.dataset.since)); }, 15000);
