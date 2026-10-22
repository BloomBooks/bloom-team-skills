// Answers @-mentions of the Bloom bot on Zulip (sil-bloom.zulipchat.com), in any public channel
// and in direct messages, for any full member (not guests). Runs continuously under launchd
// (com.bloom.bot.zulip.plist, KeepAlive), holding a long-poll on Zulip's real-time events API.
//
// For each mention it reacts with :eyes:, gives Claude the message and the recent conversation as
// data, and replies in the same topic or DM. Claude never sees the Zulip key: this script posts.
// When a pull brings a change to bloom-bot/, the script exits so launchd restarts it on the new
// code.

import path from "node:path";
import {
    BOT_TOOLS, TEAM_SKILLS,
    budgetBlock, log, makeRunDir, notify, pullTeamSkills, removeRunDir, runClaude, writeStatus, zulipCredentials,
} from "./bot-runtime.mjs";

const SKILL = path.join(TEAM_SKILLS, "answer-zulip-mention", "SKILL.md");
const CONTEXT_MESSAGES = 20;
// Zulip's roles: 100 owner, 200 administrator, 300 moderator, 400 member, 600 guest.
const FULL_MEMBER_MAX_ROLE = 400;

const zulip = zulipCredentials();
const auth = `Basic ${Buffer.from(`${zulip.email}:${zulip.key}`).toString("base64")}`;

/** Calls Zulip's REST API and returns the parsed JSON; fails on any error result. */
async function api(method, endpoint, params = {}, timeoutMs = 60_000) {
    const body = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
    const url = method === "GET" ? `${zulip.site}/api/v1${endpoint}?${body}` : `${zulip.site}/api/v1${endpoint}`;
    const response = await fetch(url, {
        method,
        headers: { Authorization: auth },
        body: method === "GET" ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json();
    if (json.result !== "success") {
        const error = new Error(`Zulip ${endpoint}: ${json.code} ${json.msg}`);
        error.code = json.code;
        throw error;
    }
    return json;
}

/** True when the sender is a full member of the organization: not a guest, not a bot. */
async function isFullMember(userId) {
    const { user } = await api("GET", `/users/${userId}`);
    return !user.is_bot && user.role <= FULL_MEMBER_MAX_ROLE;
}

/** The narrow for the conversation a message is in: its channel and topic, or its DM thread. */
function conversationNarrow(message) {
    if (message.type === "stream") {
        return [{ operator: "channel", operand: message.stream_id }, { operator: "topic", operand: message.subject }];
    }
    return [{ operator: "dm", operand: message.display_recipient.map((r) => r.id) }];
}

/** Renders the messages leading up to this one, then this one, as raw Markdown. The message itself
 * comes from the event, not from history: right after it is sent, a history fetch can come back
 * without it. */
async function readConversation(message) {
    const { messages } = await api("GET", "/messages", {
        anchor: String(message.id), num_before: String(CONTEXT_MESSAGES), num_after: "0",
        include_anchor: "false", narrow: conversationNarrow(message), apply_markdown: "false",
    });
    return [...messages.filter((m) => m.id !== message.id), message]
        .map((m) => `### ${m.sender_full_name}, ${new Date(m.timestamp * 1000).toISOString()}\n\n${m.content}`)
        .join("\n\n");
}

/** Posts the reply in the same topic, or the same DM thread. */
async function reply(message, content) {
    if (message.type === "stream") {
        await api("POST", "/messages", { type: "stream", to: String(message.stream_id), topic: message.subject, content });
    } else {
        const others = message.display_recipient.map((r) => r.id).filter((id) => id !== botId);
        await api("POST", "/messages", { type: "direct", to: others, content });
    }
}

/** Answers one mention, replying with a short failure note if the run fails. */
async function answer(message) {
    const where = message.type === "stream" ? `#${message.display_recipient} > ${message.subject}` : "a DM";
    const blocked = await budgetBlock();
    if (blocked) {
        log(blocked);
        await reply(message, `Sorry, I can't answer right now. ${blocked} Ask me again after that.`);
        return;
    }
    log(`answering ${message.sender_full_name} in ${where}`);
    await api("POST", `/messages/${message.id}/reactions`, { emoji_name: "eyes" }).catch(() => {});
    let dir;
    try {
        if (pullTeamSkills()) restartWanted = true;
        dir = makeRunDir(`zulip-${message.id}`);
        const task = [
            `The read-only helper is \`node ${BOT_TOOLS}\`.`,
            `${message.sender_full_name} mentioned you in ${where}. Their message is the last one below.`,
            "",
            "<conversation>",
            await readConversation(message),
            "</conversation>",
        ].join("\n");
        const text = await runClaude({ cwd: dir, skillFile: SKILL, task, label: `Zulip ${where}` });
        await reply(message, text);
        log("answered");
    } catch (error) {
        log(`failed: ${error.stack}`);
        await notify(`The bot failed to answer ${message.sender_full_name} in ${where}:\n\`\`\`\n${error.message.slice(0, 1500)}\n\`\`\``);
        await reply(message, "Sorry, I failed to answer that. The developers have been told.").catch(() => {});
    } finally {
        if (dir) removeRunDir(dir);
        await api("DELETE", `/messages/${message.id}/reactions`, { emoji_name: "eyes" }).catch(() => {});
    }
}

/** Decides whether an incoming message is a request for the bot, and answers it if so. */
async function handle(event) {
    const { message, flags } = event;
    if (message.sender_id === botId) return;
    // Zulip sets the "mentioned" flag only in channels the bot is subscribed to, so also look for
    // the mention in the Markdown: "@**bot**" when picked from Zulip's suggestions, or "@bot" when
    // typed by hand, which Zulip leaves as plain text.
    const mentioned = flags.includes("mentioned") || typedMention.test(message.content);
    if (message.type === "stream" && !mentioned) return;
    if (message.type === "stream") log(`mention in #${message.display_recipient} from ${message.sender_full_name}`);
    if (!(await isFullMember(message.sender_id))) {
        log(`ignored a message from ${message.sender_full_name}, who is not a full member`);
        return;
    }
    await answer(message);
}

const { user_id: botId, full_name: botName } = await api("GET", "/users/me");
const typedMention = new RegExp(`(^|[^\\w@])@\\**${botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
let restartWanted = false;

/** Registers an event queue for messages in every public channel and the bot's DMs. */
async function register() {
    // apply_markdown false: events carry the raw Markdown people typed, which is what Claude reads.
    const queue = await api("POST", "/register", {
        event_types: ["message"], all_public_streams: "true", apply_markdown: "false",
    });
    log(`listening (queue ${queue.queue_id})`);
    return { queueId: queue.queue_id, lastEventId: queue.last_event_id };
}

let queue = await register();
for (;;) {
    let events;
    try {
        // Zulip answers a long-poll within about a minute, with a heartbeat if nothing happened.
        ({ events } = await api("GET", "/events", { queue_id: queue.queueId, last_event_id: String(queue.lastEventId) }, 120_000));
        writeStatus("zulip", true);
    } catch (error) {
        if (error.code === "BAD_EVENT_QUEUE_ID") {
            queue = await register();
            continue;
        }
        writeStatus("zulip", false, error.message);
        log(`events: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
    }
    for (const event of events) {
        queue.lastEventId = Math.max(queue.lastEventId, event.id);
        if (event.type !== "message") continue;
        try {
            await handle(event);
        } catch (error) {
            log(`handling message ${event.message.id}: ${error.stack}`);
        }
    }
    if (restartWanted) {
        log("bloom-bot/ changed; exiting so launchd restarts on the new code");
        process.exit(0);
    }
}
