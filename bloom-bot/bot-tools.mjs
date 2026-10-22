// Read-only access to YouTrack, Sentry and the BloomBooks GitHub repos for the bot's Claude runs.
// Claude can run this script but cannot read the tokens it uses: they come from ~/.config, which
// bot-runtime denies to Claude's file tools, and they are not in Claude's environment. Every call
// is a GET or a clone/fetch, so nothing here can change any of those services.
//
//   node bot-tools.mjs youtrack <api path>             e.g. /issues?query=...&fields=idReadable,summary
//   node bot-tools.mjs attachment <issue id> <name>    saves the attachment to ./.card/<name>
//   node bot-tools.mjs sentry <api path>               e.g. /organizations/bloom-app/issues/?query=...
//   node bot-tools.mjs repos                           lists the BloomBooks repos
//   node bot-tools.mjs checkout <repo>                 puts a worktree of a BloomBooks repo at ./<repo>

import { execFileSync } from "node:child_process";
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
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${response.status} from ${url}: ${(await response.text()).slice(0, 500)}`);
    return response;
}

/** Lists the BloomBooks repos, caching the list for a day since it rarely changes. */
function listRepos() {
    const cache = path.join(os.homedir(), "bloom-bot", "repos.json");
    if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 24 * 60 * 60 * 1000) {
        return JSON.parse(fs.readFileSync(cache, "utf8"));
    }
    const json = execFileSync("gh", ["repo", "list", "BloomBooks", "--limit", "1000",
        "--json", "name,description,isPrivate,isArchived,defaultBranchRef"], { encoding: "utf8" });
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, json);
    return JSON.parse(json);
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
            const data = await response.json();
            // Sentry's issue objects run to kilobytes each, so a caller that truncates the output
            // sees only the first one. Print issue lists as one line per issue.
            if (Array.isArray(data) && data.every((issue) => issue.shortId)) {
                for (const issue of data) {
                    console.log([issue.shortId, issue.status, `count ${issue.count}`, `users ${issue.userCount}`,
                        `first ${issue.firstSeen}`, `last ${issue.lastSeen}`, issue.permalink, issue.title].join(" | "));
                }
                if (data.length === 0) console.log("no issues");
            } else {
                console.log(JSON.stringify(data, null, 1));
            }
            break;
        }
        case "repos": {
            for (const repo of listRepos()) {
                console.log(`${repo.name}${repo.isPrivate ? " (private)" : ""}${repo.isArchived ? " (archived)" : ""} | ${repo.description ?? ""}`);
            }
            break;
        }
        case "checkout": {
            const name = args[0];
            const repo = listRepos().find((r) => r.name === name);
            if (!repo) throw new Error(`BloomBooks has no repo named ${name}; run \`repos\` for the list`);
            const target = path.join(process.cwd(), name);
            if (fs.existsSync(target)) {
                console.log(`${target} is already here`);
                break;
            }
            const clone = path.join(os.homedir(), "dev", "repos", name);
            if (!fs.existsSync(clone)) {
                fs.mkdirSync(path.dirname(clone), { recursive: true });
                execFileSync("gh", ["repo", "clone", `BloomBooks/${name}`, clone, "--", "-q", "--filter=blob:none"], { stdio: "inherit" });
                // The bot only reads; leave it no way to push even if a git command slips through.
                execFileSync("git", ["-C", clone, "remote", "set-url", "--push", "origin", "no-push: the bot reads only"]);
            }
            execFileSync("git", ["-C", clone, "fetch", "-q", "--prune", "origin"]);
            execFileSync("git", ["-C", clone, "worktree", "prune"]);
            execFileSync("git", ["-C", clone, "worktree", "add", "-q", "--detach", target, `origin/${repo.defaultBranchRef.name}`]);
            console.log(`${target}: ${name} at origin/${repo.defaultBranchRef.name}`);
            break;
        }
        default:
            throw new Error("usage: bot-tools.mjs youtrack <path> | attachment <issue> <name> | sentry <path> | repos | checkout <repo>");
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
