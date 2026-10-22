// What every Bloom bot job on the bot's Mac shares: logging, telling the developers on Zulip,
// the lock that keeps a job from overlapping itself, BloomDesktop worktrees, and read-only Claude
// runs. A job (poll-youtrack.mjs, ...) is a small script that calls runJob() with its own work.
//
// Secrets live in ~/.config/bloom-bot/env (loaded by the login zsh that launchd starts) and
// ~/.zuliprc. Claude runs never see either: runClaude() strips the tokens from its environment
// and denies its file tools those paths.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEAM_SKILLS = path.join(os.homedir(), "dev", "bloom-team-skills");
export const BOT_DIR = path.join(TEAM_SKILLS, "bloom-bot");
export const BOT_TOOLS = path.join(BOT_DIR, "bot-tools.mjs");
// The repos every run can read. Each is a clone under ~/dev on the Mac; a run gets a worktree of
// each, named `name`, side by side in its working directory. Adding a repo: clone it there with
// --filter=blob:none, add it here, and list it in BOT.md.
const REPOS = [
    { name: "BloomDesktop", clone: path.join(os.homedir(), "dev", "bloom"), branch: "master" },
    { name: "bloom-player", clone: path.join(os.homedir(), "dev", "bloom-player"), branch: "master" },
];
export const HOME_DIR = path.join(os.homedir(), "bloom-bot");
const WORK_DIR = path.join(HOME_DIR, "work");
const STATUS_DIR = path.join(HOME_DIR, "status");
const SECRETS = path.join(os.homedir(), ".config", "bloom-bot");
const ZULIPRC = path.join(os.homedir(), ".zuliprc");
const BOT_GUIDE = path.join(BOT_DIR, "BOT.md");

export const MODEL = "claude-opus-5-5";
export const MODEL_NAME = "Claude Opus 5.5";
const EFFORT = "low";
const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;

const ZULIP_CHANNEL = "bot testing";
const ZULIP_TOPIC = "Bloom bot";
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

/** Posts to the bot's topic in Zulip's developers channel. With `kind`, posts at most once a day
 * per kind, so a problem that recurs every run (an expired token) sends one message, not hundreds.
 * Never throws: failing to notify must not stop a job. */
export async function notify(message, kind) {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        const stateFile = path.join(HOME_DIR, "notified.json");
        const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
        if (kind && Date.now() - (state[kind] ?? 0) < NOTIFY_INTERVAL_MS) return;
        const zulip = readZuliprc();
        if (!zulip) {
            log(`not notified (no ~/.zuliprc): ${message}`);
            return;
        }
        const response = await fetch(`${zulip.site}/api/v1/messages`, {
            method: "POST",
            signal: AbortSignal.timeout(60_000),
            headers: { Authorization: `Basic ${Buffer.from(`${zulip.email}:${zulip.key}`).toString("base64")}` },
            body: new URLSearchParams({ type: "stream", to: ZULIP_CHANNEL, topic: ZULIP_TOPIC, content: message }),
        });
        if (!response.ok) throw new Error(`Zulip ${response.status}: ${await response.text()}`);
        if (kind) {
            state[kind] = Date.now();
            fs.writeFileSync(stateFile, JSON.stringify(state));
        }
    } catch (error) {
        log(`notify failed: ${error.message}`);
    }
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

/** Fast-forwards bloom-team-skills and returns true if that changed anything in bloom-bot/. */
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
        const before = execFileSync("git", ["-C", TEAM_SKILLS, "rev-parse", "HEAD:bloom-bot"], { encoding: "utf8" });
        execFileSync("git", ["-C", TEAM_SKILLS, "fetch", "-q", "origin", "main"]);
        execFileSync("git", ["-C", TEAM_SKILLS, "merge", "-q", "--ff-only", "origin/main"]);
        const after = execFileSync("git", ["-C", TEAM_SKILLS, "rev-parse", "HEAD:bloom-bot"], { encoding: "utf8" });
        return before !== after;
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

/** Makes a folder for one run holding a detached worktree of each repo in REPOS, on its default
 * branch, named as in REPOS. Fetches every branch, because answers often read a Version* branch. */
export function makeWorktree(name) {
    const dir = path.join(WORK_DIR, name);
    // A run that was killed leaves its worktrees behind, and a retry uses the same name.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const repo of REPOS) {
        execFileSync("git", ["-C", repo.clone, "fetch", "-q", "--prune", "origin"]);
        execFileSync("git", ["-C", repo.clone, "worktree", "prune"]);
        execFileSync("git", ["-C", repo.clone, "worktree", "add", "-q", "--detach",
            path.join(dir, repo.name), `origin/${repo.branch}`]);
    }
    return dir;
}

/** Removes a run folder made by makeWorktree. */
export function removeWorktree(dir) {
    for (const repo of REPOS) {
        execFileSync("git", ["-C", repo.clone, "worktree", "remove", "--force", path.join(dir, repo.name)]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
}

/** Runs Claude read-only in `cwd` with BOT.md, then the job's skill, then the job's own text as
 * its prompt. Returns the text after the last "=== OUTPUT ===" line, and any note after a
 * "=== MAINTAINER ===" line before it, which is also sent to Zulip. */
export async function runClaude({ cwd, skillFile, task, label }) {
    const prompt = [fs.readFileSync(BOT_GUIDE, "utf8"), fs.readFileSync(skillFile, "utf8"), task].join("\n\n");
    const env = { ...process.env };
    for (const key of ["YOUTRACK_BOT", "SENTRY_BOT_TOKEN"]) delete env[key];

    const result = spawnSync(
        "claude",
        [
            "-p",
            "--model", MODEL,
            "--effort", EFFORT,
            "--setting-sources", "project",
            "--permission-mode", "default",
            "--allowedTools",
            "Read", "Grep", "Glob",
            ...["log", "show", "blame", "grep", "diff", "branch"].map((command) => `Bash(git -C * ${command} *)`),
            `Bash(node ${BOT_TOOLS}:*)`,
            "--disallowedTools",
            `Read(/${SECRETS}/**)`, `Read(/${path.join(os.homedir(), ".claude")}/**)`, `Read(/${ZULIPRC})`,
            "WebFetch", "WebSearch",
        ],
        { cwd, env, input: prompt, encoding: "utf8", timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`claude exited ${result.status}: ${result.stderr.slice(-2000)}`);
    }
    const parts = result.stdout.split(/^=== OUTPUT ===\s*$/m);
    const noteParts = parts.slice(0, -1).join("\n").split(/^=== MAINTAINER ===\s*$/m);
    const maintainerNote = noteParts.length > 1 ? noteParts[noteParts.length - 1].trim() : "";
    if (maintainerNote) {
        await notify(`While working on ${label}, the bot left this note for its maintainer:\n\n${maintainerNote}`);
    }
    return parts[parts.length - 1].trim();
}
