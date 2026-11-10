// The commands that read and write the team's web services: YouTrack, Sentry, Slack history,
// Notion, Cloudflare, Mixpanel, Bloom Library books, the community forum, TeamCity and the status
// pages. tools.mjs beside this file runs them for a developer's Claude; the Bloom bot's
// bot-tools.mjs (in the private BloomBooks/bloom-bot repo) runs the same ones for the bot. Each
// command takes its arguments and the text of its @<file> body, and returns the text to print.
//
// A service that needs a token is called through `callService`, which sends the request to the
// tool server, a Cloudflare Worker that holds the tokens and adds the right one. The Worker lets
// in the bot (by its own token) and any member of the BloomBooks GitHub organization (by their
// `gh auth token`), and passes each request on as it is, with the token added (bloom-bot's
// worker/src/services.js). Public services (the forum, Bloom Library, TeamCity as a guest, the
// status pages) are called directly.
//
//   youtrack [GET|POST|DELETE] <api path> [@<file>]     YouTrack's REST API as the Bot account
//   attachment <issue id> <name>                         saves the attachment to ./.card/<name>
//   youtrack-upload <issue id> <file> [<file>...]        attaches files (pictures, videos) to a card
//   sentry <api path>                                    a GET on Sentry's API
//   sentry-status                                        what https://status.sentry.io/ reports now
//   sentry-write <PUT|POST|DELETE> <api path> [@<file>]  changes Sentry (the bot only)
//   slack-history <channel id> [days] [words...]         a Slack channel's messages over the last days
//                                                        (30 by default), only those with every word
//   slack-thread <channel id> <message ts>               one Slack thread
//   book <Bloom Library link or book id>                 saves a public book's files under ./.book/<title>/
//   community <path>                                     a GET on the community forum's JSON
//                                                        (https://community.software.sil.org), e.g.
//                                                        /c/bloom/5.json, /t/<topic id>.json, /search.json?q=...
//   notion <api path> [@<file>]                          a GET on Notion's API, or a POST to /search or
//                                                        /databases/<id>/query; search and query
//                                                        results print one line each
//   notion-text <page id>                                a Notion page's content as plain text
//   teamcity <api path>                                  a GET on TeamCity's REST API, as a guest
//   cloudflare <api path>                                a GET on Cloudflare's API (/zones, ...)
//   cloudflare-status                                    what https://www.cloudflarestatus.com/ reports now
//   mixpanel-projects                                    the Mixpanel projects the service account can read
//   mixpanel <project id> <api path>                     a GET on Mixpanel's Query API for one project

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Where the tool server runs. It has no address on Cloudflare yet: until it does, the bot runs it
// on its own machine and BLOOM_BOT_WORKER_URL names it. Set this to the Worker's address once it is
// deployed (bloom-bot's docs/cloudflare-tools/PLAN.md), so that developers need to set nothing.
const DEFAULT_WORKER_URL = undefined;

const YOUTRACK = "https://issues.bloomlibrary.org/youtrack";
const SLACK_MAX_MESSAGES = 1000;
const BOOK_MAX_BYTES = 300 * 1024 * 1024;
const MAX_PRINT_CHARS = 40_000;
const PARSE = "https://server.bloomlibrary.org/parse";
// Bloom Library's public Parse application id, the one its website sends (BloomLibrary2's
// ParseConnectionConfig.ts). It reads only what anyone may read.
const PARSE_APP_ID = "R6qNTeumQXjJCMutAJYAwPtip1qBulkFyLefkCE5";
const TEAMCITY_URL = "https://build.palaso.org";

/** How callService reaches the services; set by configure(). */
let settings = {};

/**
 * Tells callService how to reach the services. `workerUrl` is the tool server's address (by
 * default BLOOM_BOT_WORKER_URL, then the Worker's address on Cloudflare). `token` is what the
 * caller signs in to it with: the bot passes its own; anyone else is signed in with their GitHub
 * login (`gh auth token`). `direct`, which only the bot passes, sends a request straight to the
 * service with the bot's own tokens when it has no tool server: it takes the request and returns
 * a Promise of the service's Response. `filesInCwdOnly`, which the bot sets, refuses a body or
 * upload file outside the working directory, so a command can't send one of its own files, such
 * as its tokens, to a service.
 */
export function configure({ workerUrl, token, direct, filesInCwdOnly = false } = {}) {
    settings = { workerUrl, token, direct, filesInCwdOnly };
}

/** The tool server's address, or an error that says how to get one. */
function workerUrl() {
    const url = settings.workerUrl || process.env.BLOOM_BOT_WORKER_URL || DEFAULT_WORKER_URL;
    if (!url) {
        throw new Error("The tool server that holds the team's service tokens isn't on Cloudflare yet, so it has no address to call. "
            + "Until it is, set BLOOM_BOT_WORKER_URL to the address of one that is running (see bloom-bot's worker/README.md).");
    }
    return url;
}

let githubToken;
/** The token the caller signs in to the tool server with. */
function signInToken() {
    if (settings.token) return settings.token;
    if (githubToken === undefined) {
        try {
            githubToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        } catch (error) {
            throw new Error(`The tool server signs you in with your GitHub login, and \`gh auth token\` failed: ${String(error.stderr || error.message).trim()}\nRun \`gh auth login\` once.`);
        }
    }
    return githubToken;
}

/** Fails loudly on a non-2xx status. A 5xx says that the service is down, so the caller doesn't
 * take it for a problem with its request. `where` names the request in the message. */
async function check(response, where, host = new URL(where).host) {
    if (response.status >= 500) throw new Error(`${host} is down: HTTP ${response.status} (a server error on their side) from ${where}`);
    if (!response.ok) throw new Error(`${response.status} from ${where}: ${(await response.text()).slice(0, 500)}`);
    return response;
}

/** Fetches with a timeout; a timeout says that the host is down. */
async function fetchWithTimeout(url, init = {}, timeoutMs = 120_000) {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        if (error.name === "TimeoutError") throw new Error(`${new URL(url).host} is down: no reply within ${timeoutMs / 1000} s to ${url}`);
        throw error;
    }
}

/** Sends a request to one of the tool server's services ("youtrack", "sentry", "slack", "notion",
 * "cloudflare", "mixpanel") and returns the checked Response. Scripts in the team skills and the
 * bot's jobs call it too, for the services they use themselves. */
export async function callService(service, apiPath, { method = "GET", body, bodyBytes, contentType } = {}) {
    // The tool server passes the request on as it is, so the body goes as text or as bytes, such as
    // a file upload, and the headers here are the ones the service sees.
    const sent = bodyBytes ?? body;
    const headers = { Accept: "application/json" };
    if (sent !== undefined) headers["Content-Type"] = contentType || "application/json";
    const where = `${service} ${method} ${apiPath}`;
    if (settings.direct && !settings.workerUrl && !process.env.BLOOM_BOT_WORKER_URL) {
        return check(await settings.direct({ service, method, path: apiPath, headers, body: sent }), where, service);
    }
    const server = workerUrl();
    let response;
    try {
        response = await fetch(`${server.replace(/\/$/, "")}/${service}${apiPath}`, {
            method,
            signal: AbortSignal.timeout(150_000),
            headers: { ...headers, Authorization: `Bearer ${signInToken()}` },
            body: sent,
        });
    } catch (error) {
        throw new Error(`the tool server (${server}) is down: ${error.name === "TimeoutError" ? "no reply within 150 s" : error.cause?.message ?? error.message}`);
    }
    if (response.headers.get("Bloom-Bot-Forwarded") === "yes") return check(response, where, service);
    // The tool server's own answer: no such service, a missing token, or the service couldn't be reached.
    const text = await response.text();
    let error;
    try {
        error = JSON.parse(text).error;
    } catch {
        error = undefined;
    }
    throw new Error(error ?? `the tool server (${server}) answered HTTP ${response.status}: ${text.slice(0, 300)}`);
}

/** Parses a reply as JSON, or returns its text when it isn't JSON. */
async function parsed(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

const serviceJson = async (service, apiPath, options) => parsed(await callService(service, apiPath, options));
const publicJson = async (url, headers = {}) => parsed(await check(await fetchWithTimeout(url, { headers: { Accept: "application/json", ...headers } }), url));

/** Git Bash on Windows turns an argument such as "/pages" into "C:/Program Files/Git/pages", and one
 * such as "/c/bloom/5.json" into "C:/bloom/5.json", before node sees it; this turns it back.
 * MINGW_PREFIX, which Git Bash sets, is Git's folder plus "/mingw64". */
function undoGitBashPath(p) {
    const prefix = process.env.MSYSTEM && process.env.MINGW_PREFIX;
    if (!prefix || typeof p !== "string") return p;
    const root = prefix.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
    const slashed = p.replace(/\\/g, "/");
    if (slashed.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return slashed.slice(root.length);
    const drive = /^([A-Za-z]):\/(.*)$/s.exec(slashed);
    return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : p;
}

/** Rejects anything but an API path, so a caller can't point a request at another host. */
function apiPath(p) {
    p = undoGitBashPath(p);
    if (!p || !p.startsWith("/") || p.startsWith("//")) throw new Error(`expected an API path starting with /, got ${p}`);
    return p;
}

const json = (data) => {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
    return text.length > MAX_PRINT_CHARS ? `${text.slice(0, MAX_PRINT_CHARS)}\n... cut at ${MAX_PRINT_CHARS} characters; ask for less` : text;
};

/** The full path of a file that a command sends to a service; see `filesInCwdOnly` in configure(). */
function sendableFile(name) {
    const file = fs.realpathSync(path.resolve(name));
    const root = fs.realpathSync(process.cwd());
    if (settings.filesInCwdOnly && !file.startsWith(root + path.sep)) throw new Error(`the file must be inside ${root}, not ${file}`);
    return file;
}

/** Reads a request body from "@<file>". The bot's bot-tools.mjs reads its github-comment bodies
 * with this too, so one check decides which files a command may send. */
export function requestBody(arg) {
    if (arg === undefined) return undefined;
    if (!arg.startsWith("@")) throw new Error(`expected the body as @<file>, got ${arg.slice(0, 80)}`);
    return fs.readFileSync(sendableFile(arg.slice(1)), "utf8");
}

// What YouTrack is told each uploaded file is, by its extension.
const UPLOAD_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain",
    ".zip": "application/zip", ".json": "application/json", ".html": "text/html" };

// The commands that take an "@<file>" request body, always as their last argument.
const TAKES_BODY = ["youtrack", "notion", "sentry-write"];

/** Splits a command's arguments from its "@<file>" body, which it reads; returns [args, body]. */
export function splitBody(command, args) {
    const last = args[args.length - 1];
    return TAKES_BODY.includes(command) && last?.startsWith("@") ? [args.slice(0, -1), requestBody(last)] : [args, undefined];
}

/** Calls a Slack Web API method through the tool server; Slack's own errors become exceptions. */
export async function slack(method, params) {
    const data = await serviceJson("slack", `/${method}`, { method: "POST", body: new URLSearchParams(params).toString(), contentType: "application/x-www-form-urlencoded" });
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}${data.error === "not_in_channel" ? " (the bot must be added to that channel)" : ""}`);
    return data;
}

/** Renders Slack messages as "time | who | text" lines, naming each person once looked up. */
async function slackLines(messages) {
    const names = new Map();
    const lines = [];
    for (const m of messages) {
        let who = m.bot_profile?.name || m.username || "a bot";
        if (m.user) {
            if (!names.has(m.user)) {
                const { user } = await slack("users.info", { user: m.user });
                names.set(m.user, user.real_name || user.name);
            }
            who = names.get(m.user);
        }
        const replies = m.reply_count ? ` [thread ts ${m.ts}, ${m.reply_count} replies]` : "";
        lines.push(`${new Date(Number(m.ts) * 1000).toISOString()} | ${who} | ${(m.text || "").replace(/\n/g, " ")}${replies}`);
    }
    return lines.join("\n") || "no messages";
}

/** The Parse book id in a Bloom Library link (…/book/<id>, …/player/<id>, …/readBook/<id>) or
 * a bare id. */
function bookId(arg) {
    const match = /(?:book|player|readBook)\/([A-Za-z0-9]{8,12})/.exec(arg ?? "") ?? /^([A-Za-z0-9]{8,12})$/.exec(arg ?? "");
    if (!match) throw new Error(`expected a Bloom Library book link or id, got ${arg}`);
    return match[1];
}

/** Saves a public Bloom Library book's uploaded files under ./.book/<title>/. */
async function downloadBook(arg) {
    const id = bookId(arg);
    const book = await publicJson(`${PARSE}/classes/books/${id}?keys=title,baseUrl,inCirculation,harvestState,uploader`, { "X-Parse-Application-Id": PARSE_APP_ID });
    const match = /^https:\/\/s3\.amazonaws\.com\/([^/]+)\/(.+)$/.exec(book.baseUrl ?? "");
    if (!match) throw new Error(`book ${id} has no files on S3 (baseUrl ${book.baseUrl})`);
    const [, bucket, encodedPrefix] = match;
    const prefix = decodeURIComponent(encodedPrefix.replace(/\+/g, " "));
    // S3 lists at most 1,000 files a page; a longer listing ends with a token for the next page.
    const keys = [];
    let token;
    do {
        const listing = String(await publicJson(`https://s3.amazonaws.com/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`));
        keys.push(...[...listing.matchAll(/<Key>([^<]+)<\/Key>\s*<LastModified>[^<]*<\/LastModified>\s*<ETag>[^<]*<\/ETag>\s*<Size>(\d+)<\/Size>/g)]
            .map(([, key, size]) => ({ key: key.replace(/&amp;/g, "&"), size: Number(size) })));
        token = /<IsTruncated>true<\/IsTruncated>/.test(listing) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(listing)?.[1].replace(/&amp;/g, "&") : undefined;
    } while (token);
    const total = keys.reduce((sum, k) => sum + k.size, 0);
    if (total > BOOK_MAX_BYTES) throw new Error(`book ${id} is ${Math.round(total / 1024 / 1024)} MB, over the ${BOOK_MAX_BYTES / 1024 / 1024} MB limit`);
    const dir = path.join(process.cwd(), ".book", (book.title || id).replace(/[^\w .-]+/g, "_"));
    for (const { key } of keys) {
        const relative = key.slice(prefix.length);
        if (!relative || relative.includes("..")) continue;
        const file = path.join(dir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const response = await fetchWithTimeout(`https://s3.amazonaws.com/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
        if (!response.ok) throw new Error(`${response.status} downloading ${key}`);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return `${book.title} (${book.inCirculation === false ? "not in circulation" : "in circulation"}, harvest ${book.harvestState}): ${keys.length} files, ${Math.round(total / 1024)} KB, in ${dir}`;
}

const plain = (rich) => (rich ?? []).map((t) => t.plain_text).join("");

/** One line for a Notion page or database: kind | title | id | link, then a page's other
 * properties in short form (selects, numbers, dates, short text). */
function notionLine(r) {
    if (r.object === "database") return `database | ${plain(r.title)} | ${r.id} | ${r.url}`;
    const props = Object.entries(r.properties ?? {});
    const title = plain(props.find(([, v]) => v.type === "title")?.[1].title);
    const short = props.map(([name, v]) => {
        const value = v.select?.name ?? v.status?.name ?? v.multi_select?.map((s) => s.name).join(", ")
            ?? (typeof v.number === "number" ? v.number : undefined) ?? v.date?.start
            ?? (v.type === "rich_text" ? plain(v.rich_text).slice(0, 80) : undefined);
        return value === undefined || value === "" ? null : `${name}: ${value}`;
    }).filter(Boolean);
    return `page | ${title} | ${r.id} | ${r.url}${short.length ? ` | ${short.join("; ")}` : ""}`;
}

/** A Notion page's content as plain text, one block per line, with child pages and databases
 * named by id so they can be read next. Goes one level down into toggles, lists and columns. */
async function notionText(id, depth = 0) {
    if (!/^[0-9a-f-]{32,36}$/i.test(id ?? "")) throw new Error(`expected a Notion page id, got ${id}`);
    const lines = [];
    let cursor;
    do {
        const page = await serviceJson("notion", `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
        for (const b of page.results) {
            const indent = "  ".repeat(depth);
            if (b.type === "child_page") lines.push(`${indent}[page] ${b.child_page.title} (${b.id})`);
            else if (b.type === "child_database") lines.push(`${indent}[database] ${b.child_database.title} (${b.id})`);
            else {
                const text = plain(b[b.type]?.rich_text);
                const mark = b.type.startsWith("heading") ? "# " : b.type === "to_do" ? (b.to_do.checked ? "[x] " : "[ ] ") : b.type.includes("list_item") ? "- " : "";
                if (text) lines.push(`${indent}${mark}${text}`);
                else if (b.type === "link_to_page") lines.push(`${indent}[link] ${b.link_to_page.page_id ?? b.link_to_page.database_id}`);
            }
            if (b.has_children && depth < 1 && !["child_page", "child_database"].includes(b.type)) lines.push(await notionText(b.id, depth + 1));
        }
        cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return lines.join("\n");
}

/** Summarizes an Atlassian Statuspage (status.sentry.io and cloudflarestatus.com both are one). */
async function statusSummary(url) {
    const response = await fetchWithTimeout(url, {}, 60_000);
    if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
    return response.json();
}

export const sourceCommands = {
    async youtrack(args, body) {
        const [method, p] = /^(GET|POST|DELETE)$/.test(args[0]) ? args : ["GET", ...args];
        if (body !== undefined) JSON.parse(body);
        const response = await callService("youtrack", apiPath(p), { method, body });
        // A DELETE answers with no body.
        const text = await response.text();
        return text ? JSON.stringify(JSON.parse(text), null, 1) : `${method} ${p}: HTTP ${response.status}`;
    },
    async attachment(args) {
        const [issueId, name] = args;
        const list = await serviceJson("youtrack", `/issues/${encodeURIComponent(issueId)}/attachments?fields=name,url,size&$top=200`);
        const attachment = list.find((a) => a.name === name);
        if (!attachment) throw new Error(`${issueId} has no attachment named ${name}`);
        const dir = path.join(process.cwd(), ".card");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, path.basename(name));
        // attachment.url starts with /youtrack/api/files/ and carries a signature that lets it load
        // without a login. With YOUTRACK in front, the doubled /youtrack would return YouTrack's web
        // app page as HTML, still with status 200.
        const url = new URL(attachment.url, YOUTRACK).href;
        const response = await check(await fetchWithTimeout(url), url.split("?")[0]);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
        return `saved ${file} (${attachment.size} bytes)`;
    },
    async "youtrack-upload"(args) {
        const [issueId, ...names] = args;
        if (!/^[A-Z]+-\d+$/.test(issueId ?? "") || names.length === 0) throw new Error("usage: youtrack-upload <issue id> <file> [<file>...]");
        const form = new FormData();
        for (const name of names) {
            const file = sendableFile(name);
            const type = UPLOAD_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
            form.append("file", new Blob([fs.readFileSync(file)], { type }), path.basename(file));
        }
        // Response serializes the form as multipart/form-data and names its boundary in the type.
        const multipart = new Response(form);
        await callService("youtrack", `/issues/${issueId}/attachments?fields=id`, {
            method: "POST", bodyBytes: new Uint8Array(await multipart.arrayBuffer()), contentType: multipart.headers.get("Content-Type"),
        });
        // YouTrack's reply names only one of several files, so list what the card now has.
        const list = await serviceJson("youtrack", `/issues/${issueId}/attachments?fields=name,size&$top=200`);
        const wanted = new Set(names.map((n) => path.basename(n)));
        return list.filter((a) => wanted.has(a.name)).map((a) => `${issueId} has ${a.name} (${a.size} bytes)`).join("\n")
            || `uploaded, but ${issueId} lists none of ${[...wanted].join(", ")}`;
    },
    async sentry(args) {
        const data = await serviceJson("sentry", apiPath(args[0]));
        // Sentry's issue objects run to kilobytes each, so a caller that truncates the output sees
        // only the first one. Print issue lists as one line per issue.
        if (Array.isArray(data) && data.every((issue) => issue.shortId)) {
            const lines = data.map((issue) => [issue.shortId, issue.status, `count ${issue.count}`, `users ${issue.userCount}`,
                `first ${issue.firstSeen}`, `last ${issue.lastSeen}`, issue.permalink, issue.title].join(" | "));
            return lines.join("\n") || "no issues";
        }
        return JSON.stringify(data, null, 1);
    },
    async "sentry-status"() {
        const summary = await statusSummary("https://status.sentry.io/api/v2/summary.json");
        const lines = [`overall: ${summary.status.description} (https://status.sentry.io/)`];
        const troubled = summary.components.filter((component) => component.status !== "operational");
        for (const component of troubled) lines.push(`component: ${component.name} | ${component.status} since ${component.updated_at}`);
        if (troubled.length === 0) lines.push("every component is operational");
        for (const incident of summary.incidents) {
            const latest = incident.incident_updates[0];
            lines.push(`incident: ${incident.name} | ${incident.status} | started ${incident.started_at} | ${incident.shortlink}`);
            if (latest) lines.push(`  latest update ${latest.created_at}: ${latest.body}`);
        }
        if (summary.incidents.length === 0) lines.push("no open incidents");
        return lines.join("\n");
    },
    async "sentry-write"(args, body) {
        const [method, p] = args;
        if (!["PUT", "POST", "DELETE"].includes(method)) throw new Error("sentry-write takes PUT, POST or DELETE");
        const data = await serviceJson("sentry", apiPath(p), { method, body }).catch((error) => {
            if (/^403 /.test(error.message)) throw new Error(`${error.message}\nThe bot's Sentry token can only read; the maintainer replaces SENTRY_BOT_TOKEN with one that has event:write.`);
            throw error;
        });
        return json(data);
    },
    async "slack-history"(args) {
        const [channel, days = "30", ...words] = args;
        if (!/^[CG][A-Z0-9]+$/.test(channel ?? "")) throw new Error("expected a Slack channel id such as C0CE75BEJTU");
        const oldest = String(Date.now() / 1000 - Number(days) * 24 * 60 * 60);
        const messages = [];
        let cursor;
        do {
            const page = await slack("conversations.history", { channel, oldest, limit: "200", ...(cursor ? { cursor } : {}) });
            messages.push(...page.messages);
            cursor = page.response_metadata?.next_cursor;
        } while (cursor && messages.length < SLACK_MAX_MESSAGES);
        const wanted = words.map((w) => w.toLowerCase());
        const kept = messages.filter((m) => wanted.every((w) => (m.text || "").toLowerCase().includes(w))).reverse();
        return json(await slackLines(kept));
    },
    async "slack-thread"(args) {
        const [channel, ts] = args;
        const messages = [];
        let cursor;
        do {
            const page = await slack("conversations.replies", { channel, ts, limit: "200", ...(cursor ? { cursor } : {}) });
            messages.push(...page.messages);
            cursor = page.response_metadata?.next_cursor;
        } while (cursor && messages.length < SLACK_MAX_MESSAGES);
        return json(await slackLines(messages));
    },
    async book(args) {
        return downloadBook(args[0]);
    },
    async community(args) {
        return json(await publicJson(`https://community.software.sil.org${apiPath(args[0])}`));
    },
    async notion(args, body) {
        const data = await serviceJson("notion", apiPath(args[0]), body === undefined ? {} : { method: "POST", body });
        // Search and query results as one line each; a page or a block list as full JSON.
        if (data.object === "list" && data.results.every((r) => r.object === "page" || r.object === "database")) {
            const lines = data.results.map(notionLine);
            if (data.has_more) lines.push(`... more: pass "start_cursor": "${data.next_cursor}"`);
            return lines.join("\n") || "no results";
        }
        return json(data);
    },
    async "notion-text"(args) {
        return json(await notionText(args[0]));
    },
    async teamcity(args) {
        // build.palaso.org lets guests read the Bloom project's builds under /guestAuth, so this
        // needs no token.
        const p = apiPath(args[0]);
        return json(await publicJson(`${TEAMCITY_URL}${p.startsWith("/guestAuth/") ? p : `/guestAuth${p}`}`));
    },
    async cloudflare(args) {
        return json(await serviceJson("cloudflare", apiPath(args[0])));
    },
    async "cloudflare-status"() {
        const summary = await statusSummary("https://www.cloudflarestatus.com/api/v2/summary.json");
        const troubled = summary.components.filter((c) => c.status !== "operational").map((c) => `component: ${c.name} | ${c.status}`);
        const incidents = summary.incidents.map((i) => `incident: ${i.name} | ${i.status} | started ${i.started_at} | ${i.shortlink}`);
        return [`overall: ${summary.status.description}`, ...troubled, ...incidents].join("\n");
    },
    async mixpanel(args) {
        const [project, rawPath] = args;
        if (!/^\d+$/.test(project ?? "")) throw new Error("usage: mixpanel <project id> <api path>; mixpanel-projects lists the project ids");
        const p = apiPath(rawPath);
        return json(await serviceJson("mixpanel", `/query${p}${p.includes("?") ? "&" : "?"}project_id=${project}`));
    },
    async "mixpanel-projects"() {
        const me = await serviceJson("mixpanel", "/app/me");
        const projects = Object.entries(me.results?.projects ?? {});
        return projects.map(([id, p]) => `${id} | ${p.name} | ${p.domain ?? ""}`).join("\n") || "the service account sees no projects";
    },
};
