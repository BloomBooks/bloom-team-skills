// Answers @Bot requests on YouTrack. Runs on the bot's Mac every couple of minutes (see
// com.bloom.bot.youtrack.plist).
//
// The YouTrack workflow in ./youtrack-workflow adds a Bot comment "[YouTrack workflow] Queued for
// the Bloom bot." right after a Developers-group member's comment that mentions @Bot. This script
// finds those comments, answers the comment just before each one with a read-only Claude run, and
// replaces the queued comment's text with the answer.
//
// Claude never gets the YouTrack token or any tool that can write: this script fetches the card,
// hands it over as data, and posts the answer itself. Card text comes from the public and must be
// treated as untrusted.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "https://issues.bloomlibrary.org/youtrack/api";
const PROJECTS = (process.env.BLOOM_BOT_PROJECTS || "BL,SB").split(",");
const QUEUED = "[YouTrack workflow] Queued for the Bloom bot.";
const WORKING = "[YouTrack workflow] The Bloom bot is working on this.";
const BOT_LOGIN = "Bot";
const MODEL = process.env.BLOOM_BOT_MODEL || "claude-opus-5-5";
const MODEL_NAME = "Claude Opus 5.5";
const EFFORT = "low";
const TEAM_SKILLS = path.join(os.homedir(), "dev", "bloom-team-skills");
const SKILL = path.join(TEAM_SKILLS, "answer-youtrack-mention", "SKILL.md");
const BOT_TOOLS = path.join(TEAM_SKILLS, "bloom-bot", "bot-tools.mjs");
const SECRETS = path.join(os.homedir(), ".config", "bloom-bot");
const REPO = path.join(os.homedir(), "dev", "bloom");
const HOME_DIR = path.join(os.homedir(), "bloom-bot");
const WORK_DIR = path.join(HOME_DIR, "work");
const LOCK = path.join(HOME_DIR, "poll-youtrack.lock");
const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;
const TOKEN = process.env.YOUTRACK_BOT;

/** Logs a line with a timestamp; launchd sends stdout to the log file. */
function log(message) {
    console.log(`${new Date().toISOString()} ${message}`);
}

/** Calls the YouTrack REST API as the Bot account and returns the parsed JSON. */
async function youtrack(pathAndQuery, options = {}) {
    const response = await fetch(`${BASE}${pathAndQuery}`, {
        ...options,
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
        },
    });
    if (!response.ok) {
        throw new Error(`YouTrack ${response.status} on ${pathAndQuery}: ${await response.text()}`);
    }
    return response.json();
}

/** Replaces the whole text of a comment the Bot posted. */
async function setCommentText(issueId, commentId, text) {
    await youtrack(`/issues/${issueId}/comments/${commentId}?fields=id`, {
        method: "POST",
        body: JSON.stringify({ text }),
    });
}

/** Returns the issues that have a queued comment. YouTrack's text search is fuzzy, so callers
 * still check each comment's text exactly. */
async function findQueuedIssues() {
    const query = `project: ${PROJECTS.join(", ")} "Queued for the Bloom bot"`;
    const issues = await youtrack(
        `/issues?query=${encodeURIComponent(query)}&fields=idReadable&$top=50`,
    );
    return issues.map((issue) => issue.idReadable);
}

/** Reads the card's summary, description and live comments, oldest comment first. */
async function readIssue(issueId) {
    const issue = await youtrack(
        `/issues/${issueId}?fields=idReadable,summary,description,` +
            `customFields(name,value(name)),` +
            `comments(id,text,created,deleted,author(login,id)),attachments(name,size)`,
    );
    issue.comments = issue.comments.filter((c) => !c.deleted).sort((a, b) => a.created - b.created);
    return issue;
}

/** Pairs each queued comment with the request it answers: the comment just before it that the Bot
 * did not write. */
function findRequests(issue) {
    const requests = [];
    issue.comments.forEach((comment, index) => {
        if (comment.author.login !== BOT_LOGIN || comment.text.trim() !== QUEUED) return;
        const request = issue.comments
            .slice(0, index)
            .reverse()
            .find((c) => c.author.login !== BOT_LOGIN);
        requests.push({ queuedComment: comment, request });
    });
    return requests;
}

/** Renders the card as Markdown for the prompt. Authors appear by YouTrack's anonymized ids,
 * which is all the Bot account can see. */
function renderIssue(issue) {
    const fields = issue.customFields
        .map((f) => `${f.name}: ${Array.isArray(f.value) ? f.value.map((v) => v?.name).join(", ") : (f.value?.name ?? "")}`)
        .join("\n");
    const comments = issue.comments
        .map((c) => `### Comment ${c.id} by ${c.author.login}, ${new Date(c.created).toISOString()}\n\n${c.text}`)
        .join("\n\n");
    return `# ${issue.idReadable}: ${issue.summary}\n\n${fields}\n\n## Description\n\n${issue.description ?? ""}\n\n## Comments\n\n${comments}`;
}

/** Makes a detached worktree of BloomDesktop's current master for one run. Fetches every branch,
 * because answers read the Version* branch that the reporter's build came from. */
function makeWorktree(name) {
    execFileSync("git", ["-C", REPO, "fetch", "-q", "--prune", "origin"]);
    const dir = path.join(WORK_DIR, name);
    execFileSync("git", ["-C", REPO, "worktree", "add", "-q", "--detach", dir, "origin/master"]);
    return dir;
}

/** Removes a worktree made by makeWorktree. */
function removeWorktree(dir) {
    execFileSync("git", ["-C", REPO, "worktree", "remove", "--force", dir]);
}

/** Runs Claude read-only in the worktree and returns its answer text. */
function askClaude(cwd, issue, request) {
    const prompt = [
        fs.readFileSync(SKILL, "utf8"),
        "",
        `The card is ${issue.idReadable}. The read-only helper is \`node ${BOT_TOOLS}\`.`,
        `Its attachments: ${issue.attachments.map((a) => `${a.name} (${a.size} bytes)`).join(", ") || "none"}.`,
        `The comment you are answering is comment ${request.id}:`,
        "",
        "<request>",
        request.text,
        "</request>",
        "",
        "<card>",
        renderIssue(issue),
        "</card>",
    ].join("\n");

    const env = { ...process.env };
    delete env.YOUTRACK_BOT;

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
            "Bash(git log:*)", "Bash(git show:*)", "Bash(git blame:*)", "Bash(git grep:*)",
            "Bash(git diff:*)", "Bash(git branch:*)",
            `Bash(node ${BOT_TOOLS}:*)`,
            "--disallowedTools",
            `Read(/${SECRETS}/**)`, `Read(/${path.join(os.homedir(), ".claude")}/**)`,
            "WebFetch", "WebSearch",
        ],
        { cwd, env, input: prompt, encoding: "utf8", timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`claude exited ${result.status}: ${result.stderr.slice(-2000)}`);
    }
    // Claude's final message can open with progress notes; the skill has it put the comment after
    // a marker line.
    const parts = result.stdout.split(/^=== COMMENT ===\s*$/m);
    return parts[parts.length - 1].trim();
}

/** Answers one request, leaving the queued comment either holding the answer or saying it failed. */
async function answer(issue, { queuedComment, request }) {
    if (!request) {
        await setCommentText(issue.idReadable, queuedComment.id,
            "[YouTrack workflow] The Bloom bot could not find the comment it was asked to answer.");
        return;
    }
    // Claim it first, so the next poll doesn't start a second run on the same request.
    await setCommentText(issue.idReadable, queuedComment.id, WORKING);
    log(`${issue.idReadable}: answering comment ${request.id}`);
    let dir;
    try {
        dir = makeWorktree(`${issue.idReadable}-${queuedComment.id}`);
        const text = askClaude(dir, issue, request);
        await setCommentText(issue.idReadable, queuedComment.id,
            `[${MODEL_NAME} on the Bloom bot Mac during bloom-bot]\n\n${text}`);
        log(`${issue.idReadable}: answered`);
    } catch (error) {
        log(`${issue.idReadable}: failed: ${error.stack}`);
        await setCommentText(issue.idReadable, queuedComment.id,
            "[YouTrack workflow] The Bloom bot failed to answer this. The log on the bot's Mac has the details.");
    } finally {
        if (dir) removeWorktree(dir);
    }
}

/** Takes the lock file, or returns false if another poll is still running. */
function takeLock() {
    try {
        fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
        return true;
    } catch {
        const pid = Number(fs.readFileSync(LOCK, "utf8"));
        try {
            process.kill(pid, 0);
            return false;
        } catch {
            fs.writeFileSync(LOCK, String(process.pid));
            return true;
        }
    }
}

async function main() {
    if (!TOKEN) throw new Error("YOUTRACK_BOT is not set; it belongs in ~/.config/bloom-bot/env");
    fs.mkdirSync(WORK_DIR, { recursive: true });
    if (!takeLock()) return;
    try {
        // Picks up changes to the skill and these scripts. A changed poller takes effect on the
        // next run, since this one is already loaded.
        execFileSync("git", ["-C", TEAM_SKILLS, "pull", "-q", "--ff-only"]);
        for (const issueId of await findQueuedIssues()) {
            const issue = await readIssue(issueId);
            for (const request of findRequests(issue)) {
                await answer(issue, request);
            }
        }
    } finally {
        fs.rmSync(LOCK);
    }
}

main().catch((error) => {
    log(error.stack);
    process.exit(1);
});
