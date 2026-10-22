// Read-only access to YouTrack and Sentry for the Claude runs that poll-youtrack.mjs starts.
// Claude can run this script but cannot read the tokens it uses: they come from
// ~/.config/bloom-bot/env, which the poller denies to Claude's file tools, and they are not in
// Claude's environment. Every call is a GET, so nothing here can change either service.
//
//   node bot-tools.mjs youtrack <api path>             e.g. /issues?query=...&fields=idReadable,summary
//   node bot-tools.mjs attachment <issue id> <name>    saves the attachment to ./.card/<name>
//   node bot-tools.mjs sentry <api path>               e.g. /organizations/bloom-app/issues/?query=...

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const YOUTRACK = "https://issues.bloomlibrary.org/youtrack";
const SENTRY = "https://sentry.io/api/0";

/** Reads KEY=value lines (with or without "export") from the bot's env file. */
function readTokens() {
    const file = path.join(os.homedir(), ".config", "bloom-bot", "env");
    const tokens = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = line.match(/^(?:export\s+)?(\w+)=(.*)$/);
        if (match) tokens[match[1]] = match[2].trim();
    }
    return tokens;
}

/** GETs a URL with a bearer token and fails loudly on any non-2xx status. */
async function get(url, token) {
    const response = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${response.status} from ${url}: ${(await response.text()).slice(0, 500)}`);
    return response;
}

/** Rejects anything but an API path, so a caller can't point the token at another host. */
function apiPath(p) {
    if (!p || !p.startsWith("/") || p.startsWith("//")) throw new Error(`expected an API path starting with /, got ${p}`);
    return p;
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    const tokens = readTokens();
    switch (command) {
        case "youtrack": {
            const response = await get(`${YOUTRACK}/api${apiPath(args[0])}`, tokens.YOUTRACK_BOT);
            console.log(JSON.stringify(await response.json(), null, 1));
            break;
        }
        case "attachment": {
            const [issueId, name] = args;
            const list = await (await get(`${YOUTRACK}/api/issues/${encodeURIComponent(issueId)}/attachments?fields=name,url,size&$top=200`, tokens.YOUTRACK_BOT)).json();
            const attachment = list.find((a) => a.name === name);
            if (!attachment) throw new Error(`${issueId} has no attachment named ${name}`);
            const dir = path.join(process.cwd(), ".card");
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, path.basename(name));
            fs.writeFileSync(file, Buffer.from(await (await get(`${YOUTRACK}${attachment.url}`, tokens.YOUTRACK_BOT)).arrayBuffer()));
            console.log(`saved ${file} (${attachment.size} bytes)`);
            break;
        }
        case "sentry": {
            if (!tokens.SENTRY_BOT_TOKEN) throw new Error("SENTRY_BOT_TOKEN is not in ~/.config/bloom-bot/env yet");
            const response = await get(`${SENTRY}${apiPath(args[0])}`, tokens.SENTRY_BOT_TOKEN);
            console.log(JSON.stringify(await response.json(), null, 1));
            break;
        }
        default:
            throw new Error("usage: bot-tools.mjs youtrack <path> | attachment <issue> <name> | sentry <path>");
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
