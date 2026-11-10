// The Card Sorter's only contact with YouTrack: pulling cards into raw/youtrack.json, and pushing
// John's confirmed decisions (board, state, closing, order within a column) back.
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
 * still be refused when pushed.
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

/** The agile board's sprint id for a Kanban Board value (the board's sprints are its versions). */
async function sprintIdFor(config, boardName) {
    const agile = await yt("GET", `/agiles/${config.agileId}?fields=sprints(id,name)`);
    const sprint = agile.sprints.find((s) => s.name === boardName);
    if (!sprint) throw new Error(`no sprint named "${boardName}" on agile ${config.agileId}`);
    return sprint.id;
}

/**
 * Pushes a plan the page built and John confirmed:
 *   moves:  [{ id, board, state }]   set Kanban Board and State
 *   closes: [{ id, comment }]        resolve the card, adding the comment
 *   orders: [{ board, state, ids }]  make `ids` the top of that column, in that order
 *   tags:   [{ id, add: [{ id, name }], remove: [{ id, name }] }]  put tags on the card or take them off
 * Returns one line per thing done or failed. A failure is reported and the rest carries on. A
 * card's tag line has `tagsDone` only when all of its tag changes went through.
 */
export async function push(config, plan) {
    const log = [];
    for (const t of plan.tags ?? []) {
        const failed = [];
        for (const tag of t.add) {
            try {
                await yt("POST", `/issues/${t.id}/tags?fields=id`, { id: tag.id });
            } catch (e) {
                failed.push(`add "${tag.name}": ${e.message}`);
            }
        }
        for (const tag of t.remove) {
            try {
                await yt("DELETE", `/issues/${t.id}/tags/${tag.id}`);
            } catch (e) {
                failed.push(`remove "${tag.name}": ${e.message}`);
            }
        }
        try {
            const now = new Set(((await yt("GET", `/issues/${t.id}?fields=tags(id)`)).tags ?? []).map((x) => x.id));
            for (const tag of t.add) if (!now.has(tag.id) && !failed.some((f) => f.startsWith(`add "${tag.name}"`))) failed.push(`"${tag.name}" is not on the card afterwards`);
            for (const tag of t.remove) if (now.has(tag.id) && !failed.some((f) => f.startsWith(`remove "${tag.name}"`))) failed.push(`"${tag.name}" is still on the card`);
        } catch (e) {
            failed.push(`reading the tags back: ${e.message}`);
        }
        const what = [...t.add.map((x) => `+${x.name}`), ...t.remove.map((x) => `−${x.name}`)].join(", ");
        if (failed.length) log.push({ ok: false, text: `${t.id}: tags ${what}: ${failed.join("; ")}` });
        else log.push({ ok: true, id: t.id, tagsDone: true, text: `${t.id} tags: ${what}` });
    }
    for (const m of plan.moves) {
        try {
            const customFields = [{ name: "Kanban Board", $type: "SingleVersionIssueCustomField", value: { name: m.board } }];
            if (m.state) customFields.push({ name: "State", $type: "StateIssueCustomField", value: { name: m.state } });
            const r = await yt("POST", `/issues/${m.id}?fields=customFields(name,value(name))`, { customFields });
            const board = fieldValue(r, "Kanban Board");
            const state = fieldValue(r, "State");
            if (board !== m.board || (m.state && state !== m.state)) throw new Error(`YouTrack now says ${board} / ${state}`);
            log.push({ ok: true, id: m.id, text: `${m.id} → ${m.board} / ${state}` });
        } catch (e) {
            log.push({ ok: false, text: `${m.id}: move failed: ${e.message}` });
        }
    }
    for (const c of plan.closes) {
        try {
            await yt("POST", "/commands", { query: `State ${config.closeState}`, issues: [{ idReadable: c.id }], comment: c.comment });
            const r = await yt("GET", `/issues/${c.id}?fields=resolved,customFields(name,value(name))`);
            if (!r.resolved) throw new Error(`still unresolved; State is ${fieldValue(r, "State")}`);
            log.push({ ok: true, id: c.id, text: `${c.id} closed` });
        } catch (e) {
            log.push({ ok: false, text: `${c.id}: close failed: ${e.message}` });
        }
    }
    const sprints = {};
    for (const o of plan.orders) {
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
