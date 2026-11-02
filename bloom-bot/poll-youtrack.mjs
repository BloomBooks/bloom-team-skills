// Answers @Bot requests on YouTrack. Runs on the bot's Mac every couple of minutes (see
// com.bloom.bot.youtrack.plist).
//
// The YouTrack workflow in ./youtrack-workflow adds a Bot comment "[YouTrack workflow] Queued for
// the Bloom bot." right after a Developers-group member's comment that mentions @Bot. This script
// finds those comments, answers the comment just before each one with a read-only Claude run, and
// replaces the queued comment's text with the answer.
//
// Claude never gets the YouTrack token or any tool that can write: this script fetches the card,
// hands it over as data, and posts the answer itself.

import path from "node:path";
import {
    BOT_TOOLS, CLAUDE_TIMEOUT_MINUTES, MODEL_NAME, TEAM_SKILLS,
    budgetBlock, log, makeRunDir, notify, removeRunDir, runClaude, runJob, writeStatus,
} from "./bot-runtime.mjs";

const BASE = "https://issues.bloomlibrary.org/youtrack/api";
const PROJECTS = (process.env.BLOOM_BOT_PROJECTS || "BL,SB").split(",");
// The workflow posts exactly this; while a request waits, this script adds what it is waiting for.
const QUEUED = "[YouTrack workflow] Queued for the Bloom bot.";
// How often, while Claude answers one request, the script looks for new requests and updates
// what each waiting request says.
const WAITING_REFRESH_MS = 2 * 60 * 1000;
const WORKING = "[YouTrack workflow] The Bloom bot is working on this.";
const BOT_LOGIN = "Bot";
const SKILL = path.join(TEAM_SKILLS, "answer-youtrack-mention", "SKILL.md");
const TOKEN = process.env.YOUTRACK_BOT;

/** Calls the YouTrack REST API as the Bot account and returns the parsed JSON. */
async function youtrack(pathAndQuery, options = {}) {
    const response = await fetch(`${BASE}${pathAndQuery}`, {
        ...options,
        // A connection that dies without a reply otherwise hangs the job, and launchd starts no
        // new run while one is going.
        signal: AbortSignal.timeout(60_000),
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

/** Reads the card's summary, description, attachments and live comments, oldest comment first. */
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
 * did not write. A queued comment starts with QUEUED, followed by what it is waiting for, if
 * anything. */
function findRequests(issue) {
    const requests = [];
    issue.comments.forEach((comment, index) => {
        if (comment.author.login !== BOT_LOGIN || !comment.text.trim().startsWith(QUEUED)) return;
        const request = issue.comments
            .slice(0, index)
            .reverse()
            .find((c) => c.author.login !== BOT_LOGIN);
        requests.push({ issueId: issue.idReadable, queuedComment: comment, request });
    });
    return requests;
}

/** Returns every queued request on every card, oldest card first, in each card's comment order. */
async function findAllRequests() {
    const requests = [];
    for (const issueId of await findQueuedIssues()) requests.push(...findRequests(await readIssue(issueId)));
    return requests;
}

/** What a waiting request's queued comment says, given the card being answered now and how many
 * requests are ahead of this one besides it. */
function waitingText(workingOn, ahead) {
    const rest = ahead === 0
        ? "This one is next."
        : `${ahead} more ${ahead === 1 ? "request is" : "requests are"} ahead of this one.`;
    return `${QUEUED} It is answering a request on ${workingOn} now. ${rest}`;
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
        dir = makeRunDir(`${issue.idReadable}-${queuedComment.id}`);
        const task = [
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
        const comment = await runClaude({ cwd: dir, skillFile: SKILL, task, label: issue.idReadable });
        await setCommentText(issue.idReadable, queuedComment.id,
            `[${MODEL_NAME} on the Bloom bot Mac during bloom-bot]\n\n${comment}`);
        log(`${issue.idReadable}: answered`);
    } catch (error) {
        log(`${issue.idReadable}: failed: ${error.stack}`);
        await notify(`The bot failed to answer a request on ${issue.idReadable}:\n\`\`\`\n${error.message.slice(0, 1500)}\n\`\`\``);
        await setCommentText(issue.idReadable, queuedComment.id, error.timedOut
            ? `[YouTrack workflow] The Bloom bot ran out of time on this (a run is stopped after ${CLAUDE_TIMEOUT_MINUTES} minutes), so there is no answer. A narrower request may fit.`
            : "[YouTrack workflow] The Bloom bot failed to answer this. The log on the bot's Mac has the details.");
    } finally {
        if (dir) removeRunDir(dir);
    }
}

await runJob("youtrack", async () => {
    if (!TOKEN) throw new Error("YOUTRACK_BOT is not set; it belongs in ~/.config/bloom-bot/env");
    // launchd starts no new pass while this one runs, so this pass picks up requests that arrive
    // while it answers, and keeps every waiting request's comment saying what it is waiting for.
    const waiting = await findAllRequests();
    let working = null;

    /** Adds requests that arrived since the last look, then rewrites each waiting comment whose
     * text is out of date. */
    async function refreshWaiting() {
        const known = new Set(waiting.map((r) => r.queuedComment.id));
        for (const request of await findAllRequests()) {
            if (!known.has(request.queuedComment.id) && request.queuedComment.id !== working.queuedComment.id) {
                waiting.push(request);
            }
        }
        for (const [ahead, request] of waiting.entries()) {
            const text = waitingText(working.issueId, ahead);
            if (request.queuedComment.text.trim() === text) continue;
            await setCommentText(request.issueId, request.queuedComment.id, text);
            request.queuedComment.text = text;
        }
        // The pass may run for an hour; tell the health check that it is alive.
        writeStatus("youtrack", true);
    }

    while (waiting.length > 0) {
        working = waiting.shift();
        // Read the card again: it may have new comments, or the request may be gone, since the pass began.
        const issue = await readIssue(working.issueId);
        const request = findRequests(issue).find((r) => r.queuedComment.id === working.queuedComment.id);
        if (!request) continue;
        const blocked = await budgetBlock();
        if (blocked) {
            log(`${issue.idReadable}: ${blocked}`);
            await setCommentText(issue.idReadable, request.queuedComment.id,
                `[YouTrack workflow] The Bloom bot can't answer this now. ${blocked} Mention @Bot again after that.`);
            continue;
        }
        await refreshWaiting();
        let refreshing = null;
        const timer = setInterval(() => {
            refreshing ??= refreshWaiting()
                .catch((error) => log(`updating waiting requests: ${error.message}`))
                .finally(() => { refreshing = null; });
        }, WAITING_REFRESH_MS);
        try {
            await answer(issue, request);
        } finally {
            clearInterval(timer);
            // Let a refresh that is under way finish before `working` moves to the next request.
            await refreshing;
        }
    }
});
