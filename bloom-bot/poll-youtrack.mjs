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
    BOT_TOOLS, MODEL_NAME, TEAM_SKILLS,
    log, makeRunDir, notify, removeRunDir, runClaude, runJob,
} from "./bot-runtime.mjs";

const BASE = "https://issues.bloomlibrary.org/youtrack/api";
const PROJECTS = (process.env.BLOOM_BOT_PROJECTS || "BL,SB").split(",");
const QUEUED = "[YouTrack workflow] Queued for the Bloom bot.";
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
        await setCommentText(issue.idReadable, queuedComment.id,
            "[YouTrack workflow] The Bloom bot failed to answer this. The log on the bot's Mac has the details.");
    } finally {
        if (dir) removeRunDir(dir);
    }
}

await runJob("youtrack", async () => {
    if (!TOKEN) throw new Error("YOUTRACK_BOT is not set; it belongs in ~/.config/bloom-bot/env");
    for (const issueId of await findQueuedIssues()) {
        const issue = await readIssue(issueId);
        for (const request of findRequests(issue)) {
            await answer(issue, request);
        }
    }
});
