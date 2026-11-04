// More of what bot-tools.mjs gives the bot's Claude runs: Slack history, Bloom Library books, the
// community forum, Notion, TeamCity, Cloudflare, Mixpanel, writes to Sentry, and comments on
// GitHub. bot-tools.mjs runs these by name; each takes the command's arguments and the tokens
// from the bot's env file, and returns the text to print. Everything here only reads, except
// `sentry-write` and `github-comment`.
//
//   slack-history <channel id> [days] [words...]   a Slack channel's messages over the last days
//                                                   (30 by default), only those with every word
//   slack-thread <channel id> <message ts>          one Slack thread
//   book <Bloom Library link or book id>            saves a public book's files under ./.book/<title>/
//   community <path>                                a GET on the community forum's JSON
//                                                   (https://community.software.sil.org), e.g.
//                                                   /c/bloom/5.json, /t/<topic id>.json, /search.json?q=...
//   notion <api path> [@<file>]                     a GET on Notion's API, or a POST to /search or
//                                                   /databases/<id>/query with a JSON body file
//   teamcity <api path>                             a GET on TeamCity's REST API, e.g. /app/rest/builds?locator=...
//   cloudflare <api path>                           a GET on Cloudflare's API (/zones, ...)
//   cloudflare-status                               what https://www.cloudflarestatus.com/ reports now
//   mixpanel <api path>                             a GET on Mixpanel's Query API, e.g. /events?event=[...]&...
//   sentry-write <PUT|POST|DELETE> <api path> [@<file>]
//                                                   changes Sentry: resolve, ignore or link an issue
//   github-comment <repo> <issue or PR number> @<file>
//                                                   comments on a BloomBooks issue or PR; the text must
//                                                   start with the attribution line

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SLACK_MAX_MESSAGES = 1000;
const BOOK_MAX_BYTES = 300 * 1024 * 1024;
const MAX_PRINT_CHARS = 40_000;
const PARSE = "https://server.bloomlibrary.org/parse";
// Bloom Library's public Parse application id, the one its website sends (BloomLibrary2's
// ParseConnectionConfig.ts). It reads only what anyone may read.
const PARSE_APP_ID = "R6qNTeumQXjJCMutAJYAwPtip1qBulkFyLefkCE5";
const TEAMCITY_URL = "https://build.palaso.org";
const NOTION_VERSION = "2022-06-28";

/** Sends a request and returns the parsed JSON (or text), failing loudly on a non-2xx status. A
 * timeout or a 5xx says that the service is down. */
async function request(url, { method = "GET", headers = {}, body } = {}) {
    const host = new URL(url).host;
    let response;
    try {
        response = await fetch(url, { method, body, signal: AbortSignal.timeout(120_000), headers: { Accept: "application/json", ...headers } });
    } catch (error) {
        if (error.name === "TimeoutError") throw new Error(`${host} is down: no reply within 120 s to ${url}`);
        throw error;
    }
    if (response.status >= 500) throw new Error(`${host} is down: HTTP ${response.status} (a server error on their side) from ${url}`);
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} from ${url}: ${text.slice(0, 500)}`);
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** Throws a clear message when a token the command needs is not in the env file yet. */
function need(tokens, name, what) {
    if (!tokens[name]) throw new Error(`${name} is not in ~/.config/bloom-bot/env yet, so the bot has no ${what} access. The maintainer adds it there.`);
    return tokens[name];
}

/** Rejects anything but an API path, so a caller can't point a token at another host. */
function apiPath(p) {
    if (!p || !p.startsWith("/") || p.startsWith("//")) throw new Error(`expected an API path starting with /, got ${p}`);
    return p;
}

/** Reads a JSON request body from "@<file>" inside the working directory, so a command can't be
 * used to send one of the bot's own files somewhere. */
export function bodyFile(arg) {
    if (arg === undefined) return undefined;
    if (!arg.startsWith("@")) throw new Error(`expected the body as @<file>, got ${arg.slice(0, 80)}`);
    const file = fs.realpathSync(path.resolve(arg.slice(1)));
    const root = fs.realpathSync(process.cwd());
    if (!file.startsWith(root + path.sep)) throw new Error(`the body file must be inside ${root}, not ${file}`);
    return fs.readFileSync(file, "utf8");
}

const json = (data) => {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
    return text.length > MAX_PRINT_CHARS ? `${text.slice(0, MAX_PRINT_CHARS)}\n... cut at ${MAX_PRINT_CHARS} characters; ask for less` : text;
};

async function slack(tokens, method, params) {
    const data = await request(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${need(tokens, "SLACK_BOT_TOKEN", "Slack")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
    });
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}${data.error === "not_in_channel" ? " (the bot must be added to that channel)" : ""}`);
    return data;
}

/** Renders Slack messages as "time | who | text" lines, naming each person once looked up. */
async function slackLines(tokens, messages) {
    const names = new Map();
    const lines = [];
    for (const m of messages) {
        let who = m.bot_profile?.name || m.username || "a bot";
        if (m.user) {
            if (!names.has(m.user)) {
                const { user } = await slack(tokens, "users.info", { user: m.user });
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
    const book = await request(`${PARSE}/classes/books/${id}?keys=title,baseUrl,inCirculation,harvestState,uploader`,
        { headers: { "X-Parse-Application-Id": PARSE_APP_ID } });
    const match = /^https:\/\/s3\.amazonaws\.com\/([^/]+)\/(.+)$/.exec(book.baseUrl ?? "");
    if (!match) throw new Error(`book ${id} has no files on S3 (baseUrl ${book.baseUrl})`);
    const [, bucket, encodedPrefix] = match;
    const prefix = decodeURIComponent(encodedPrefix.replace(/\+/g, " "));
    const listing = await request(`https://s3.amazonaws.com/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`);
    const keys = [...String(listing).matchAll(/<Key>([^<]+)<\/Key>\s*<LastModified>[^<]*<\/LastModified>\s*<ETag>[^<]*<\/ETag>\s*<Size>(\d+)<\/Size>/g)]
        .map(([, key, size]) => ({ key: key.replace(/&amp;/g, "&"), size: Number(size) }));
    const total = keys.reduce((sum, k) => sum + k.size, 0);
    if (total > BOOK_MAX_BYTES) throw new Error(`book ${id} is ${Math.round(total / 1024 / 1024)} MB, over the ${BOOK_MAX_BYTES / 1024 / 1024} MB the bot's Mac can spare`);
    const dir = path.join(process.cwd(), ".book", (book.title || id).replace(/[^\w .-]+/g, "_"));
    for (const { key } of keys) {
        const relative = key.slice(prefix.length);
        if (!relative || relative.includes("..")) continue;
        const file = path.join(dir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const response = await fetch(`https://s3.amazonaws.com/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`${response.status} downloading ${key}`);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return `${book.title} (${book.inCirculation === false ? "not in circulation" : "in circulation"}, harvest ${book.harvestState}): ${keys.length} files, ${Math.round(total / 1024)} KB, in ${dir}`;
}

export const sourceCommands = {
    async "slack-history"(args, tokens) {
        const [channel, days = "30", ...words] = args;
        if (!/^[CG][A-Z0-9]+$/.test(channel ?? "")) throw new Error("expected a Slack channel id such as C0CE75BEJTU");
        const oldest = String(Date.now() / 1000 - Number(days) * 24 * 60 * 60);
        const messages = [];
        let cursor;
        do {
            const page = await slack(tokens, "conversations.history", { channel, oldest, limit: "200", ...(cursor ? { cursor } : {}) });
            messages.push(...page.messages);
            cursor = page.response_metadata?.next_cursor;
        } while (cursor && messages.length < SLACK_MAX_MESSAGES);
        const wanted = words.map((w) => w.toLowerCase());
        const kept = messages.filter((m) => wanted.every((w) => (m.text || "").toLowerCase().includes(w))).reverse();
        return json(await slackLines(tokens, kept));
    },
    async "slack-thread"(args, tokens) {
        const [channel, ts] = args;
        const { messages } = await slack(tokens, "conversations.replies", { channel, ts, limit: "200" });
        return json(await slackLines(tokens, messages));
    },
    async book(args) {
        return downloadBook(args[0]);
    },
    async community(args) {
        return json(await request(`https://community.software.sil.org${apiPath(args[0])}`));
    },
    async notion(args, tokens) {
        const p = apiPath(args[0]);
        const body = bodyFile(args[1]);
        // Searching and querying a database are POSTs but change nothing; no other POST is allowed.
        if (body !== undefined && !/^\/(search|databases\/[\w-]+\/query)$/.test(p)) throw new Error("notion only reads: a body is allowed only for /search and /databases/<id>/query");
        return json(await request(`https://api.notion.com/v1${p}`, {
            method: body === undefined ? "GET" : "POST",
            body,
            headers: { Authorization: `Bearer ${need(tokens, "NOTION_TOKEN", "Notion")}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        }));
    },
    async teamcity(args, tokens) {
        const headers = tokens.TEAMCITY_TOKEN ? { Authorization: `Bearer ${tokens.TEAMCITY_TOKEN}` } : {};
        return json(await request(`${tokens.TEAMCITY_URL || TEAMCITY_URL}${apiPath(args[0])}`, { headers }));
    },
    async cloudflare(args, tokens) {
        return json(await request(`https://api.cloudflare.com/client/v4${apiPath(args[0])}`,
            { headers: { Authorization: `Bearer ${need(tokens, "CLOUDFLARE_API_TOKEN", "Cloudflare")}` } }));
    },
    async "cloudflare-status"() {
        const summary = await request("https://www.cloudflarestatus.com/api/v2/summary.json");
        const troubled = summary.components.filter((c) => c.status !== "operational").map((c) => `component: ${c.name} | ${c.status}`);
        const incidents = summary.incidents.map((i) => `incident: ${i.name} | ${i.status} | started ${i.started_at} | ${i.shortlink}`);
        return [`overall: ${summary.status.description}`, ...troubled, ...incidents].join("\n");
    },
    async mixpanel(args, tokens) {
        const p = apiPath(args[0]);
        const auth = Buffer.from(need(tokens, "MIXPANEL_SERVICE_ACCOUNT", "Mixpanel")).toString("base64");
        const project = need(tokens, "MIXPANEL_PROJECT_ID", "Mixpanel");
        return json(await request(`https://mixpanel.com/api/query${p}${p.includes("?") ? "&" : "?"}project_id=${project}`,
            { headers: { Authorization: `Basic ${auth}` } }));
    },
    async "sentry-write"(args, tokens) {
        const [method, p, bodyArg] = args;
        if (!["PUT", "POST", "DELETE"].includes(method)) throw new Error("sentry-write takes PUT, POST or DELETE");
        return json(await request(`https://sentry.io/api/0${apiPath(p)}`, {
            method,
            body: bodyFile(bodyArg),
            headers: { Authorization: `Bearer ${need(tokens, "SENTRY_BOT_TOKEN", "Sentry")}`, "Content-Type": "application/json" },
        }).catch((error) => {
            if (/^403 /.test(error.message)) throw new Error(`${error.message}\nThe bot's Sentry token can only read; the maintainer replaces SENTRY_BOT_TOKEN with one that has event:write.`);
            throw error;
        }));
    },
    async "github-comment"(args) {
        const [repo, number, bodyArg] = args;
        if (!/^[\w.-]+$/.test(repo ?? "") || !/^\d+$/.test(number ?? "")) throw new Error("usage: github-comment <repo> <number> @<file>");
        const body = bodyFile(bodyArg);
        if (!body?.trimStart().startsWith("[")) throw new Error("the comment must start with the attribution line the job gave you");
        const url = execFileSync("gh", ["api", `repos/BloomBooks/${repo}/issues/${number}/comments`, "-f", `body=${body}`, "--jq", ".html_url"], { encoding: "utf8" });
        return `posted ${url.trim()}`;
    },
};
