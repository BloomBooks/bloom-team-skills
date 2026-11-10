// Card Sorter page: a board of columns (each a board + state a card can end up in). Cards start in
// the column they are in now; moving a card to another column records the decision. Decisions are
// saved to the server (decisions.json) on every change.

const $ = (sel) => document.querySelector(sel);
const boardEl = $("#board");
const detailEl = $("#detail");

let data = null;            // { config, cards, decisions, extractedAt }
let decisions = {};         // id -> { column?, note?, tags?: { add: [name], remove: [name] }, at }
let allTags = null;         // every tag the Bot can see, [{ id, name, background, foreground }], from /api/tags
let tagError = null;        // why the tag list could not be read
let columns = [];           // config.columns
let byId = new Map();
let colCards = [];          // per column: cards in display order
let cursorCol = 0;
let cursorId = null;
let anchorId = null;        // where a shift-range starts
const selection = new Set();
const undoStack = [];
let descExpanded = false;

const prefs = loadPrefs();

// ---------- scoring ----------

/** Benefit before cost: reach x severity, plus boosts for a roadmap feature and a partner request. */
function benefitOf(a) {
    if (!a) return null;
    return a.reach * a.severity + (a.roadmap ? 6 : 0) + (a.partner ? 2 : 0);
}
const BENEFIT_MAX = 25 + 6 + 2;

/** Score 0-100: benefit scaled down by risk to the beta and by size. */
function scoreOf(a) {
    if (!a) return null;
    const benefit = benefitOf(a) / BENEFIT_MAX;
    const riskFactor = 1 - 0.12 * (a.risk - 1);
    const sizeFactor = 1 / (1 + (a.sizeLines ?? 0) / 800);
    return Math.round(100 * benefit * riskFactor * sizeFactor);
}

// ---------- where cards are ----------

/** The column a card is in on the tracker now. */
function originalColumn(c) {
    const fits = (col) => (col.anyBoard || col.board === c.board) && (col.state == null || col.state === c.state);
    let i = columns.findIndex((col) => col.asFound && fits(col));
    if (i < 0) i = columns.findIndex(fits);
    return i < 0 ? 0 : i;
}
/** The column a card is in on this board: its decision, else where it started. */
function columnOf(c) {
    const key = decisions[c.id]?.column;
    if (key == null) return c.originalCol;
    const i = columns.findIndex((col) => col.key === key);
    return i < 0 ? c.originalCol : i;
}
/** The column the analysis proposes, or -1 when the proposal has no column (e.g. "future"). */
function proposedColumn(c) {
    const p = c.analysis?.proposal;
    if (!p) return -1;
    const direct = columns.findIndex((col) => col.key === p);
    if (direct >= 0 && columns[direct].board == null) return direct;
    const board = data.config.proposalBoards?.[p];
    if (!board) return -1;
    const onBoard = columns.map((col, i) => ({ col, i })).filter((x) => x.col.board === board && !x.col.asFound);
    const sameState = onBoard.find((x) => x.col.state === c.state) ?? onBoard.find((x) => x.col.state == null) ?? onBoard[0];
    return sameState ? sameState.i : -1;
}
const proposalShort = { "6.6": "6.6", "6.7": "6.7", "live-with": "Live with", future: "Future", close: "Close" };
function proposalLabel(c) {
    const i = proposedColumn(c);
    if (i >= 0) return columns[i].label;
    return c.analysis?.proposal ?? null;
}

// ---------- grouping and sorting ----------

const groupings = {
    none: { label: "None", key: () => "" },
    area: { label: "Area", key: (c) => c.analysis?.area ?? "Not analyzed" },
    proposal: { label: "Proposal", key: (c) => proposalLabel(c) ?? "No proposal" },
    kind: { label: "Kind", key: (c) => c.analysis?.kind ?? c.type ?? "?" },
    reportedBy: { label: "Reported by", key: (c) => c.analysis?.reportedBy ?? "?" },
    roadmap: { label: "Roadmap feature", key: (c) => c.analysis?.roadmap ?? "Not on the roadmap" },
    assignee: { label: "Assignee", key: (c) => c.assignee ?? "Unassigned" },
    board: { label: "Board", key: (c) => c.board ?? "No board" },
    origin: { label: "Where it started", key: (c) => columns[c.originalCol].label },
};
const sorts = {
    score: { label: "Score", cmp: (a, b) => (scoreOf(b.analysis) ?? -1) - (scoreOf(a.analysis) ?? -1) },
    benefit: { label: "Benefit", cmp: (a, b) => (benefitOf(b.analysis) ?? -1) - (benefitOf(a.analysis) ?? -1) },
    risk: { label: "Risk (low first)", cmp: (a, b) => (a.analysis?.risk ?? 9) - (b.analysis?.risk ?? 9) },
    size: { label: "Size (small first)", cmp: (a, b) => (a.analysis?.sizeLines ?? 1e9) - (b.analysis?.sizeLines ?? 1e9) },
    newest: { label: "Newest", cmp: (a, b) => b.created - a.created },
    oldest: { label: "Oldest", cmp: (a, b) => a.created - b.created },
};

function matchesSearch(c, q) {
    if (!q) return true;
    const a = c.analysis ?? {};
    return [c.id, c.title, c.description, a.plain, a.area, a.evidence, a.status, a.roadmap, c.assignee, ...c.tags.map((t) => t.name)]
        .some((s) => s && String(s).toLowerCase().includes(q));
}

/** Fills colCards: per column, the matching cards grouped (groups ordered by their best card) and sorted. */
function computeColumns() {
    const q = $("#search").value.trim().toLowerCase();
    colCards = columns.map((_, i) => orderColumn(i, q));
}

/** The cards in column `i` that match `q`, in the order shown: grouped (best group first), then sorted. */
function orderColumn(i, q) {
    const g = groupings[prefs.group];
    const cmp = sorts[prefs.sort].cmp;
    const cards = data.cards.filter((c) => columnOf(c) === i && matchesSearch(c, q)).sort(cmp);
    const groups = new Map();
    for (const c of cards) {
        const k = g.key(c);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
    }
    return [...groups.values()].sort((x, y) => cmp(x[0], y[0])).flat();
}

// ---------- rendering ----------

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function fmtLines(n) {
    if (n == null) return "";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k lines` : `${n} lines`;
}

function cardHtml(c, i) {
    const a = c.analysis;
    const pc = proposedColumn(c);
    // In an as-found column every card is still to be sorted, so its proposal is shown quietly;
    // elsewhere a card that is not where the analysis proposed is flagged.
    const unsorted = columns[i].asFound || columns[i].later;
    const differs = a && pc !== i && !unsorted;
    const classes = ["card", selection.has(c.id) && "sel", c.id === cursorId && "cursor", i !== c.originalCol && "moved"].filter(Boolean).join(" ");
    const propText = !a ? "" : pc === i ? "✓ proposed" : `→ ${esc(proposalShort[a.proposal] ?? a.proposal)}`;
    return `<div class="${classes}" data-id="${c.id}" draggable="true">
        <div class="top"><span class="score">${scoreOf(a) ?? "–"}</span><span class="id">${c.id}</span><span class="prop${differs ? " differs" : ""}">${propText}</span></div>
        <div class="plain">${esc(a?.plain ?? c.title)}</div>
        <div class="meta">${i !== c.originalCol ? `<span class="from">from ${esc(columns[c.originalCol].label)}</span>` : ""}<span>${esc([a?.area, a ? `B${benefitOf(a)} R${a.risk}` : null, a ? fmtLines(a.sizeLines) : null].filter(Boolean).join(" · "))}</span></div>
    </div>`;
}

function renderBoard() {
    computeColumns();
    const g = groupings[prefs.group];
    const scrolls = [...boardEl.querySelectorAll(".col-body")].map((b) => b.scrollTop);
    boardEl.innerHTML = columns.map((col, i) => {
        const cards = colCards[i];
        let body = "";
        let lastGroup = null;
        for (const c of cards) {
            const k = g.key(c);
            if (prefs.group !== "none" && k !== lastGroup) {
                const n = cards.filter((x) => g.key(x) === k).length;
                body += `<div class="sub-head"><span>${esc(k)}</span><span>${n}</span></div>`;
                lastGroup = k;
            }
            body += cardHtml(c, i);
        }
        const selHere = cards.filter((c) => selection.has(c.id)).length;
        const w = prefs.colWidths?.[col.key];
        const tint = prefs.colColors?.[col.key];
        const style = [w && `width:${w}px`, tint && `--tint:${tint}`].filter(Boolean).join(";");
        return `<div class="column${i === cursorCol ? " here" : ""}${tint ? " tinted" : ""}" data-col="${i}"${style ? ` style="${style}"` : ""}>
            <div class="resizer" data-resize="${esc(col.key)}" title="Drag to resize; double-click to reset"></div>
            <div class="col-head" draggable="true" data-colkey="${esc(col.key)}" title="${esc(col.label)}: drag to reorder, right-click for a color"><span><kbd>${i + 1}</kbd>${esc(col.label)}</span><span class="n">${selHere ? `${selHere} selected · ` : ""}${cards.length}</span></div>
            <div class="col-body">${body || `<div class="empty">Empty</div>`}</div>
        </div>`;
    }).join("");
    boardEl.querySelectorAll(".col-body").forEach((b, i) => (b.scrollTop = scrolls[i] ?? 0));
}

function meter(n, cls) {
    return `<span class="meter ${cls}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
}

/**
 * HTML for an attachment a description refers to by file name. The image loads straight from
 * YouTrack through the signed URL the extract recorded, which needs no login.
 */
function mediaHtml(cardId, name, alt) {
    if (/^https?:/.test(name)) return `<img class="att" src="${esc(name)}" alt="${esc(alt)}">`;
    const att = byId.get(cardId)?.attachments.find((a) => a.name === name);
    if (!att) return `<span class="img">[attachment not found: ${esc(name)}]</span>`;
    if (/^video\//.test(att.mimeType ?? "") || /\.(mp4|webm|mov)$/i.test(name)) return `<video class="att" src="${esc(att.url)}" controls preload="metadata"></video>`;
    return `<a href="${esc(att.url)}" target="_blank"><img class="att" src="${esc(att.url)}" alt="${esc(alt || name)}" title="${esc(alt || name)}" loading="lazy"
        onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'img',textContent:'[image did not load: ${esc(name).replace(/'/g, "")}]'}))"></a>`;
}

/** Light Markdown for YouTrack descriptions and comments: code, headings, bold, links, and attached images. */
function md(text, cardId) {
    let src = String(text ?? "");
    // Cards made from email arrive as HTML; reduce them to their text with line breaks, keeping images as Markdown images.
    if (/^\s*<div|<\/div>/.test(src)) {
        const withImages = src.replace(/<img[^>]*\bsrc="([^"]+)"[^>]*>/gi, (_m, s) => `\n![](${s})\n`);
        const doc = new DOMParser().parseFromString(withImages.replace(/<br\s*\/?>|<\/(div|p|li)>/gi, "\n"), "text/html");
        src = doc.body.textContent.replace(/\n{3,}/g, "\n\n").trim();
    }
    return src.split(/```/).map((b, i) => {
        if (i % 2) return `<pre>${esc(b.replace(/^\w*\n/, ""))}</pre>`;
        let h = esc(b);
        const media = [];
        // Images are swapped for markers first, so the link and URL rules below don't rewrite their HTML.
        h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)(\{[^}]*\})?/g, (_m, alt, s) => {
            media.push(mediaHtml(cardId, s.replace(/&amp;/g, "&"), alt));
            return `\u0000${media.length - 1}\u0000`;
        });
        h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `<a href="$2" target="_blank">$1</a>`);
        h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, `$1<a href="$2" target="_blank">$2</a>`);
        h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
        h = h.replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>");
        h = h.replace(/\\([\[\]>*_#-])/g, "$1");
        h = h.replace(/\n/g, "<br>");
        return h.replace(/\u0000(\d+)\u0000/g, (_m, n) => media[Number(n)]);
    }).join("");
}

function renderDetail() {
    const c = byId.get(cursorId);
    if (!c) {
        detailEl.innerHTML = `<div class="empty">No card here.</div>`;
        return;
    }
    const a = c.analysis;
    const dec = decisions[c.id] ?? {};
    const here = columnOf(c);
    const age = Math.round((Date.now() - c.created) / 86400000);
    const work = c.work ?? [];
    detailEl.innerHTML = `<div class="d-wrap">
        ${selection.size > 1 ? `<div class="multi"><b>${selection.size} cards selected.</b> Press 1–${columns.length} to move them all, Enter to move each to its proposal, Esc to clear.</div>` : ""}
        <div class="d-head">
            <a href="${data.config.trackerUrl}${c.id}" target="_blank">${c.id} ↗</a>
            <span class="state">${esc(c.board ?? "No board")} / ${esc(c.state)} · ${esc(c.type)} · ${age} days old${c.assignee ? ` · ${esc(c.assignee)}` : ""}</span>
        </div>
        <div class="d-title">${esc(c.title)}</div>
        <p class="d-plain">${esc(a?.plain ?? "Not analyzed yet.")}</p>
        <div class="d-where">Now in <b>${esc(columns[here].label)}</b>${here !== c.originalCol ? ` (started in ${esc(columns[c.originalCol].label)})` : ""}</div>
        ${a ? `<div class="proposal-why">Proposed: <b>${esc(proposalLabel(c))}</b>. ${esc(a.proposalWhy)}</div>` : ""}
        <textarea class="note" placeholder="Note (n)">${esc(dec.note ?? "")}</textarea>
        ${tagsHtml(c)}

        ${a?.status ? `<div class="status">${esc(a.status)}</div>` : ""}
        ${a ? `<dl class="facts">
            <dt>Score</dt><dd><b>${scoreOf(a)}</b> <span class="why">benefit ${benefitOf(a)}/${BENEFIT_MAX}, risk ${a.risk}/5, ${fmtLines(a.sizeLines)}</span></dd>
            <dt>Benefit</dt><dd>${meter(a.reach, "b")}reach ${a.reach} &nbsp; ${meter(a.severity, "b")}severity ${a.severity}<br><span class="why">${esc(a.benefitWhy)}</span></dd>
            <dt>Risk</dt><dd>${meter(a.risk, "r")}<span class="why">${esc(a.riskWhy)}</span></dd>
            <dt>Size</dt><dd>${fmtLines(a.sizeLines)} in ${a.sizeFiles} file${a.sizeFiles === 1 ? "" : "s"}<br><span class="why">${esc(a.sizeWhy)}</span></dd>
            <dt>Evidence</dt><dd>${esc(a.reportedBy)}: ${esc(a.evidence)}</dd>
            ${a.partner ? `<dt>Partner</dt><dd>${esc(a.partner)}</dd>` : ""}
            ${a.roadmap ? `<dt>Roadmap</dt><dd>${esc(a.roadmap)}</dd>` : ""}
            <dt>Area</dt><dd>${esc(a.area)} · ${esc(a.kind)}</dd>
        </dl>` : ""}

        ${work.length ? `<h3>Existing work</h3><div class="work"><ul>${work.map((w) => w.kind === "pr"
            ? `<li><a href="${w.url}" target="_blank">${esc(w.repo)} #${w.number}</a> ${esc(w.state)}: ${esc(w.title)}</li>`
            : `<li>branch <code>${esc(w.name)}</code> (${esc(w.repo)})</li>`).join("")}</ul></div>` : ""}
        ${c.links.length ? `<h3>Links</h3><div class="links"><ul>${c.links.map((l) => `<li>${esc(l.relation)} <a href="${data.config.trackerUrl}${l.id}" target="_blank">${l.id}</a>${l.resolved ? " (resolved)" : ""}: ${esc(l.title)}</li>`).join("")}</ul></div>` : ""}

        <h3>Description</h3>
        <div class="desc${descExpanded ? "" : " clamped"}">${md(c.description, c.id) || "<i>empty</i>"}</div>
        <button class="more" data-act="expand">${descExpanded ? "Show less" : "Show all"} (d)</button>
        ${c.comments.length ? `<h3>Comments (${c.comments.length})</h3>${descExpanded ? c.comments.map((m) => `<div class="comment"><div class="who">${esc(m.author)} · ${new Date(m.created).toLocaleDateString()}</div>${md(m.text, c.id)}</div>`).join("") : `<div class="why" style="font-size:13px">Press d to show them.</div>`}` : ""}
    </div>`;
}

// ---------- tags ----------

/** The card's tags as they will be after pushing, each marked "add" or "remove" while that change waits for the push. */
function tagRows(c) {
    const t = decisions[c.id]?.tags ?? { add: [], remove: [] };
    const rows = c.tags.map((tag) => ({ tag, pending: t.remove.includes(tag.name) ? "remove" : null }));
    for (const name of t.add) rows.push({ tag: allTags?.find((x) => x.name === name) ?? { name }, pending: "add" });
    return rows;
}

function tagsHtml(c) {
    const rows = tagRows(c);
    const shown = new Set(rows.map((r) => r.tag.name));
    const chip = ({ tag, pending }) => {
        const colors = tag.background ? ` style="background:${esc(tag.background)};color:${esc(tag.foreground ?? "inherit")}"` : "";
        const title = pending === "add" ? "Will be added when you push. Click × to drop it."
            : pending === "remove" ? "Will be removed when you push. Click ↺ to keep it."
            : "Click × to remove it when you push.";
        return `<span class="chip tag${pending ? ` ${pending}` : ""}"${colors} title="${title}">${esc(tag.name)}<button class="tag-x" data-tag="${esc(tag.name)}" aria-label="${pending === "remove" ? "Keep" : "Remove"} ${esc(tag.name)}">${pending === "remove" ? "↺" : "×"}</button></span>`;
    };
    return `<div class="tags">
        ${rows.map(chip).join("")}
        <span class="tag-add"><input class="tag-input" list="tag-names" placeholder="Add a tag (t)" autocomplete="off"><button class="tag-btn" data-act="add-tag">Add</button></span>
        <datalist id="tag-names">${(allTags ?? []).filter((t) => !shown.has(t.name)).map((t) => `<option value="${esc(t.name)}"></option>`).join("")}</datalist>
        <div class="tag-msg">${esc(tagError ? `Could not read YouTrack's tags: ${tagError}` : "")}</div>
    </div>`;
}

/** Reads the tag list once; the details redraw when it arrives. */
async function loadTags() {
    if (allTags) return allTags;
    try {
        const r = await fetch("/api/tags");
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        allTags = j;
        tagError = null;
    } catch (e) {
        tagError = e.message;
    }
    return allTags;
}

/** Changes the card's waiting tag changes with `fn(t)`, then saves and redraws. */
function changeTags(c, fn) {
    const d = (decisions[c.id] ??= {});
    const t = d.tags ?? { add: [], remove: [] };
    fn(t);
    if (t.add.length || t.remove.length) d.tags = t;
    else delete d.tags;
    d.at = new Date().toISOString();
    if (isEmptyDecision(d)) delete decisions[c.id];
    save();
    renderBoard();
    renderDetail();
}

/** The × or ↺ on a chip: drops a waiting add, undoes a waiting remove, or removes a tag the card has. */
function toggleTag(c, name) {
    changeTags(c, (t) => {
        if (t.add.includes(name)) t.add = t.add.filter((n) => n !== name);
        else if (t.remove.includes(name)) t.remove = t.remove.filter((n) => n !== name);
        else t.remove.push(name);
    });
}

/** Adds the tag typed in the box, or says why it can't. */
function addTypedTag(c) {
    const input = detailEl.querySelector(".tag-input");
    const typed = input.value.trim();
    if (!typed) return;
    const say = (msg) => (detailEl.querySelector(".tag-msg").textContent = msg);
    if (!allTags) return say(tagError ? `Could not read YouTrack's tags: ${tagError}` : "Still reading YouTrack's tags; try again in a moment.");
    const tag = allTags.find((t) => t.name.toLowerCase() === typed.toLowerCase());
    if (!tag) return say(`YouTrack has no tag named "${typed}".`);
    const pending = decisions[c.id]?.tags;
    const onCard = c.tags.some((t) => t.name === tag.name);
    if ((onCard && !pending?.remove.includes(tag.name)) || pending?.add.includes(tag.name)) return say(`${c.id} already has "${tag.name}".`);
    changeTags(c, (t) => {
        if (onCard) t.remove = t.remove.filter((n) => n !== tag.name);
        else t.add.push(tag.name);
    });
    detailEl.querySelector(".tag-input")?.focus();
}

function renderProgress() {
    const isSorted = (c) => !columns[columnOf(c)].asFound && !columns[columnOf(c)].later;
    const sorted = data.cards.filter(isSorted).length;
    const later = data.cards.filter((c) => columns[columnOf(c)].later).length;
    const differs = data.cards.filter((c) => c.analysis && isSorted(c) && proposedColumn(c) !== columnOf(c)).length;
    $("#progress").textContent = `${sorted} of ${data.cards.length} sorted · ${later} to come back to · ${differs} sorted somewhere other than proposed`;
}

function render() {
    renderProgress();
    computeColumns();
    fixCursor();
    renderBoard();
    renderDetail();
    scrollCursorIntoView();
}

/** Keeps the cursor on a visible card; when its card left the column, it falls back to the column's first card. */
function fixCursor() {
    const c = byId.get(cursorId);
    if (c && colCards[columnOf(c)]?.includes(c)) {
        cursorCol = columnOf(c);
        return;
    }
    cursorId = colCards[cursorCol]?.[0]?.id ?? null;
}

function scrollCursorIntoView() {
    boardEl.querySelector(".card.cursor")?.scrollIntoView({ block: "nearest" });
}

/** Moves the cursor without rebuilding everything; only the board's classes and the detail change. */
function setCursor(id, { extend = false, keepSelection = false } = {}) {
    const c = byId.get(id);
    if (!c) return;
    cursorId = id;
    cursorCol = columnOf(c);
    descExpanded = false;
    if (extend) {
        const list = colCards[cursorCol];
        const from = list.findIndex((x) => x.id === (anchorId ?? id));
        const to = list.findIndex((x) => x.id === id);
        if (from >= 0) {
            selection.clear();
            const [lo, hi] = from < to ? [from, to] : [to, from];
            for (let k = lo; k <= hi; k++) selection.add(list[k].id);
        }
    } else {
        anchorId = id;
        if (!keepSelection) selection.clear();
    }
    renderBoard();
    renderDetail();
    scrollCursorIntoView();
}

// ---------- actions ----------

let saveTimer = null;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fetch("/api/decisions", { method: "POST", body: JSON.stringify(decisions) }), 150);
}

/** Puts a card in a column, recording or clearing its decision; returns what it was before, for undo. */
function place(c, colIndex) {
    const before = decisions[c.id] ? { ...decisions[c.id] } : null;
    const d = (decisions[c.id] ??= {});
    if (colIndex === c.originalCol) delete d.column;
    else d.column = columns[colIndex].key;
    d.at = new Date().toISOString();
    if (isEmptyDecision(d)) delete decisions[c.id];
    return { id: c.id, before };
}

/** True when a decision records nothing, so it can be dropped. */
function isEmptyDecision(d) {
    return d.column == null && !d.note && !d.tags;
}

/** The cards an action applies to: the selection, or the card under the cursor. */
function targets() {
    if (selection.size) return [...selection].map((id) => byId.get(id));
    const c = byId.get(cursorId);
    return c ? [c] : [];
}

/**
 * Moves cards (each to `colFor(card)`), keeps the cursor in the column it was in, on the card
 * after the moved ones, and records one undo step.
 */
function moveCards(cards, colFor) {
    if (!cards.length) return;
    const list = colCards[cursorCol];
    const moving = new Set(cards.map((c) => c.id));
    const cursorIdx = list.findIndex((c) => c.id === cursorId);
    const after = list.slice(cursorIdx + 1).find((c) => !moving.has(c.id)) ?? list.slice(0, cursorIdx).reverse().find((c) => !moving.has(c.id));
    const changes = cards.map((c) => (colFor(c) >= 0 ? place(c, colFor(c)) : null)).filter(Boolean);
    if (!changes.length) return;
    undoStack.push(changes);
    save();
    selection.clear();
    cursorId = moving.has(cursorId) ? after?.id ?? null : cursorId;
    anchorId = cursorId;
    descExpanded = false;
    render();
}

// While Ctrl is held, Ctrl+arrow moves keep hold of the same cards, so pressing the arrow again
// moves them another column. Letting go of Ctrl puts the cursor back in the column the cards came
// from, on the card after them.
let ctrlMove = null;        // { fromCol, nextId, ids } while Ctrl is held after a Ctrl+arrow move

/** Moves the selection (or the card under the cursor) one column left or right of where each card is. */
function shiftCards(delta) {
    if (!ctrlMove) {
        const cards = targets();
        if (!cards.length) return;
        const ids = cards.map((c) => c.id);
        const list = colCards[cursorCol];
        const i = list.findIndex((c) => c.id === cursorId);
        const moving = new Set(ids);
        const next = list.slice(i + 1).find((c) => !moving.has(c.id)) ?? list.slice(0, Math.max(0, i)).reverse().find((c) => !moving.has(c.id));
        ctrlMove = { fromCol: cursorCol, nextId: next?.id ?? null, ids };
    }
    const cards = ctrlMove.ids.map((id) => byId.get(id));
    const changes = cards.map((c) => {
        const to = columnOf(c) + delta;
        return to >= 0 && to < columns.length ? place(c, to) : null;
    }).filter(Boolean);
    if (!changes.length) return;
    undoStack.push(changes);
    save();
    selection.clear();
    for (const id of ctrlMove.ids) selection.add(id);
    cursorId = ctrlMove.ids.includes(cursorId) ? cursorId : ctrlMove.ids[0];
    cursorCol = columnOf(byId.get(cursorId));
    render();
}

/** Ends a run of Ctrl+arrow moves: the moved cards are let go and the cursor returns to where they came from. */
function endCtrlMove() {
    if (!ctrlMove) return;
    const { fromCol, nextId } = ctrlMove;
    ctrlMove = null;
    selection.clear();
    cursorCol = fromCol;
    cursorId = nextId && columnOf(byId.get(nextId)) === fromCol ? nextId : colCards[fromCol]?.[0]?.id ?? null;
    anchorId = cursorId;
    render();
}
document.addEventListener("keyup", (e) => {
    if (e.key === "Control" || e.key === "Meta") endCtrlMove();
});
window.addEventListener("blur", endCtrlMove);

function undo() {
    const changes = undoStack.pop();
    if (!changes) return;
    for (const { id, before } of changes) {
        if (before) decisions[id] = before;
        else delete decisions[id];
    }
    save();
    selection.clear();
    for (const { id } of changes) selection.add(id);
    cursorId = changes[0].id;
    render();
}

function moveCursor(delta, extend) {
    const list = colCards[cursorCol];
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === cursorId);
    const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta))];
    setCursor(next.id, { extend });
}

/** Moves the cursor to a neighbouring column, landing at about the same height. */
function moveColumn(delta) {
    const target = cursorCol + delta;
    if (target < 0 || target >= columns.length) return;
    const i = Math.max(0, colCards[cursorCol].findIndex((c) => c.id === cursorId));
    cursorCol = target;
    const list = colCards[target];
    if (!list.length) {
        cursorId = null;
        selection.clear();
        renderBoard();
        renderDetail();
        return;
    }
    setCursor(list[Math.min(i, list.length - 1)].id);
}

/** Jumps to the first card of the next (or previous) group within the column. */
function moveGroup(delta) {
    const key = groupings[prefs.group].key;
    const list = colCards[cursorCol];
    const i = list.findIndex((c) => c.id === cursorId);
    if (i < 0) return;
    let j = i;
    if (delta > 0) {
        while (j < list.length && key(list[j]) === key(list[i])) j++;
    } else {
        while (j > 0 && key(list[j - 1]) === key(list[i])) j--;
        if (j === i && j > 0) {
            j--;
            while (j > 0 && key(list[j - 1]) === key(list[i - 1])) j--;
        }
    }
    if (list[j]) setCursor(list[j].id);
}

// ---------- keyboard ----------

const keyHelp = [
    ["j / k  or  ↓ / ↑", "next / previous card in the column"],
    ["h / l  or  ← / →", "previous / next column"],
    ["Shift + j / k / ↓ / ↑", "extend the selection"],
    ["Space", "add or remove the card from the selection"],
    ["Ctrl + A", "select the whole column"],
    ["1 – 9", "move the selection (or the card) to that column"],
    ["Ctrl + ← / →", "move the selection (or the card) one column left / right"],
    ["Enter", "move each selected card to its proposed column"],
    ["u", "undo the last move"],
    ["] / [", "next / previous group"],
    ["n", "write a note (Esc to leave it)"],
    ["t", "add a tag (Enter adds it; the tags change in YouTrack when you push)"],
    ["d", "show the whole description and the comments"],
    ["o", "open the card in YouTrack"],
    ["g / G", "next / previous grouping"],
    ["s / S", "next / previous sort"],
    ["/", "search (Esc clears)"],
    ["Esc", "clear the selection"],
    ["?", "this help"],
    ["Mouse", "click, Ctrl+click, Shift+click to select; drag cards to a column"],
    ["Splitters", "drag a column's right edge, or the bar before the details, to resize; double-click to reset"],
    ["Column header", "drag to reorder the columns; right-click a column to pick its color"],
];

function cycle(obj, current, delta) {
    const keys = Object.keys(obj);
    return keys[(keys.indexOf(current) + delta + keys.length) % keys.length];
}

document.addEventListener("keydown", (e) => {
    if (!syncEl.hidden) {
        if (e.key === "Escape" && !syncBusy) syncEl.hidden = true;
        return;
    }
    const inField = e.target.matches("input, textarea, select");
    if (e.key === "Escape") {
        if (!$("#help").hidden) return void ($("#help").hidden = true);
        if (e.target.id === "search" && e.target.value) {
            e.target.value = "";
            render();
        } else if (!inField && selection.size) {
            selection.clear();
            renderBoard();
            renderDetail();
        }
        if (inField) e.target.blur();
        boardEl.focus();
        return;
    }
    if (inField) {
        if (e.target.id === "search" && (e.key === "Enter" || e.key === "ArrowDown")) {
            e.preventDefault();
            e.target.blur();
            boardEl.focus();
        }
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selection.clear();
        for (const c of colCards[cursorCol]) selection.add(c.id);
        renderBoard();
        renderDetail();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        return shiftCards(e.key === "ArrowLeft" ? -1 : 1);
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= columns.length) {
        e.preventDefault();
        return moveCards(targets(), () => digit - 1);
    }
    const handled = (() => {
        switch (e.key) {
            case "j": case "J": case "ArrowDown": return moveCursor(1, e.shiftKey), true;
            case "k": case "K": case "ArrowUp": return moveCursor(-1, e.shiftKey), true;
            case "]": return moveGroup(1), true;
            case "[": return moveGroup(-1), true;
            case "h": case "ArrowLeft": return moveColumn(-1), true;
            case "l": case "ArrowRight": return moveColumn(1), true;
            case "Home": return colCards[cursorCol][0] && setCursor(colCards[cursorCol][0].id, { extend: e.shiftKey }), true;
            case "End": { const l = colCards[cursorCol]; return l.length && setCursor(l[l.length - 1].id, { extend: e.shiftKey }), true; }
            case "PageDown": return moveCursor(10, e.shiftKey), true;
            case "PageUp": return moveCursor(-10, e.shiftKey), true;
            case " ": {
                if (!cursorId) return true;
                if (selection.has(cursorId)) selection.delete(cursorId);
                else selection.add(cursorId);
                anchorId = cursorId;
                renderBoard();
                renderDetail();
                return true;
            }
            case "Enter": return moveCards(targets(), proposedColumn), true;
            case "u": return undo(), true;
            case "n": setTimeout(() => detailEl.querySelector(".note")?.focus(), 0); return true;
            case "t": setTimeout(() => detailEl.querySelector(".tag-input")?.focus(), 0); return true;
            case "d": descExpanded = !descExpanded; renderDetail(); return true;
            case "o": if (cursorId) window.open(data.config.trackerUrl + cursorId, "_blank"); return true;
            case "g": case "G": prefs.group = cycle(groupings, prefs.group, e.key === "g" ? 1 : -1); savePrefs(); syncControls(); render(); return true;
            case "s": case "S": prefs.sort = cycle(sorts, prefs.sort, e.key === "s" ? 1 : -1); savePrefs(); syncControls(); render(); return true;
            case "/": setTimeout(() => $("#search").focus(), 0); return true;
            case "?": $("#help").hidden = !$("#help").hidden; return true;
        }
        return false;
    })();
    if (handled) e.preventDefault();
});

// ---------- mouse ----------

boardEl.addEventListener("click", (e) => {
    const el = e.target.closest(".card");
    if (!el) {
        const col = e.target.closest(".column");
        if (col) {
            cursorCol = Number(col.dataset.col);
            renderBoard();
        }
        return;
    }
    const id = el.dataset.id;
    if (e.shiftKey) return setCursor(id, { extend: true });
    if (e.ctrlKey || e.metaKey) {
        if (selection.has(id)) selection.delete(id);
        else selection.add(id);
        return setCursor(id, { keepSelection: true });
    }
    setCursor(id);
});

let dragIds = [];
let dragColKey = null;      // set while a column header is being dragged to reorder columns

/** Puts the dragged column before or after the column it was dropped on, and remembers the order. */
function reorderColumn(key, targetIndex, after) {
    const keys = columns.map((c) => c.key).filter((k) => k !== key);
    const targetKey = columns[targetIndex].key;
    if (targetKey === key) return;
    keys.splice(keys.indexOf(targetKey) + (after ? 1 : 0), 0, key);
    prefs.colOrder = keys;
    savePrefs();
    const cursorKey = columns[cursorCol]?.key;
    applyColumnOrder();
    cursorCol = Math.max(0, columns.findIndex((c) => c.key === cursorKey));
    render();
}

/** Orders `columns` by the remembered order (new columns go at the end) and re-derives each card's starting column. */
function applyColumnOrder() {
    const order = prefs.colOrder ?? [];
    const rank = (c) => (order.includes(c.key) ? order.indexOf(c.key) : order.length + data.config.columns.indexOf(c));
    columns = [...data.config.columns].sort((a, b) => rank(a) - rank(b));
    for (const c of data.cards) c.originalCol = originalColumn(c);
}

boardEl.addEventListener("dragstart", (e) => {
    const head = e.target.closest(".col-head");
    if (head) {
        dragColKey = head.dataset.colkey;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragColKey);
        return;
    }
    const el = e.target.closest(".card");
    if (!el) return;
    const id = el.dataset.id;
    dragIds = selection.has(id) ? [...selection] : [id];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragIds.join(","));
    requestAnimationFrame(() => dragIds.forEach((d) => boardEl.querySelector(`.card[data-id="${d}"]`)?.classList.add("dragging")));
});
boardEl.addEventListener("dragover", (e) => {
    const col = e.target.closest(".column");
    if (col && dragColKey) {
        e.preventDefault();
        const r = col.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        boardEl.querySelectorAll(".column").forEach((x) => x.classList.remove("ins-before", "ins-after"));
        col.classList.add(after ? "ins-after" : "ins-before");
        return;
    }
    if (!col || !dragIds.length) return;
    e.preventDefault();
    boardEl.querySelectorAll(".column.drop").forEach((x) => x !== col && x.classList.remove("drop"));
    col.classList.add("drop");
});
boardEl.addEventListener("dragleave", (e) => {
    const col = e.target.closest(".column");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drop");
});
boardEl.addEventListener("drop", (e) => {
    const col = e.target.closest(".column");
    if (!col) return;
    e.preventDefault();
    if (dragColKey) {
        const key = dragColKey;
        dragColKey = null;
        const r = col.getBoundingClientRect();
        reorderColumn(key, Number(col.dataset.col), e.clientX > r.left + r.width / 2);
        return;
    }
    const target = Number(col.dataset.col);
    const cards = dragIds.map((id) => byId.get(id));
    dragIds = [];
    moveCards(cards, () => target);
});
boardEl.addEventListener("dragend", () => {
    dragIds = [];
    dragColKey = null;
    renderBoard();
});

detailEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-act=expand]")) {
        descExpanded = !descExpanded;
        renderDetail();
    }
});
detailEl.addEventListener("input", (e) => {
    if (!e.target.matches(".note")) return;
    const d = (decisions[cursorId] ??= {});
    d.note = e.target.value;
    if (!d.note) delete d.note;
    if (isEmptyDecision(d)) delete decisions[cursorId];
    save();
});
detailEl.addEventListener("click", (e) => {
    const c = byId.get(cursorId);
    if (!c) return;
    const x = e.target.closest(".tag-x");
    if (x) return toggleTag(c, x.dataset.tag);
    if (e.target.closest("[data-act=add-tag]")) addTypedTag(c);
});
detailEl.addEventListener("keydown", (e) => {
    if (e.target.matches(".tag-input") && e.key === "Enter") {
        e.preventDefault();
        const c = byId.get(cursorId);
        if (c) addTypedTag(c);
    }
});
$("#group").addEventListener("change", (e) => { prefs.group = e.target.value; savePrefs(); render(); boardEl.focus(); });
$("#sort").addEventListener("change", (e) => { prefs.sort = e.target.value; savePrefs(); render(); boardEl.focus(); });
$("#search").addEventListener("input", () => render());

function syncControls() {
    $("#group").value = prefs.group;
    $("#sort").value = prefs.sort;
}

// ---------- column colors ----------

const SWATCHES = ["#3d63dd", "#2f9e6a", "#d99a1e", "#d0523c", "#8a4fd1", "#1f9bb0", "#c9468f", "#7a8a2e", "#8a8f99"];
const paletteEl = document.createElement("div");
paletteEl.id = "palette";
paletteEl.hidden = true;
document.body.append(paletteEl);

/** Opens the color menu for a column at the pointer. */
function openPalette(colKey, x, y) {
    const current = prefs.colColors?.[colKey];
    paletteEl.innerHTML = `<div class="sw-row">${SWATCHES.map((s) => `<button class="sw${s === current ? " on" : ""}" data-color="${s}" style="--sw:${s}" title="${s}"></button>`).join("")}</div>
        <button class="sw-none" data-color="">No color</button>`;
    paletteEl.dataset.col = colKey;
    paletteEl.hidden = false;
    const r = paletteEl.getBoundingClientRect();
    paletteEl.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    paletteEl.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}
function closePalette() {
    paletteEl.hidden = true;
}

boardEl.addEventListener("contextmenu", (e) => {
    const col = e.target.closest(".column");
    if (!col) return;
    e.preventDefault();
    openPalette(columns[Number(col.dataset.col)].key, e.clientX, e.clientY);
});
paletteEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    const key = paletteEl.dataset.col;
    prefs.colColors ??= {};
    if (b.dataset.color) prefs.colColors[key] = b.dataset.color;
    else delete prefs.colColors[key];
    savePrefs();
    closePalette();
    renderBoard();
});
document.addEventListener("pointerdown", (e) => {
    if (!paletteEl.hidden && !paletteEl.contains(e.target)) closePalette();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !paletteEl.hidden) {
        closePalette();
        e.stopImmediatePropagation();
    }
}, true);

// ---------- synchronize with YouTrack ----------

const syncEl = $("#sync");
const syncBox = syncEl.querySelector(".box");
let syncBusy = false;
let pendingPlan = null;

/**
 * Works out what pushing would change. Each card goes to its column's board and state (a column
 * with no state keeps the card's state); as-found and come-back-later cards stay where they are.
 * Order: within each YouTrack column, cards chosen for it come first, then the ones still as
 * found, then the ones to come back to, each in the order the sorter shows them. Cards with no
 * board, and cards still as found in an anyBoard column, get no order: no single YouTrack column
 * matches them.
 */
function buildPlan() {
    const moves = [];
    const closes = [];
    const keep = [];
    const orders = new Map();
    const rank = (col) => (col.asFound ? 1 : col.later ? 2 : 0);
    const sequence = columns.map((col, i) => i).sort((a, b) => rank(columns[a]) - rank(columns[b]) || a - b);
    for (const i of sequence) {
        const col = columns[i];
        for (const c of orderColumn(i, "")) {
            if (col.close) {
                const why = decisions[c.id]?.note || c.analysis?.proposalWhy || "Closed while sorting the board.";
                closes.push({ id: c.id, title: c.title, comment: `${data.config.attribution}\n\n${why}` });
                continue;
            }
            let board = c.board;
            let state = c.state;
            if (!col.asFound && !col.later) {
                board = col.board;
                state = col.state ?? c.state;
                if (board !== c.board || state !== c.state) moves.push({ id: c.id, title: c.title, from: `${c.board ?? "No board"} / ${c.state}`, board, state: col.state ?? null });
                if (columns.some((x) => x.asFound && x.board === col.board && x.state === col.state)) keep.push(c.id);
            }
            if (board == null || col.anyBoard) continue;
            const key = `${board}|${state}`;
            if (!orders.has(key)) orders.set(key, { board, state, ids: [] });
            orders.get(key).ids.push(c.id);
        }
    }
    const tags = [];
    for (const [id, d] of Object.entries(decisions)) {
        const c = byId.get(id);
        if (!c || !d.tags) continue;
        const add = d.tags.add.map((n) => allTags?.find((t) => t.name === n)).filter((t) => t && !c.tags.some((x) => x.id === t.id));
        const remove = d.tags.remove.map((n) => c.tags.find((t) => t.name === n)).filter(Boolean);
        if (add.length || remove.length) tags.push({ id, title: c.title, add: add.map(({ id, name }) => ({ id, name })), remove: remove.map(({ id, name }) => ({ id, name })) });
    }
    return { moves, closes, keep, orders: [...orders.values()], tags };
}

function showSync(html) {
    syncBox.innerHTML = html;
    syncEl.hidden = false;
}

async function synchronize() {
    if (syncBusy) return;
    syncBusy = true;
    $("#syncBtn").disabled = true;
    showSync(`<h2>Synchronize</h2><p>Pulling the cards from YouTrack…</p>`);
    try {
        const r = await fetch("/api/pull", { method: "POST" });
        const pulled = await r.json();
        if (!r.ok) throw new Error(pulled.error);
        allTags = null;
        await load();
        if (Object.values(decisions).some((d) => d.tags?.add.length) && !(await loadTags())) throw new Error(`could not read YouTrack's tags, so the tags to add have no ids: ${tagError}`);
        pendingPlan = buildPlan();
        renderPlan(pulled, pendingPlan);
    } catch (e) {
        showSync(`<h2>Synchronize</h2><p class="bad">Pull failed: ${esc(e.message)}</p><div class="actions"><button class="btn" data-sync="close">Close</button></div>`);
    } finally {
        syncBusy = false;
        $("#syncBtn").disabled = false;
    }
}

function renderPlan(pulled, plan) {
    const pulledLine = `Pulled ${pulled.total} cards.` +
        (pulled.added.length ? ` New: ${pulled.added.join(", ")} (in their as-found columns).` : " No new cards.") +
        (pulled.dropped.length ? ` No longer in the boards and states this sorter pulls, so dropped: ${pulled.dropped.join(", ")}.` : "");
    const byTarget = new Map();
    for (const m of plan.moves) {
        const k = `${m.board} / ${m.state ?? "(keeps its state)"}`;
        if (!byTarget.has(k)) byTarget.set(k, []);
        byTarget.get(k).push(m);
    }
    const orderCount = plan.orders.reduce((n, o) => n + o.ids.length, 0);
    showSync(`<h2>Synchronize: review the changes</h2>
        <p>${esc(pulledLine)}</p>
        <h3>Move ${plan.moves.length} card${plan.moves.length === 1 ? "" : "s"}</h3>
        ${plan.moves.length ? [...byTarget].map(([k, ms]) => `<p><b>→ ${esc(k)}</b></p><ul>${ms.map((m) => `<li>${m.id} ${esc(m.title)} <span class="why">(from ${esc(m.from)})</span></li>`).join("")}</ul>`).join("") : "<p>None.</p>"}
        <h3>Close ${plan.closes.length} card${plan.closes.length === 1 ? "" : "s"}, each with a comment</h3>
        ${plan.closes.length ? `<ul>${plan.closes.map((c) => `<li>${c.id} ${esc(c.title)}<div class="comment-text">${esc(c.comment)}</div></li>`).join("")}</ul>` : "<p>None.</p>"}
        <h3>Change the tags on ${plan.tags.length} card${plan.tags.length === 1 ? "" : "s"}</h3>
        ${plan.tags.length ? `<ul>${plan.tags.map((t) => `<li>${t.id} ${esc(t.title)}: ${[...t.add.map((x) => `add "${esc(x.name)}"`), ...t.remove.map((x) => `remove "${esc(x.name)}"`)].join(", ")}</li>`).join("")}</ul>` : "<p>None.</p>"}
        <h3>Order</h3>
        <p>Set the order of ${orderCount} cards in ${plan.orders.length} YouTrack column${plan.orders.length === 1 ? "" : "s"} to match the sorter (cards chosen for a column first, then the ones still as found). Columns already in that order are left alone.</p>
        <ul>${plan.orders.map((o) => `<li>${esc(o.board)} / ${esc(o.state)}: ${o.ids.length}</li>`).join("")}</ul>
        <div class="actions"><button class="btn" data-sync="close">Cancel</button><button class="btn primary" data-sync="push">Push to YouTrack</button></div>`);
}

async function pushPlan() {
    if (syncBusy || !pendingPlan) return;
    syncBusy = true;
    $("#syncBtn").disabled = true;
    showSync(`<h2>Synchronize</h2><p>Pushing to YouTrack… (setting the order takes one call per card)</p>`);
    try {
        const r = await fetch("/api/push", { method: "POST", body: JSON.stringify(pendingPlan) });
        const result = await r.json();
        if (!r.ok) throw new Error(result.error);
        pendingPlan = null;
        await load();
        const failed = result.log.filter((l) => !l.ok);
        showSync(`<h2>Synchronize: done${failed.length ? `, with ${failed.length} failure${failed.length === 1 ? "" : "s"}` : ""}</h2>
            ${failed.length ? `<ul>${failed.map((l) => `<li class="bad">${esc(l.text)}</li>`).join("")}</ul>` : ""}
            <ul>${result.log.filter((l) => l.ok).map((l) => `<li>${esc(l.text)}</li>`).join("")}</ul>
            <p>Pulled again: ${result.pulled.total} cards.</p>
            <div class="actions"><button class="btn primary" data-sync="close">Close</button></div>`);
    } catch (e) {
        showSync(`<h2>Synchronize</h2><p class="bad">Push failed: ${esc(e.message)}</p><div class="actions"><button class="btn" data-sync="close">Close</button></div>`);
    } finally {
        syncBusy = false;
        $("#syncBtn").disabled = false;
    }
}

$("#syncBtn").addEventListener("click", synchronize);
syncEl.addEventListener("click", (e) => {
    const act = e.target.closest("[data-sync]")?.dataset.sync;
    if (act === "close" && !syncBusy) syncEl.hidden = true;
    if (act === "push") pushPlan();
});

// ---------- splitters ----------

const DEFAULT_COL_W = 228;
const DEFAULT_DETAIL_W = 420;

function applyDetailWidth() {
    document.documentElement.style.setProperty("--detail-w", `${prefs.detailWidth ?? DEFAULT_DETAIL_W}px`);
}

/**
 * Drags a column's right edge, or the splitter before the detail pane. The width changes live on
 * the element and is saved when the drag ends; a double-click restores the default.
 */
document.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".resizer");
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const colKey = handle.dataset.resize;
    const colEl = colKey ? handle.parentElement : null;
    const startX = e.clientX;
    const startW = colEl ? colEl.getBoundingClientRect().width : detailEl.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (colEl) {
            const w = Math.max(150, Math.min(700, startW + dx));
            colEl.style.width = `${w}px`;
            (prefs.colWidths ??= {})[colKey] = Math.round(w);
        } else {
            // The detail pane is to the right of the splitter, so dragging left widens it.
            const max = window.innerWidth - 300;
            prefs.detailWidth = Math.round(Math.max(280, Math.min(max, startW - dx)));
            applyDetailWidth();
        }
    };
    const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        handle.classList.remove("dragging");
        document.body.classList.remove("resizing");
        savePrefs();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
}, true);

document.addEventListener("dblclick", (e) => {
    const handle = e.target.closest(".resizer");
    if (!handle) return;
    const colKey = handle.dataset.resize;
    if (colKey) {
        delete prefs.colWidths?.[colKey];
        handle.parentElement.style.width = `${DEFAULT_COL_W}px`;
    } else {
        delete prefs.detailWidth;
        applyDetailWidth();
    }
    savePrefs();
});

// ---------- preferences (a per-browser convenience only) ----------

function loadPrefs() {
    const defaults = { group: "none", sort: "score" };
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem("cardSorterPrefs") ?? "{}") };
    } catch {
        return defaults;
    }
}
function savePrefs() {
    try {
        localStorage.setItem("cardSorterPrefs", JSON.stringify(prefs));
    } catch {
        // Preferences are a convenience; the page works without them.
    }
}

// ---------- startup and live reload ----------

async function load() {
    data = await (await fetch("/api/data")).json();
    decisions = data.decisions;
    applyColumnOrder();
    byId = new Map(data.cards.map((c) => [c.id, c]));
    document.title = data.config.title;
    $("#title").textContent = data.config.title;
    if (!groupings[prefs.group]) prefs.group = "none";
    if (!sorts[prefs.sort]) prefs.sort = "score";
    $("#group").innerHTML = Object.entries(groupings).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join("");
    $("#sort").innerHTML = Object.entries(sorts).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("");
    syncControls();
    applyDetailWidth();
    $("#help").innerHTML = `<div class="box"><table>${keyHelp.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join("")}</table>
        <p>Score = benefit (reach × severity, +6 for a roadmap feature, +2 for a partner request) × (1 − 0.12 per risk step above 1) ÷ (1 + lines/800), scaled to 100.</p></div>`;
    $("#keys").innerHTML = [["j k h l", "move"], ["⇧j ⇧k", "select range"], ["Space", "select"], [`1–${columns.length}`, "move to column"], ["Ctrl ← →", "move a column over"], ["Enter", "to proposal"], ["u", "undo"], ["n", "note"], ["t", "tag"], ["d", "details"], ["g", "group"], ["/", "search"], ["?", "all keys"]]
        .map(([k, v]) => `<span><kbd>${esc(k)}</kbd> ${esc(v)}</span>`).join("");
    if (!cursorId || !byId.has(cursorId)) cursorId = prefs.lastCursor && byId.has(prefs.lastCursor) ? prefs.lastCursor : null;
    // ?card=BL-123 opens on that card with its description expanded (handy for screenshots).
    const linked = new URLSearchParams(location.search).get("card");
    if (linked && byId.has(linked)) {
        cursorId = linked;
        descExpanded = true;
    }
    computeColumns();
    if (!cursorId) cursorId = colCards.find((l) => l.length)?.[0]?.id ?? null;
    render();
    boardEl.focus();
    if (!allTags) loadTags().then(() => renderDetail());
}

window.addEventListener("beforeunload", () => {
    prefs.lastCursor = cursorId;
    savePrefs();
});

// ?static turns live reload off, so a headless screenshot sees an idle page.
if (!new URLSearchParams(location.search).has("static")) {
    new EventSource("/api/events").onmessage = (e) => {
        if (e.data === "app") location.reload();
        else load();
    };
}

load();
