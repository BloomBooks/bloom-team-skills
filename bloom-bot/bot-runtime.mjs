// What every Bloom bot job on the bot's Mac shares: logging, telling the developers on Zulip,
// the lock that keeps a job from overlapping itself, BloomDesktop worktrees, and Claude runs
// that can change nothing but YouTrack and the files a job allows. A job (poll-youtrack.mjs, ...) is a small script that calls runJob() with its own work.
//
// Secrets live in ~/.config/bloom-bot/env (loaded by the login zsh that launchd starts) and
// ~/.zuliprc. Claude runs never see either: runClaude() strips the tokens from its environment
// and denies its file tools those paths.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// BLOOM_BOT_TEAM_SKILLS points a test at a copy of bloom-team-skills holding unpushed changes.
export const TEAM_SKILLS = process.env.BLOOM_BOT_TEAM_SKILLS ?? path.join(os.homedir(), "dev", "bloom-team-skills");
export const BOT_DIR = path.join(TEAM_SKILLS, "bloom-bot");
export const BOT_TOOLS = path.join(BOT_DIR, "bot-tools.mjs");
export const HOME_DIR = path.join(os.homedir(), "bloom-bot");
const WORK_DIR = path.join(HOME_DIR, "work");
const STATUS_DIR = path.join(HOME_DIR, "status");
const ZULIPRC = path.join(os.homedir(), ".zuliprc");
const BOT_GUIDE = path.join(BOT_DIR, "BOT.md");

export const MODEL = "claude-opus-5-5";
export const MODEL_NAME = "Claude Opus 5.5";
const EFFORT = "low";
export const CLAUDE_TIMEOUT_MINUTES = 15;

const ZULIP_CHANNEL = "bot testing";
const ZULIP_TOPIC = "Bloom bot";
// The Slack channel for the same notes, by id. The bot must be a member of it.
const SLACK_STATUS_CHANNEL_ID = "C0CEMAU8EBW";
const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Logs a line with a timestamp; launchd sends stdout to the job's log file. */
export function log(message) {
    console.log(`${new Date().toISOString()} ${message}`);
}

/** Reads the Zulip bot's credentials from ~/.zuliprc, or returns null if there is none yet. */
function readZuliprc() {
    if (!fs.existsSync(ZULIPRC)) return null;
    const values = {};
    for (const line of fs.readFileSync(ZULIPRC, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
        if (match) values[match[1]] = match[2];
    }
    return values;
}

/** Tells the bot's maintainers: posts to the bot's Zulip topic and to its Slack status channel.
 * With `kind`, posts at most once a day per kind, so a problem that recurs every run (an expired
 * token) sends one message, not hundreds. Never throws: failing to notify must not stop a job. */
export async function notify(message, kind) {
    let state;
    let stateFile;
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        stateFile = path.join(HOME_DIR, "notified.json");
        state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
        if (kind && Date.now() - (state[kind] ?? 0) < NOTIFY_INTERVAL_MS) return;
    } catch (error) {
        log(`notify failed: ${error.message}`);
        return;
    }
    // Each place is tried even if the other fails.
    let sent = false;
    try {
        const zulip = readZuliprc();
        if (!zulip) throw new Error("no ~/.zuliprc");
        await postToZulip(ZULIP_CHANNEL, ZULIP_TOPIC, message);
        sent = true;
    } catch (error) {
        log(`notify to Zulip failed: ${error.message}`);
    }
    try {
        await postToSlack(SLACK_STATUS_CHANNEL_ID, message);
        sent = true;
    } catch (error) {
        log(`notify to Slack failed: ${error.message}`);
    }
    if (!sent) log(`not notified anywhere: ${message}`);
    if (sent && kind) {
        state[kind] = Date.now();
        fs.writeFileSync(stateFile, JSON.stringify(state));
    }
}

/** Posts a message to a Zulip channel and topic as the bot, and throws if Zulip refuses it. */
export async function postToZulip(channel, topic, content) {
    const zulip = zulipCredentials();
    const response = await fetch(`${zulip.site}/api/v1/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Basic ${Buffer.from(`${zulip.email}:${zulip.key}`).toString("base64")}` },
        body: new URLSearchParams({ type: "stream", to: channel, topic, content }),
    });
    if (!response.ok) throw new Error(`Zulip ${response.status}: ${await response.text()}`);
}

/** Calls a Slack Web API method as the bot (SLACK_BOT_TOKEN) and returns its reply, throwing when
 * Slack says it failed. Slack answers HTTP 200 even then, with `ok: false` and an `error`. */
export async function slack(method, params) {
    if (!process.env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not in ~/.config/bloom-bot/env");
    const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        // Form-encoded, which every Slack method takes (not all take JSON). A value that is an
        // object or array (blocks) goes as a JSON string, as Slack expects.
        body: new URLSearchParams(Object.entries(params).map(([key, value]) =>
            [key, typeof value === "object" ? JSON.stringify(value) : String(value)])),
    });
    const reply = await response.json();
    if (!reply.ok) throw new Error(`Slack ${method}: ${reply.error}`);
    return reply;
}

/** Posts Markdown (the same text a Zulip post takes) to a Slack channel. A `markdown` block renders
 * ordinary Markdown links, bold and lists; `text` is what notifications show. Link previews are
 * off, as they would dwarf a short post. */
export async function postToSlack(channel, markdown) {
    return slack("chat.postMessage", {
        channel,
        text: markdown,
        blocks: [{ type: "markdown", text: markdown }],
        unfurl_links: false,
        unfurl_media: false,
    });
}

/** Takes the job's lock file, or returns false if another run of the job is still going. */
function takeLock(lock) {
    try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
        return true;
    } catch {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        try {
            process.kill(pid, 0);
            return false;
        } catch {
            fs.writeFileSync(lock, String(process.pid));
            return true;
        }
    }
}

/** Reads the Zulip bot's credentials, failing if ~/.zuliprc is missing. */
export function zulipCredentials() {
    const zulip = readZuliprc();
    if (!zulip) throw new Error("~/.zuliprc is missing");
    return zulip;
}

// The bloom-bot/ tree this process loaded its code from. Several jobs pull the same clone, so a
// change may arrive through another job's pull; comparing with this, rather than with the tree
// before this process's own pull, tells a long-running job that its loaded code is out of date.
const STARTED_ON_TREE = execFileSync("git", ["-C", TEAM_SKILLS, "rev-parse", "HEAD:bloom-bot"], { encoding: "utf8" });

/** Fast-forwards bloom-team-skills and returns true if bloom-bot/ now differs from the code this
 * process started on. */
export function pullTeamSkills() {
    // Every job pulls, and two at once in one clone corrupt each other's FETCH_HEAD ("Cannot
    // fast-forward to multiple branches"). So take a lock, and fetch and merge one named branch.
    const lock = path.join(HOME_DIR, "pull.lock");
    fs.mkdirSync(HOME_DIR, { recursive: true });
    for (let tries = 0; ; tries++) {
        try {
            fs.mkdirSync(lock);
            break;
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            // A lock older than a minute belongs to a run that died mid-pull.
            if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { recursive: true, force: true });
            if (tries > 120) throw new Error(`${lock} has been held for over a minute`);
            execFileSync("sleep", ["0.5"]);
        }
    }
    try {
        execFileSync("git", ["-C", TEAM_SKILLS, "fetch", "-q", "origin", "main"]);
        execFileSync("git", ["-C", TEAM_SKILLS, "merge", "-q", "--ff-only", "origin/main"]);
        const now = execFileSync("git", ["-C", TEAM_SKILLS, "rev-parse", "HEAD:bloom-bot"], { encoding: "utf8" });
        return now !== STARTED_ON_TREE;
    } finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}

/** Records how the job's last run went, for the health job to read. */
export function writeStatus(name, ok, error) {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const file = path.join(STATUS_DIR, `${name}.json`);
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const now = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ ...previous, lastRun: now, ...(ok ? { lastSuccess: now, error: null } : { error }) }));
}

/** Returns each job's recorded status, keyed by job name. */
export function readStatuses() {
    if (!fs.existsSync(STATUS_DIR)) return {};
    return Object.fromEntries(
        fs.readdirSync(STATUS_DIR)
            .filter((f) => f.endsWith(".json"))
            .map((f) => [path.basename(f, ".json"), JSON.parse(fs.readFileSync(path.join(STATUS_DIR, f), "utf8"))]),
    );
}

/** Runs one pass of a job: skips it if the previous pass is still going, pulls bloom-team-skills
 * first, records the outcome, and tells Zulip (at most daily) when the pass fails. A changed job
 * script takes effect on the next pass, since this one is already loaded. */
export async function runJob(name, work) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const lock = path.join(HOME_DIR, `${name}.lock`);
    if (!takeLock(lock)) return;
    try {
        pullTeamSkills();
        await work();
        writeStatus(name, true);
    } catch (error) {
        log(error.stack);
        writeStatus(name, false, error.message);
        await notify(`The bot's ${name} job is failing:\n\`\`\`\n${error.message.slice(0, 1500)}\n\`\`\``, `job:${name}`);
        process.exitCode = 1;
    } finally {
        fs.rmSync(lock);
    }
}

/** Makes an empty working folder for one run. The run adds the repos it needs with
 * `bot-tools.mjs checkout`, so only those get fetched. */
export function makeRunDir(name) {
    const dir = path.join(WORK_DIR, name);
    // A run that was killed leaves its folder behind, and a retry uses the same name.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Removes a run folder made by makeRunDir, with the worktrees that `bot-tools.mjs checkout` put
 * in it. */
export function removeRunDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const worktree = path.join(dir, entry.name);
        // A worktree has a .git file pointing back at its clone.
        if (!entry.isDirectory() || !fs.existsSync(path.join(worktree, ".git"))) continue;
        const gitDir = execFileSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
            { encoding: "utf8" }).trim();
        execFileSync("git", ["--git-dir", gitDir, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
}

// The bot runs on John's Claude subscription. It stops when his weekly usage reaches
// MAX_WEEKLY_USAGE, or when the bot itself has used MAX_BOT_SHARE of the week.
const MAX_WEEKLY_USAGE = 0.9;
const MAX_BOT_SHARE = 0.05;
const BUDGET_FILE = path.join(HOME_DIR, "budget.json");

/** Reads the subscription's weekly usage (0 to 1) and when the week resets, from the headers of a
 * one-token request. Anthropic reports usage on every reply; this is the cheapest reply there is. */
export async function readWeeklyUsage() {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: {
            Authorization: `Bearer ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: "claude-haiku-5-5", max_tokens: 1,
            // A subscription token is only accepted for Claude Code requests.
            system: "You are Claude Code, Anthropic's official CLI for Claude.",
            messages: [{ role: "user", content: "hi" }],
        }),
    });
    const usage = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
    const reset = response.headers.get("anthropic-ratelimit-unified-7d-reset");
    if (usage === null) throw new Error(`no weekly usage in the reply (${response.status}): ${(await response.text()).slice(0, 300)}`);
    return { usage: Number(usage), resetsAt: new Date(Number(reset) * 1000) };
}

/** Reads the bot's share of the current week, starting from zero when the week has reset. */
function readBotShare(resetsAt) {
    const saved = fs.existsSync(BUDGET_FILE) ? JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8")) : {};
    return saved.resetsAt === resetsAt.toISOString() ? saved.botShare : 0;
}

/** Returns null when the budget allows a run, or a sentence saying why not and until when. Tells
 * Zulip once per week and reason. */
export async function budgetBlock() {
    const { usage, resetsAt } = await readWeeklyUsage();
    const botShare = readBotShare(resetsAt);
    const until = `until the weekly reset at ${resetsAt.toISOString().replace("T", " ").slice(0, 16)} UTC`;
    let reason = null;
    if (usage >= MAX_WEEKLY_USAGE) {
        reason = `John's Claude subscription is at ${Math.round(usage * 100)}% of this week's budget, so the bot is paused ${until}.`;
    } else if (botShare >= MAX_BOT_SHARE) {
        reason = `The bot has used its ${Math.round(MAX_BOT_SHARE * 100)}% of this week's Claude budget, so it is paused ${until}.`;
    }
    if (reason) await notify(reason, `budget:${resetsAt.toISOString()}:${usage >= MAX_WEEKLY_USAGE ? "total" : "bot"}`);
    return reason;
}

/** Adds what a run used to the bot's share of the week. The difference also counts any use of the
 * subscription made elsewhere during the run, so it errs toward stopping the bot early. */
function recordBotUse(before, after) {
    const botShare = readBotShare(after.resetsAt) + Math.max(0, after.usage - (before.resetsAt.getTime() === after.resetsAt.getTime() ? before.usage : 0));
    fs.writeFileSync(BUDGET_FILE, JSON.stringify({ resetsAt: after.resetsAt.toISOString(), botShare }));
}

/** Runs Claude in `cwd`, able to read and to change YouTrack through bot-tools, with BOT.md, then the job's skill, then the job's own text as
 * its prompt. Returns the text after the last "=== OUTPUT ===" line, and any note after a
 * "=== MAINTAINER ===" line before it, which is also sent to Zulip. Callers check budgetBlock()
 * first; this records what the run used toward the bot's share. A run that goes past
 * CLAUDE_TIMEOUT_MINUTES throws an error with `timedOut` set.
 *
 * `writable` lists absolute paths Claude may Edit and Write: a file, or a folder as "<dir>/**".
 * `commands` lists extra command prefixes it may run with Bash, e.g. "node /path/tool.mjs". */
export async function runClaude({ cwd, skillFile, task, label, test = false, effort = EFFORT, timeoutMinutes = CLAUDE_TIMEOUT_MINUTES, writable = [], commands = [] }) {
    const usageBefore = await readWeeklyUsage();
    try {
        return await runClaudeOnce({ cwd, skillFile, task, label, test, effort, timeoutMinutes, writable, commands });
    } finally {
        recordBotUse(usageBefore, await readWeeklyUsage());
    }
}

/**
 * Runs a command with `input` on stdin and resolves with its exit status and output. Unlike
 * spawnSync it leaves the event loop free, so a job keeps polling while Claude works. Stops the
 * command after `timeoutMs` and reports that with `timedOut`.
 */
function runCommand(command, args, { cwd, env, input, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, timeoutMs);
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr, timedOut });
        });
        child.stdin.end(input);
    });
}

/** Runs Claude once; see runClaude(). */
async function runClaudeOnce({ cwd, skillFile, task, label, test, effort, timeoutMinutes, writable, commands }) {
    const prompt = [fs.readFileSync(BOT_GUIDE, "utf8"), fs.readFileSync(skillFile, "utf8"), task].join("\n\n");
    const env = { ...process.env };
    for (const key of ["YOUTRACK_BOT", "SENTRY_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) delete env[key];

    const result = await runCommand(
        "claude",
        [
            "-p",
            "--model", MODEL,
            "--effort", effort,
            "--setting-sources", "project",
            "--permission-mode", "default",
            "--allowedTools",
            "Read", "Grep", "Glob",
            // "*" after the subcommand with no space, so a bare `git -C repo diff` matches too.
            ...["log", "show", "blame", "grep", "diff", "status", "branch"].map((command) => `Bash(git -C * ${command}*)`),
            `Bash(node ${BOT_TOOLS}:*)`,
            ...commands.map((command) => `Bash(${command}:*)`),
            // A leading "//" makes a permission path absolute. Every run may write the bodies of its
            // YouTrack requests under .youtrack, where bot-tools reads them.
            ...[...writable, `${cwd}/.youtrack/**`].flatMap((p) => [`Edit(/${p})`, `Write(/${p})`]),
            "--disallowedTools",
            // ~/.config holds the bot's tokens and gh's GitHub login.
            `Read(/${path.join(os.homedir(), ".config")}/**)`, `Read(/${path.join(os.homedir(), ".claude")}/**)`,
            `Read(/${ZULIPRC})`,
            "WebFetch", "WebSearch",
        ],
        { cwd, env, input: prompt, timeoutMs: timeoutMinutes * 60 * 1000 },
    );
    if (result.timedOut) {
        const error = new Error(`Claude ran past ${timeoutMinutes} minutes on ${label} and was stopped`);
        error.timedOut = true;
        throw error;
    }
    if (result.status !== 0) {
        throw new Error(`claude exited ${result.status}: ${result.stderr.slice(-2000)}`);
    }
    const parts = result.stdout.split(/^=== OUTPUT ===\s*$/m);
    const noteParts = parts.slice(0, -1).join("\n").split(/^=== MAINTAINER ===\s*$/m);
    const maintainerNote = noteParts.length > 1 ? noteParts[noteParts.length - 1].trim() : "";
    // A test run (test: true) prints its note instead, for whoever is running the test.
    if (maintainerNote && test) log(`maintainer note: ${maintainerNote}`);
    if (maintainerNote && !test) {
        await notify(`While working on ${label}, the bot left this note for its maintainer:\n\n${maintainerNote}`);
    }
    return parts[parts.length - 1].trim();
}
