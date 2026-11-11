// The Card Sorter's only contact with YouTrack: pulling cards into raw/youtrack.json, and making
// each change John makes in the sorter (board, state, tags, comments, closing, order) as he makes it.
// Every call goes through the team's tool server (bloom-services), which makes it as the shared
// Bloom "Bot" account.
import fs from "node:fs";
import path from "node:path";
import { callService } from "../bloom-services/sources.mjs";

const host = "https://issues.bloomlibrary.org";

/** Calls the YouTrack REST API and returns parsed JSON, throwing with the response text on any failure. */
async function yt(method, p, body) {
    const r = await callService("youtrack", p, { method, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return text ? JSON.parse(text) : {};
}

const cardFields = [
    "id", "idReadable", "summary", "description", "created", "updated", "resolved", "votes",
    "reporter(login,fullName)", "tags(id,name,color(background,foreground))",
    "customFields(name,value(name,login,fullName,presentation,minutes))",
    "links(direction,linkType(name,sourceToTarget,targetToSource),issues(idReadable,summary,resolved))",
    "attachments(name,mimeType,size,url)",
    "comments(id,text,created,deleted,author(login,fullName))",
].join(",");

function fieldValue(card, name) {
    return card.customFields.find((f) => f.name === name)?.value?.name ?? null;
}

/** Every card a YouTrack query finds, with the fields the sorter shows. */
async function findAll(query) {
    const all = [];
    for (let skip = 0; ; skip += 100) {
        const page = await yt("GET", `/issues?query=${encodeURIComponent(query)}&fields=${cardFields}&$top=100&$skip=${skip}`);
        all.push(...page);
        if (page.length < 100) break;
    }
    return all;
}

/** One card, with the fields the sorter shows, as YouTrack has it now. */
export async function fetchCard(id) {
    return yt("GET", `/issues/${id}?fields=${cardFields}`);
}

/**
 * Re-extracts the cards. In scope: unresolved cards in one of `states` on a board that a column
 * names. A card on one of `sourceBoards` comes in even if it is new; a card on another board stays
 * only if the sorter already had it. Also in scope, new or not: unresolved cards of `pull.project`
 * in the state of an `anyBoard` column, on any board or none. Returns what changed.
 */
export async function pull(dataDir, config) {
    const rawFile = path.join(dataDir, "raw", "youtrack.json");
    const before = fs.existsSync(rawFile) ? JSON.parse(fs.readFileSync(rawFile, "utf8")).cards : [];
    const known = new Set(before.map((c) => c.idReadable));
    const boards = [...new Set(config.columns.map((c) => c.board).filter(Boolean))];
    const queries = [`#Unresolved State: ${config.pull.states.map((s) => `{${s}}`).join(", ")} Kanban Board: ${boards.map((b) => `{${b}}`).join(", ")}`];
    const anyBoardStates = config.columns.filter((c) => c.anyBoard).map((c) => c.state);
    if (anyBoardStates.length) {
        // Without a project, the state alone would bring in every project's cards (thousands of BH cards sit in Incoming).
        if (!config.pull.project) throw new Error("an anyBoard column needs pull.project in config.json");
        queries.push(`#Unresolved project: {${config.pull.project}} State: ${anyBoardStates.map((s) => `{${s}}`).join(", ")}`);
    }
    const [onBoards, anyBoard = []] = await Promise.all(queries.map(findAll));
    const cards = onBoards.filter((c) => config.pull.sourceBoards.includes(fieldValue(c, "Kanban Board")) || known.has(c.idReadable));
    const inBoards = new Set(cards.map((c) => c.idReadable));
    cards.push(...anyBoard.filter((c) => !inBoards.has(c.idReadable)));
    const query = queries.join("  +  ");
    const now = new Set(cards.map((c) => c.idReadable));
    fs.writeFileSync(rawFile + ".tmp", JSON.stringify({ extractedAt: new Date().toISOString(), query, cards }, null, 1));
    fs.renameSync(rawFile + ".tmp", rawFile);
    return {
        total: cards.length,
        added: cards.filter((c) => !known.has(c.idReadable)).map((c) => c.idReadable),
        dropped: before.filter((c) => !now.has(c.idReadable)).map((c) => c.idReadable),
    };
}

/**
 * Every tag the Bot can see, by name: [{ id, name, background, foreground }]. A tag also says who
 * may put it on a card, which the Bot cannot read for its own groups, so a tag listed here can
 * still be refused.
 */
export async function visibleTags() {
    const all = [];
    for (let skip = 0; ; skip += 500) {
        const page = await yt("GET", `/tags?fields=id,name,color(background,foreground)&$top=500&$skip=${skip}`);
        all.push(...page);
        if (page.length < 500) break;
    }
    return all.map(tagOf).sort((a, b) => a.name.localeCompare(b.name));
}

/** A tag as the page draws it, in YouTrack's own colours. */
export function tagOf(t) {
    return { id: t.id, name: t.name, background: t.color?.background ?? null, foreground: t.color?.foreground ?? null };
}

/**
 * Sets the card's Kanban Board and State; either one left undefined is left as it is, and a board
 * of null takes the card off every board. Throws when YouTrack ends up with something else.
 */
export async function move(id, { board, state }) {
    const customFields = [];
    if (board !== undefined) customFields.push({ name: "Kanban Board", $type: "SingleVersionIssueCustomField", value: board == null ? null : { name: board } });
    if (state !== undefined) customFields.push({ name: "State", $type: "StateIssueCustomField", value: { name: state } });
    if (!customFields.length) return;
    const r = await yt("POST", `/issues/${id}?fields=customFields(name,value(name))`, { customFields });
    const nowBoard = fieldValue(r, "Kanban Board");
    const nowState = fieldValue(r, "State");
    if ((board !== undefined && nowBoard !== board) || (state !== undefined && nowState !== state)) {
        throw new Error(`YouTrack now says ${nowBoard ?? "no board"} / ${nowState}`);
    }
}

/** Puts a tag on the card or takes it off, then checks that YouTrack agrees. */
export async function setTag(id, tag, on) {
    if (on) await yt("POST", `/issues/${id}/tags?fields=id`, { id: tag.id });
    else await yt("DELETE", `/issues/${id}/tags/${tag.id}`);
    const now = ((await yt("GET", `/issues/${id}?fields=tags(id)`)).tags ?? []).some((x) => x.id === tag.id);
    if (now !== on) throw new Error(`"${tag.name}" is ${now ? "still" : "not"} on the card afterwards`);
}

export async function addComment(id, text) {
    await yt("POST", `/issues/${id}/comments?fields=id`, { text });
}

/**
 * Resolves the card with a comment. A comment on a closed card reopens it, so the comment goes up
 * first and the card closes after; a card that already has this exact comment, from a close that
 * failed, does not get it again.
 */
export async function close(config, id, comment) {
    const { comments = [] } = await yt("GET", `/issues/${id}?fields=comments(text)`);
    if (!comments.some((m) => m.text === comment)) await addComment(id, comment);
    await yt("POST", `/issues/${id}?fields=id`, { customFields: [{ name: "State", $type: "StateIssueCustomField", value: { name: config.closeState } }] });
    const r = await yt("GET", `/issues/${id}?fields=resolved,customFields(name,value(name))`);
    if (!r.resolved) throw new Error(`still unresolved; State is ${fieldValue(r, "State")}`);
}

/** The agile board's sprint id for a Kanban Board value (the board's sprints are its versions). */
async function sprintIdFor(config, boardName) {
    const agile = await yt("GET", `/agiles/${config.agileId}?fields=sprints(id,name)`);
    const sprint = agile.sprints.find((s) => s.name === boardName);
    if (!sprint) throw new Error(`no sprint named "${boardName}" on agile ${config.agileId}`);
    return sprint.id;
}

/**
 * Makes `ids` the top of each board column, in that order: orders is [{ board, state, ids }].
 * Uses issueOrder, an undocumented board request copied from YouTrack's own board page; YouTrack
 * refuses it while the board sorts by a query. Returns one line per column, done or failed.
 */
export async function setOrder(config, orders) {
    const log = [];
    const sprints = {};
    for (const o of orders) {
        const where = `${o.board} / ${o.state}`;
        try {
            sprints[o.board] ??= await sprintIdFor(config, o.board);
            const base = `/agiles/${config.agileId}/sprints/${sprints[o.board]}/board`;
            const board = await yt("GET", `${base}?fields=sortByQuery,orphanRow(cells(id,column(id,presentation),issues(id,idReadable)))`);
            if (board.sortByQuery) throw new Error("the board sorts by query, so YouTrack refuses manual order");
            const cell = board.orphanRow.cells.find((x) => x.column.presentation === o.state);
            if (!cell) throw new Error("no such column on that board");
            const internal = new Map(cell.issues.map((i) => [i.idReadable, i.id]));
            const wanted = o.ids.filter((id) => internal.has(id));
            const current = cell.issues.map((i) => i.idReadable).filter((id) => wanted.includes(id));
            if (current.join() === wanted.join()) {
                log.push({ ok: true, text: `${where}: order already right (${wanted.length} cards)` });
                continue;
            }
            let leading = null;
            for (const id of wanted) {
                await yt("POST", `${base}/columns/${cell.column.id}/cells/${cell.id}/issueOrder?fields=leading(id),moved(id)`, {
                    leading: leading ? { id: leading } : null,
                    moved: { id: internal.get(id) },
                });
                leading = internal.get(id);
            }
            const missing = o.ids.length - wanted.length;
            log.push({ ok: true, text: `${where}: ordered ${wanted.length} cards${missing ? ` (${missing} not in that column yet)` : ""}` });
        } catch (e) {
            log.push({ ok: false, text: `${where}: ordering failed: ${e.message}` });
        }
    }
    return log;
}

/** The full URL of an attachment, from the signed path YouTrack returns. */
export function attachmentUrl(signedPath) {
    return host + signedPath;
}
