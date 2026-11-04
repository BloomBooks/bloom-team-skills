// What every Bloom bot job on the bot's Mac shares: logging, telling the developers on Slack,
// the lock that keeps a job from overlapping itself, BloomDesktop worktrees, and Claude runs
// that reach other services only through bot-tools.mjs and bot-checks.mjs, which hold the tokens.
// A job (poll-youtrack.mjs, ...) is a small script that calls runJob() with its own work.
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
// Long enough for one run of chosen tests on the Windows runner (bot-checks.mjs windows), which
// takes 10 to 20 minutes.
export const CLAUDE_TIMEOUT_MINUTES = 45;
const BOT_CHECKS = path.join(BOT_DIR, "bot-checks.mjs");
const ENV_FILE = path.join(os.homedir(), ".config", "bloom-bot", "env");
// The sites a Claude run may fetch pages from: documentation and bug trackers. Add one here when
// the bot needs it; never a site where a URL's text ends up somewhere others could read it.
const FETCH_SITES = [
    "learn.microsoft.com", "developer.microsoft.com", "github.com", "raw.githubusercontent.com",
    "issues.chromium.org", "chromium.googlesource.com", "developer.chrome.com", "developer.mozilla.org",
    "playwright.dev", "vitest.dev", "react.dev", "mui.com", "www.npmjs.com", "www.nuget.org",
    "docs.bloomlibrary.org", "community.software.sil.org", "stackoverflow.com",
];

// #bloom-bot-status, by id: where notify() posts, and where slack-listener.mjs answers every
// message. The bot must be a member of it.
export const SLACK_STATUS_CHANNEL_ID = "C0CEMAU8EBW";
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

/** Tells the bot's maintainers: posts to its Slack status channel. With `kind`, posts at most
 * once a day per kind, so a problem that recurs every run (an expired token) sends one message,
 * not hundreds. Never throws: failing to notify must not stop a job. */
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
    let sent = false;
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
 * off, as they would dwarf a short post. `extra` adds chat.postMessage arguments, such as
 * `thread_ts` to reply in a thread. */
export async function postToSlack(channel, markdown, extra = {}) {
    return slack("chat.postMessage", {
        ...extra,
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
 * first, records the outcome, and tells Slack #bloom-bot-status (at most daily) when the pass fails. A changed job
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
 * Slack #bloom-bot-status once per week and reason. */
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

/** Runs Claude in `cwd` with BOT.md, then the job's skill, then the job's own text as its prompt.
 * Returns the text after the last "=== OUTPUT ===" line. Before that line, a "=== MAINTAINER ==="
 * note is sent to Slack #bloom-bot-status, and a "=== PR ===" request makes this open a draft PR of
 * a repo Claude changed in `cwd` (see openRequestedPr()), adding its link or the reason it failed
 * to the output. Callers check budgetBlock() first; this records what the run used toward the
 * bot's share. A run that goes past its timeout throws an error with `timedOut` set.
 *
 * Every run may write anywhere under `cwd`, run bot-tools.mjs and bot-checks.mjs, and use the web.
 * `writable` lists more absolute paths it may Edit and Write: a file, or a folder as "<dir>/**".
 * `commands` lists extra command prefixes it may run with Bash, e.g. "node /path/tool.mjs". */
export async function runClaude({ cwd, skillFile, task, label, test = false, effort = EFFORT, timeoutMinutes = CLAUDE_TIMEOUT_MINUTES, writable = [], commands = [] }) {
    const usageBefore = await readWeeklyUsage();
    try {
        const { output, prRequest } = await runClaudeOnce({ cwd, skillFile, task, label, test, effort, timeoutMinutes, writable, commands });
        if (!prRequest) return output;
        if (test) {
            log(`PR request (not opened in a test): ${prRequest}`);
            return output;
        }
        try {
            const url = await openRequestedPr(cwd, JSON.parse(prRequest), label);
            log(`opened ${url}`);
            return `${output}\n\nDraft PR: ${url}`;
        } catch (error) {
            log(`PR request failed: ${error.stack}`);
            await notify(`While working on ${label}, the bot asked for a draft PR, and opening it failed:\n\`\`\`\n${error.message.slice(0, 1500)}\n\`\`\``);
            return `${output}\n\n(I meant to open a draft PR with this change, but that failed: ${error.message.split("\n")[0]})`;
        }
    } finally {
        recordBotUse(usageBefore, await readWeeklyUsage());
    }
}

/**
 * Opens the draft PR that a run asked for and returns its URL. `request` is
 * { repo, base, title, body, changesExistingTests }: `repo` names a BloomBooks repo checked out
 * at <cwd>/<repo> (BloomDesktop when left out), `base` its branch to merge into (the repo's
 * default branch when left out). The changes go on a new bot/ branch. For BloomDesktop, the PR's
 * Proof section lists the bot-checks.mjs checks that ran on exactly these files.
 */
async function openRequestedPr(cwd, request, label) {
    const { freeBranchName, gh, openDraftPr, pushBranch, refuseDependencyChanges, refuseWorkflowChanges, worktreeTree, checksFile } = await import("./bot-github.mjs");
    const name = request.repo || "BloomDesktop";
    if (!/^[\w.-]+$/.test(name)) throw new Error(`unexpected repo name ${name}`);
    const repo = `BloomBooks/${name}`;
    const repoDir = path.join(cwd, name);
    if (!fs.existsSync(path.join(repoDir, ".git"))) throw new Error(`${name} is not checked out in the run's folder`);
    if (!request.title || !request.body) throw new Error("the PR request needs a title and a body");
    const base = request.base || JSON.parse(gh(["repo", "view", repo, "--json", "defaultBranchRef"])).defaultBranchRef.name;
    const git = (...args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
    git("fetch", "-q", "origin", base);
    const tree = worktreeTree(repoDir);
    const branch = freeBranchName(request.title, repo);
    git("checkout", "-q", "-b", branch);
    git("add", "-A");
    const attribution = `[${MODEL_NAME} on the Bloom bot Mac during ${label}]`;
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-F", "-"], { input: `${request.title}\n\n${attribution}\n` });
    refuseWorkflowChanges(repoDir, `origin/${base}`);
    refuseDependencyChanges(repoDir, `origin/${base}`, "HEAD");
    if (git("diff", "--name-only", `origin/${base}`, "HEAD").trim() === "") throw new Error(`there are no changes against ${base}`);

    const parts = [attribution, request.body.trim()];
    if (name === "BloomDesktop") {
        const file = checksFile(cwd);
        const checks = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
        const lines = checks.filter((c) => c.tree === tree || (c.onMaster && c.kind === "windows")).map((c) => {
            if (c.kind === "compile") return `- C# compiled on the bot's Mac: ${c.ok ? "succeeded" : "failed"}`;
            if (c.kind === "vitest") return `- vitest on the bot's Mac (${c.files.join(", ")}): ${c.ok ? "passed" : "failed"}`;
            const what = Object.entries(c.tests).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join("; ");
            return `- On Windows${c.onMaster ? ", on master" : ""} (${what}, ${c.repeat} repeat${c.repeat === 1 ? "" : "s"}): ${c.failed} failed of ${c.runs} test results. [Run](${c.runUrl})`;
        });
        parts.push(`## Proof\n\n${lines.length ? lines.join("\n") : "No check ran on exactly these files."}`);
    }
    pushBranch(repoDir, branch, repo);
    return openDraftPr({ repo, branch, base, title: request.title, body: parts.join("\n\n") });
}

/** The names of the variables in the bot's env file, which are kept from Claude, all but Claude
 * Code's own login, which the `claude` process needs to start. */
function secretNames() {
    if (!fs.existsSync(ENV_FILE)) return [];
    return fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).map((l) => l.match(/^(?:export\s+)?(\w+)=/)?.[1])
        .filter((name) => name && name !== "CLAUDE_CODE_OAUTH_TOKEN");
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
    for (const key of ["YOUTRACK_BOT", "SENTRY_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", ...secretNames()]) delete env[key];
    // Lets a command such as `bot-checks.mjs windows` run as long as the run itself may.
    env.BASH_MAX_TIMEOUT_MS = String(timeoutMinutes * 60 * 1000);

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
            `Bash(node ${BOT_CHECKS}:*)`,
            ...commands.map((command) => `Bash(${command}:*)`),
            // A leading "//" makes a permission path absolute. The run's own folder holds its
            // checkouts, the request bodies that bot-tools reads, and anything else it makes. An
            // Edit rule covers Write too; Claude Code refuses to start when given a Write rule.
            ...[...writable, `${cwd}/**`].map((p) => `Edit(/${p})`),
            "WebSearch",
            // Fetching only from these sites: text the bot reads can steer it, and a fetch from any
            // site would let steered text send what the bot can read out in a URL.
            ...FETCH_SITES.map((site) => `WebFetch(domain:${site})`),
            "--disallowedTools",
            // ~/.config holds the bot's tokens and gh's GitHub login.
            `Read(/${path.join(os.homedir(), ".config")}/**)`, `Read(/${path.join(os.homedir(), ".claude")}/**)`,
            `Read(/${ZULIPRC})`,
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
    const before = parts.slice(0, -1).join("\n");
    // Each marked section runs to the next "=== ... ===" line.
    const section = (marker) => {
        const pieces = before.split(new RegExp(`^=== ${marker} ===\\s*$`, "m"));
        return pieces.length > 1 ? pieces[pieces.length - 1].split(/^=== [A-Z]+ ===\s*$/m)[0].trim() : "";
    };
    const maintainerNote = section("MAINTAINER");
    const prRequest = section("PR");
    // A test run (test: true) prints its note instead, for whoever is running the test.
    if (maintainerNote && test) log(`maintainer note: ${maintainerNote}`);
    if (maintainerNote && !test) {
        await notify(`While working on ${label}, the bot left this note for its maintainer:\n\n${maintainerNote}`);
    }
    return { output: parts[parts.length - 1].trim(), prRequest: prRequest ? prRequest.slice(prRequest.indexOf("{"), prRequest.lastIndexOf("}") + 1) : "" };
}
