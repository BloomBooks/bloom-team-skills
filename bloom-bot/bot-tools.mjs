// Access to YouTrack, Sentry, the BloomBooks GitHub repos and more for the bot's Claude runs.
// Claude can run this script but cannot read the tokens it uses: they come from ~/.config, which
// bot-runtime denies to Claude's file tools, and they are not in Claude's environment. It can
// change YouTrack (any request the Bot account may make), Sentry issues and GitHub comments; the
// rest only reads.
//
//   node bot-tools.mjs youtrack <api path>             a GET, e.g. /issues?query=...&fields=idReadable,summary
//   node bot-tools.mjs youtrack <method> <api path> [@<file>]
//                                                      POST or DELETE, with the JSON body read from a
//                                                      file under the working directory
//   node bot-tools.mjs attachment <issue id> <name>    saves the attachment to ./.card/<name>
//   node bot-tools.mjs sentry <api path>               e.g. /organizations/bloom-app/issues/?query=...
//   node bot-tools.mjs sentry-status                   what https://status.sentry.io/ reports now
//   node bot-tools.mjs repos                           lists the BloomBooks repos
//   node bot-tools.mjs checkout <repo>                 puts a worktree of a BloomBooks repo at ./<repo>
//   node bot-tools.mjs nightly-runs                    lists BloomDesktop's recent nightly.yml runs
//   node bot-tools.mjs run <run id>                    a BloomDesktop run's jobs and failed steps
//   node bot-tools.mjs run-log <run id>                saves the failed steps' log to ./.nightly/ and
//                                                      prints the parts that say what failed
//   node bot-tools.mjs run-artifact <run id> <name>    saves a run's artifact to ./.nightly/<run id>/<name>,
//                                                      with each trace.zip in it unzipped
//   node bot-tools.mjs pr <number>                     a BloomDesktop PR's state, title and merge date
//
// bot-sources.mjs adds more: Slack history, Bloom Library books, the community forum, Notion,
// TeamCity, Cloudflare, Mixpanel, Sentry writes and GitHub comments.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceCommands } from "./bot-sources.mjs";

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

/**
 * Sends a request (a GET unless `method` says otherwise) with a bearer token and fails loudly on
 * any non-2xx status. A timeout or a 5xx says that the service is down, so the caller doesn't take
 * it for a problem with its request.
 */
async function get(url, token, method = "GET", body = undefined) {
    const host = new URL(url).host;
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
        response = await fetch(url, { method, body, signal: AbortSignal.timeout(120_000), headers });
    } catch (error) {
        if (error.name === "TimeoutError") throw new Error(`${host} is down: no reply within 120 s to ${url}`);
        throw error;
    }
    if (response.status >= 500) {
        throw new Error(`${host} is down: HTTP ${response.status} (a server error on their side) from ${url}`);
    }
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

const BLOOM_DESKTOP = "BloomBooks/BloomDesktop";
// An artifact bigger than this would crowd the bot's Mac, whose disk is nearly full.
const MAX_ARTIFACT_BYTES = 300 * 1024 * 1024;
// About what a Claude run can take in at once from one command.
const MAX_LOG_PRINT_CHARS = 25_000;

/** Runs gh with the bot Mac's GitHub login and returns its stdout. */
function gh(args) {
    return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

/** Rejects anything but a run id, so it can't be taken for another gh argument. */
function runId(id) {
    if (!/^\d+$/.test(id ?? "")) throw new Error(`expected a numeric run id, got ${id}`);
    return id;
}

/**
 * Saves the failed steps' log of a run to ./.nightly/<id>.log and returns the lines that say what
 * failed: Playwright's numbered failures with the 40 lines after each, C# "Failed" lines, and the
 * "##[error]" lines. The [WebServer] lines from the component tests are dropped as noise.
 */
function failedLog(id) {
    const dir = path.join(process.cwd(), ".nightly");
    fs.mkdirSync(dir, { recursive: true });
    // Asked for the whole run, gh gives up on the run's summary check jobs, which have no steps and
    // no log ("log not found"). So ask for each failed job that has steps.
    const { jobs } = JSON.parse(gh(["run", "view", id, "--repo", BLOOM_DESKTOP, "--json", "jobs"]));
    const raw = jobs.filter((job) => job.conclusion === "failure" && job.steps.length > 0)
        .map((job) => gh(["run", "view", "--job", String(job.databaseId), "--repo", BLOOM_DESKTOP, "--log-failed"]))
        .join("\n");
    // gh prints "job<TAB>step<TAB>timestamp text"; keep the job and step once, then the text.
    const lines = raw.split(/\r?\n/)
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length >= 3)
        // Drops the timestamp and the terminal colour codes, which Playwright's output on the runner
        // carries both as escape characters and spelled out as the text "^[[2m".
        .map(([job, step, ...rest]) => ({
            where: `${job} / ${step}`,
            text: rest.join("\t").replace(/^\S+Z /, "").replace(/(\x1b|\^\[)\[[0-9;]*m/g, ""),
        }))
        .filter((line) => !line.text.includes("[WebServer]"));
    const file = path.join(dir, `${id}.log`);
    fs.writeFileSync(file, lines.map((line) => `${line.where}\t${line.text}`).join("\n"));
    const keep = new Set();
    lines.forEach((line, i) => {
        if (/^\s+\d+\) /.test(line.text)) {
            for (let j = i; j < Math.min(i + 41, lines.length); j++) keep.add(j);
        } else if (/^\s*Failed /.test(line.text) || line.text.includes("##[error]")) {
            keep.add(i);
        }
    });
    const out = [`full log (${lines.length} lines): ${file}`];
    let where = "";
    let previous = -2;
    for (const i of [...keep].sort((a, b) => a - b)) {
        if (lines[i].where !== where) {
            where = lines[i].where;
            out.push(`--- ${where}`);
        } else if (i !== previous + 1) {
            out.push("...");
        }
        out.push(lines[i].text);
        previous = i;
    }
    if (keep.size === 0) out.push("no Playwright, C# or ##[error] failure lines; read the full log");
    let text = out.join("\n");
    if (text.length > MAX_LOG_PRINT_CHARS) {
        text = `${text.slice(0, MAX_LOG_PRINT_CHARS)}\n... cut at ${MAX_LOG_PRINT_CHARS} characters; Grep the full log for the rest`;
    }
    return text;
}

/** Saves one artifact of a run under ./.nightly/<id>/<name>, unzips each Playwright trace in it
 * (a zip holding test.trace, whatever its name) into a folder beside it named <zip>-trace, and
 * lists the files, leaving out the test collections and the report viewer's own files. */
function downloadArtifact(id, name) {
    const artifacts = JSON.parse(gh(["api", `repos/${BLOOM_DESKTOP}/actions/runs/${id}/artifacts`])).artifacts;
    const artifact = artifacts.find((a) => a.name === name);
    if (!artifact) throw new Error(`run ${id} has no artifact named ${name}; it has: ${artifacts.map((a) => a.name).join(", ")}`);
    if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
        throw new Error(`${name} is ${Math.round(artifact.size_in_bytes / 1024 / 1024)} MB, over the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB the bot's Mac can spare`);
    }
    const dir = path.join(process.cwd(), ".nightly", id, path.basename(name));
    fs.rmSync(dir, { recursive: true, force: true });
    gh(["run", "download", id, "--repo", BLOOM_DESKTOP, "--name", name, "--dir", dir]);
    for (const zip of fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".zip"))) {
        const zipPath = path.join(dir, zip);
        if (!execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").includes("test.trace")) continue;
        execFileSync("unzip", ["-q", "-o", zipPath, "-d", `${zipPath.slice(0, -4)}-trace`]);
    }
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
        // A trace's resources folder holds hundreds of snapshots and sources by hash; the trace
        // files beside it name the ones that matter.
        .filter((f) => !f.split(path.sep).some((part) => part === "collection" || part === "resources"))
        .filter((f) => !f.startsWith(path.join("playwright-report", "trace")));
    return `${dir}\n${files.join("\n")}`;
}

/** Rejects anything but an API path, so a caller can't point the token at another host. */
function apiPath(p) {
    if (!p || !p.startsWith("/") || p.startsWith("//")) throw new Error(`expected an API path starting with /, got ${p}`);
    return p;
}

/** Reads a request body from "@<file>". The file must be inside the working directory, so the
 * helper can't be used to send one of the bot's own files, such as its tokens, to YouTrack. */
function requestBody(arg) {
    if (arg === undefined) return undefined;
    if (!arg.startsWith("@")) throw new Error(`expected the body as @<file>, got ${arg.slice(0, 80)}`);
    const file = fs.realpathSync(path.resolve(arg.slice(1)));
    const root = fs.realpathSync(process.cwd());
    if (!file.startsWith(root + path.sep)) throw new Error(`the body file must be inside ${root}, not ${file}`);
    const body = fs.readFileSync(file, "utf8");
    JSON.parse(body);
    return body;
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    const tokens = readTokens();
    switch (command) {
        case "youtrack": {
            const [method, p, bodyArg] = /^(GET|POST|DELETE)$/.test(args[0]) ? args : ["GET", ...args];
            const response = await get(`${YOUTRACK}/api${apiPath(p)}`, tokens.YOUTRACK_BOT, method, requestBody(bodyArg));
            // A DELETE answers with no body.
            const text = await response.text();
            console.log(text ? JSON.stringify(JSON.parse(text), null, 1) : `${method} ${p}: HTTP ${response.status}`);
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
        case "sentry-status": {
            // status.sentry.io is a public Atlassian Statuspage; its summary needs no token.
            const response = await fetch("https://status.sentry.io/api/v2/summary.json", { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`status.sentry.io answered HTTP ${response.status}`);
            const summary = await response.json();
            console.log(`overall: ${summary.status.description} (https://status.sentry.io/)`);
            const troubled = summary.components.filter((component) => component.status !== "operational");
            for (const component of troubled) console.log(`component: ${component.name} | ${component.status} since ${component.updated_at}`);
            if (troubled.length === 0) console.log("every component is operational");
            for (const incident of summary.incidents) {
                const latest = incident.incident_updates[0];
                console.log(`incident: ${incident.name} | ${incident.status} | started ${incident.started_at} | ${incident.shortlink}`);
                if (latest) console.log(`  latest update ${latest.created_at}: ${latest.body}`);
            }
            if (summary.incidents.length === 0) console.log("no open incidents");
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
        case "nightly-runs": {
            const runs = JSON.parse(gh(["run", "list", "--repo", BLOOM_DESKTOP, "--workflow", "nightly.yml", "--limit", "15",
                "--json", "databaseId,createdAt,event,headBranch,headSha,status,conclusion,url"]));
            for (const r of runs) {
                console.log([r.databaseId, r.createdAt, r.event, r.headBranch, r.headSha.slice(0, 10), r.status, r.conclusion || "-", r.url].join(" | "));
            }
            break;
        }
        case "run": {
            const { jobs } = JSON.parse(gh(["run", "view", runId(args[0]), "--repo", BLOOM_DESKTOP, "--json", "jobs"]));
            for (const job of jobs) {
                const failed = job.steps.filter((s) => s.conclusion === "failure").map((s) => s.name);
                console.log(`${job.name} | ${job.conclusion}${failed.length ? ` | failed steps: ${failed.join(", ")}` : ""}`);
            }
            break;
        }
        case "run-log":
            console.log(failedLog(runId(args[0])));
            break;
        case "run-artifact":
            console.log(downloadArtifact(runId(args[0]), args[1]));
            break;
        case "pr": {
            if (!/^\d+$/.test(args[0] ?? "")) throw new Error(`expected a PR number, got ${args[0]}`);
            const pr = JSON.parse(gh(["pr", "view", args[0], "--repo", BLOOM_DESKTOP, "--json", "number,title,state,mergedAt,closedAt,url"]));
            const when = pr.mergedAt ? `merged ${pr.mergedAt}` : `closed ${pr.closedAt ?? "-"}`;
            console.log([`#${pr.number}`, pr.state, when, pr.url, pr.title].join(" | "));
            break;
        }
        default:
            if (sourceCommands[command]) {
                console.log(await sourceCommands[command](args, tokens));
                break;
            }
            throw new Error(`usage: bot-tools.mjs youtrack [POST|DELETE] <path> [@<file>] | attachment <issue> <name> | sentry <path> | sentry-status | repos | checkout <repo> | nightly-runs | run <id> | run-log <id> | run-artifact <id> <name> | pr <number> | ${Object.keys(sourceCommands).join(" | ")} (see bot-sources.mjs)`);
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
