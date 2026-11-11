// Card Sorter: a local app for sorting tracker cards into destinations (e.g. 6.6 / 6.7).
// Usage: node server.mjs <dataDir> [port] [--no-open]
//
// Once listening, it opens the page in a tab of the default browser, unless a page left open from
// an earlier run reconnects first or --no-open is given.
//
// <dataDir> holds:
//   raw/youtrack.json        cards as extracted from YouTrack ({ cards: [...] }); rewritten by Refresh,
//                            and one card at a time after each change
//   raw/prs-<repo>.json      PRs per repo (gh pr list --json ...), optional
//   raw/branches-<repo>.txt  remote branch names, optional
//   analysis/*.json          arrays of per-card analysis objects, merged by id, optional
//   config.json              destinations and title, optional
//   decisions.json           what lives only in the sorter: { "<id>": { later, draft, at } }
//
// The server serves the page and the data, and tells the page to reload (Server-Sent Events) when
// the app's files or the data change. Each change John makes goes to YouTrack at once through
// /api/change (see youtrack.mjs); /api/pull re-extracts the cards and /api/order sets the order of
// the board's columns.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addComment, attachmentUrl, close, fetchCard, move, pull, setOrder, setTag, tagOf, visibleTags } from "./youtrack.mjs";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");
const dataDir = path.resolve(process.argv[2] ?? "");
const port = Number(process.argv.slice(3).find((a) => !a.startsWith("--")) ?? 5177);
if (!process.argv[2] || !fs.existsSync(path.join(dataDir, "raw", "youtrack.json"))) {
    console.error("usage: node server.mjs <dataDir> [port]   (dataDir must contain raw/youtrack.json)");
    process.exit(1);
}
const decisionsFile = path.join(dataDir, "decisions.json");

/** Git's user.name, for the attribution line on comments the Bot posts. */
function developerName() {
    try {
        return execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8" }).trim();
    } catch {
        return "the developer";
    }
}

const defaultConfig = {
    title: "Card Sorter",
    agileId: "89-5",
    // Synchronize pulls unresolved cards in these states: new ones only from sourceBoards, and ones
    // the sorter already has from any board a column names. It also pulls every unresolved card of
    // `project` in the state of an `anyBoard` column, whatever its board, and cards with no board.
    pull: { sourceBoards: ["Bloom 6.6"], states: ["Open", "Ready For Work"], project: "BL" },
    closeState: "Closed",
    attribution: `[Claude Opus 5.5 from ${developerName()}'s machine during card-sorter]`,
    trackerUrl: "https://issues.bloomlibrary.org/youtrack/issue/",
    // Each column is a place a card can end up: a board (Kanban Board value) plus, optionally, a
    // State. A column without a state shows the board's cards in every state; a card moved there
    // gets the column's newState, or keeps its own State when the column has none.
    // A card starts in the column of its board and state. An "asFound" column holds cards nobody has
    // sorted yet: a card that stays in it is left as it is. A column with the same board and state
    // but no asFound flag would split the cards chosen to stay there from the rest.
    // An "anyBoard" column holds the cards in its state on every board, and the cards with no
    // board. Its cards keep their board until the developer moves them to another column.
    columns: [
        { key: "incoming|found", label: "Incoming (any board)", board: null, state: "Incoming", anyBoard: true, asFound: true },
        // Not a board: a parking place for cards John can't decide yet. Applying leaves them as they are.
        { key: "later", label: "Come back later", board: null, state: null, later: true },
        { key: "6.6|Open", label: "6.6 Open", board: "Bloom 6.6", state: "Open" },
        { key: "6.6|Ready For Work", label: "6.6 Ready For Work", board: "Bloom 6.6", state: "Ready For Work" },
        { key: "6.7|Open", label: "6.7 Open", board: "Bloom 6.7", state: "Open" },
        { key: "6.7|Ready For Work", label: "6.7 Ready For Work", board: "Bloom 6.7", state: "Ready For Work" },
        { key: "live-with", label: "Issues We'll Live With", board: "Issues We'll Live With for now", state: null, newState: "Open" },
        // Not a board: applying it resolves the card (fixed, done, or duplicate) with a comment.
        { key: "close", label: "Close / done", board: null, state: null, close: true },
    ],
    // Maps an analysis `proposal` to the board it names; the column is the one on that board with
    // the card's current state (or the board's only column). A proposal mapped to null has no column.
    proposalBoards: { "6.6": "Bloom 6.6", "6.7": "Bloom 6.7", "live-with": "Issues We'll Live With for now", future: null },
};

/** Read a JSON file, or return the fallback when the file is missing. */
function readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Returns the value of a YouTrack custom field as display text. */
function field(card, name) {
    const f = card.customFields.find((x) => x.name === name);
    if (!f || f.value == null) return null;
    if (Array.isArray(f.value)) return f.value.map((v) => v.name ?? v.fullName).join(", ");
    return f.value.name ?? f.value.fullName ?? f.value.presentation ?? null;
}

/** Returns the value of a YouTrack text custom field, or null when it is empty. */
function text(card, name) {
    const v = card.customFields.find((x) => x.name === name)?.value;
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Collects PRs and branches whose title or branch name mentions each card id. */
function findWork(ids) {
    const work = Object.fromEntries(ids.map((id) => [id, []]));
    const rawDir = path.join(dataDir, "raw");
    const idPattern = /BL-\d+/gi;
    for (const file of fs.readdirSync(rawDir)) {
        const prMatch = /^prs-(.+)\.json$/.exec(file);
        if (prMatch) {
            for (const pr of readJson(path.join(rawDir, file), [])) {
                const found = new Set([...`${pr.title} ${pr.headRefName}`.matchAll(idPattern)].map((m) => m[0].toUpperCase()));
                for (const id of found) {
                    work[id]?.push({ kind: "pr", repo: prMatch[1], number: pr.number, title: pr.title, state: pr.isDraft && pr.state === "OPEN" ? "DRAFT" : pr.state, url: pr.url, updatedAt: pr.updatedAt });
                }
            }
        }
        const brMatch = /^branches-(.+)\.txt$/.exec(file);
        if (brMatch) {
            for (const branch of fs.readFileSync(path.join(rawDir, file), "utf8").split(/\r?\n/).filter(Boolean)) {
                for (const m of branch.matchAll(idPattern)) work[m[0].toUpperCase()]?.push({ kind: "branch", repo: brMatch[1], name: branch });
            }
        }
    }
    return work;
}

/** Builds the payload the page renders: normalized cards with their analysis and decisions. */
function buildData() {
    const raw = readJson(path.join(dataDir, "raw", "youtrack.json"));
    const analysis = readAnalysis();
    const work = findWork(raw.cards.map((c) => c.idReadable));
    return {
        config: { ...defaultConfig, ...readJson(path.join(dataDir, "config.json"), {}) },
        extractedAt: raw.extractedAt,
        cards: raw.cards.map((c) => pageCard(c, work, analysis)),
        decisions: readJson(decisionsFile, {}),
    };
}

/** Every card's analysis, by id. */
function readAnalysis() {
    const analysis = {};
    const analysisDir = path.join(dataDir, "analysis");
    if (fs.existsSync(analysisDir)) {
        for (const file of fs.readdirSync(analysisDir).filter((f) => f.endsWith(".json"))) {
            for (const a of readJson(path.join(analysisDir, file), [])) analysis[a.id] = a;
        }
    }
    return analysis;
}

/** A card as YouTrack returns it, in the shape the page draws. */
function pageCard(c, work, analysis) {
    return {
        id: c.idReadable,
        title: c.summary,
        description: c.description ?? "",
        state: field(c, "State"),
        type: field(c, "Type"),
        assignee: field(c, "Assignee"),
        board: field(c, "Kanban Board"),
        tags: c.tags.map(tagOf),
        created: c.created,
        updated: c.updated,
        votes: c.votes,
        // Who reported it: the Reporter Name or Reporter Email fields that problem reports fill in,
        // or else whoever created the card.
        reporter: text(c, "Reporter Name") ?? text(c, "Reporter Email") ?? c.reporter?.fullName ?? c.reporter?.login ?? null,
        reporterEmail: text(c, "Reporter Email"),
        links: (c.links ?? []).flatMap((l) => l.issues.map((i) => ({
            relation: l.direction === "INWARD" ? l.linkType.targetToSource || l.linkType.name : l.linkType.sourceToTarget || l.linkType.name,
            id: i.idReadable, title: i.summary, resolved: i.resolved != null,
        }))),
        comments: (c.comments ?? []).filter((x) => !x.deleted).map((x) => ({ author: x.author?.fullName ?? x.author?.login, created: x.created, text: x.text })),
        attachments: (c.attachments ?? []).map((a) => ({ name: a.name, url: attachmentUrl(a.url), mimeType: a.mimeType })),
        resolved: c.resolved != null,
        work: work[c.idReadable],
        analysis: analysis[c.idReadable] ?? null,
    };
}

let tagList = null;
const clients = new Set();
/** Tells every open page to reload; `what` is "app" (reload the page) or "data" (refetch). */
function broadcast(what) {
    for (const res of clients) res.write(`data: ${what}\n\n`);
}
let lastOwnWrite = 0;
let pending = null;
/** Debounces file-change events into one broadcast. */
function changed(what) {
    if (what === "data" && Date.now() - lastOwnWrite < 500) return;
    clearTimeout(pending);
    pending = setTimeout(() => broadcast(what), 120);
}
fs.watch(appDir, { recursive: true }, () => changed("app"));
fs.watch(dataDir, { recursive: true }, (_e, name) => {
    if (name && !/decisions\.json$/.test(name)) changed("data");
});

const mime = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".bmp": "image/bmp", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};

function readBody(req, then) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => then(body));
}

/** Runs an async handler and sends its result as JSON, or the error message with status 500. */
async function respond(res, handler) {
    try {
        const result = await handler();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (e) {
        console.error(e);
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
}

function writeDecisions(decisions) {
    lastOwnWrite = Date.now();
    fs.writeFileSync(decisionsFile + ".tmp", JSON.stringify(decisions, null, 1));
    fs.renameSync(decisionsFile + ".tmp", decisionsFile);
}

/** Puts a card fetched from YouTrack in place of the sorter's copy, and returns it as the page shows it. */
function replaceCard(fresh) {
    const rawFile = path.join(dataDir, "raw", "youtrack.json");
    const raw = readJson(rawFile);
    const i = raw.cards.findIndex((c) => c.idReadable === fresh.idReadable);
    if (i >= 0) raw.cards[i] = fresh;
    else raw.cards.push(fresh);
    lastOwnWrite = Date.now();
    fs.writeFileSync(rawFile + ".tmp", JSON.stringify(raw, null, 1));
    fs.renameSync(rawFile + ".tmp", rawFile);
    return pageCard(fresh, findWork([fresh.idReadable]), readAnalysis());
}

/** Drops decisions for cards that are no longer in the sorter. */
function pruneDecisions() {
    const ids = new Set(readJson(path.join(dataDir, "raw", "youtrack.json")).cards.map((c) => c.idReadable));
    const decisions = readJson(decisionsFile, {});
    let changed = false;
    for (const id of Object.keys(decisions)) {
        if (!ids.has(id)) {
            delete decisions[id];
            changed = true;
        }
    }
    if (changed) writeDecisions(decisions);
}

http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/data") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify(buildData()));
    }
    if (url.pathname === "/api/tags") {
        // Read again after each Synchronize, so a tag made or shared in YouTrack shows then.
        return respond(res, async () => (tagList ??= await visibleTags()));
    }
    if (url.pathname === "/api/decisions" && req.method === "POST") {
        // The page sends the whole decisions map; it is small, and this keeps the file consistent.
        return readBody(req, (body) => {
            writeDecisions(JSON.parse(body));
            res.writeHead(204).end();
        });
    }
    if (url.pathname === "/api/pull" && req.method === "POST") {
        return respond(res, async () => {
            const config = buildData().config;
            lastOwnWrite = Date.now();
            tagList = null;
            const result = await pull(dataDir, config);
            pruneDecisions();
            return result;
        });
    }
    if (url.pathname === "/api/change" && req.method === "POST") {
        // One change to one card, made in YouTrack at once. Whether it went through or not, the
        // card is read back and returned as YouTrack now has it, so the page shows the truth.
        return readBody(req, (body) => respond(res, async () => {
            const { id, kind, ...a } = JSON.parse(body);
            const config = buildData().config;
            let error = null;
            try {
                if (kind === "move") await move(id, a);
                else if (kind === "tag") await setTag(id, a.tag, a.on);
                else if (kind === "comment") await addComment(id, `${config.attribution}\n\n${a.text}`);
                else if (kind === "close") await close(config, id, `${config.attribution}\n\n${a.text}`);
                else throw new Error(`no such change: ${kind}`);
            } catch (e) {
                error = e.message;
            }
            return { error, card: replaceCard(await fetchCard(id)) };
        }));
    }
    if (url.pathname === "/api/order" && req.method === "POST") {
        return readBody(req, (body) => respond(res, async () => setOrder(buildData().config, JSON.parse(body))));
    }
    if (url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(": hello\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
    }
    const file = path.join(appDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(appDir) || !fs.existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}/`;
    console.log(`Card Sorter: ${url}  (data: ${dataDir})`);
    // A page left open from an earlier run reconnects to /api/events within a few seconds; open a
    // tab only when none does, so restarting the server does not add a second tab.
    if (!process.argv.includes("--no-open")) setTimeout(() => { if (!clients.size) openTab(url); }, 6000);
});

/** Opens the URL in a tab of the default browser. */
function openTab(url) {
    const [cmd, args] =
        process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", (e) => console.error(`Could not open ${url}: ${e.message}`)).unref();
    console.log(`Opened ${url} in the default browser.`);
}
