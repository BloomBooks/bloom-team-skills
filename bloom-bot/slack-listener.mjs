// Answers people on Slack. Runs continuously under launchd (com.bloom.bot.slack.plist,
// KeepAlive), holding a Socket Mode connection to Slack. It answers:
//   - every new message in the bot's own channel, #bloom-bot-status (where notify() posts), with
//     no mention needed;
//   - an @-mention of the bot, in any channel the bot is in;
//   - a reply in a thread the bot is part of (any thread in #bloom-bot-status, or one elsewhere
//     where it has replied), as a person would: with one person in the thread, everything they
//     say is for the bot; with several, it reads along and replies only when it has something to
//     add (see reason()).
// Slack sends every message in every channel the bot is in; the rest are dropped unread.
//
// For each message it answers, it reacts with :eyes:, gives Claude the message and the
// conversation before it (the thread, or the channel's recent messages) as data, and replies in
// the message's thread. Claude never sees the Slack tokens: this script posts. It ignores the
// bot's own posts, other bots and Slack guests.
//
// Like the Zulip listener, it pulls bloom-team-skills before each answer and every two minutes
// while idle, and exits once no message is in hand when bloom-bot/ differs from the code it
// started on, so launchd restarts it on the new code.
//
// The Slack app needs Socket Mode on (SLACK_APP_TOKEN, connections:write), the bot event
// message.groups (add message.channels to be reachable in public channels too), and the bot scopes
// chat:write, groups:history (channels:history for public channels), users:read and
// reactions:write.

import path from "node:path";
import {
    BOT_TOOLS, CLAUDE_TIMEOUT_MINUTES, MODEL_NAME, SLACK_STATUS_CHANNEL_ID, TEAM_SKILLS,
    budgetBlock, log, makeRunDir, notify, postToSlack, pullTeamSkills, removeRunDir, runClaude, slack, writeStatus,
} from "./bot-runtime.mjs";

const SKILL = path.join(TEAM_SKILLS, "answer-zulip-mention", "SKILL.md");
const CONTEXT_MESSAGES = 20;
const IDLE_PULL_MS = 2 * 60_000;
// How often the status file is refreshed while connected, for health.mjs's staleness check.
const STATUS_MS = 5 * 60_000;

if (!process.env.SLACK_APP_TOKEN) throw new Error("SLACK_APP_TOKEN is not in ~/.config/bloom-bot/env");
const { user_id: botUserId } = await slack("auth.test", {});

// Reading the channel and its writers needs scopes that posting does not. Without them, say so
// (at most daily) and wait before exiting, so launchd's restarts don't spin every 30 seconds.
try {
    await slack("conversations.history", { channel: SLACK_STATUS_CHANNEL_ID, limit: 1 });
    await slack("users.info", { user: botUserId });
} catch (error) {
    writeStatus("slack", false, error.message);
    log(`can't read the channel: ${error.message}`);
    await notify(`The Slack listener can't read #bloom-bot-status (${error.message}). The Slack app needs the bot scopes groups:history (or channels:history) and users:read, then a reinstall.`, "slack-scopes");
    await new Promise((resolve) => setTimeout(resolve, 10 * 60_000));
    process.exit(1);
}

// Slack user id -> { name, guest, bot }
const users = new Map();
/** Looks up a Slack user once and remembers them. */
async function user(id) {
    if (!users.has(id)) {
        const { user: u } = await slack("users.info", { user: id });
        users.set(id, {
            name: u.real_name || u.profile?.real_name || u.name,
            guest: u.is_restricted || u.is_ultra_restricted,
            bot: u.is_bot,
        });
    }
    return users.get(id);
}

/** Renders the messages before this one in its thread, or in the channel when it starts no
 * thread, then this one, as Markdown. */
async function readConversation(event) {
    let before;
    if (event.thread_ts) {
        const { messages } = await slack("conversations.replies", { channel: event.channel, ts: event.thread_ts, limit: CONTEXT_MESSAGES + 1 });
        before = messages.filter((m) => m.ts !== event.ts).slice(-CONTEXT_MESSAGES);
    } else {
        const { messages } = await slack("conversations.history", { channel: event.channel, latest: event.ts, inclusive: false, limit: CONTEXT_MESSAGES });
        before = messages.reverse();
    }
    const parts = [];
    for (const m of [...before, event]) {
        const who = m.user ? (await user(m.user)).name : (m.bot_profile?.name || m.username || "a bot");
        parts.push(`### ${who}, ${new Date(Number(m.ts) * 1000).toISOString()}\n\n${m.text || ""}`);
    }
    return parts.join("\n\n");
}

// What the run is told about where the message is, by the reason it is being answered.
const WHERE = {
    "its channel": "wrote in your Slack channel, #bloom-bot-status, where every message is for you without a mention.",
    "a mention": "mentioned you in a Slack channel.",
    "its thread": "wrote in a Slack thread that you are part of, where they are the only person; their message is for you.",
    listening: [
        "wrote in a Slack thread that you are part of, with other people in it. Take part as a person",
        "in the conversation would: reply when the message is addressed to you, asks something you can",
        "answer, or says something about Bloom that is wrong. When people are talking to each other",
        "and you have nothing to add, stay quiet: end with an `=== OUTPUT ===` line and nothing after",
        "it, and nothing is posted.",
    ].join(" "),
};

/** Answers one message in its thread, replying with a short failure note if the run fails. */
async function answer(event, sender, why) {
    const thread = { thread_ts: event.thread_ts || event.ts };
    const blocked = await budgetBlock();
    if (blocked) {
        log(blocked);
        await postToSlack(event.channel, `Sorry, I can't answer right now. ${blocked} Ask me again after that.`, thread);
        return;
    }
    log(`answering ${sender.name} (${why})`);
    // :eyes: says "I'm answering you"; while only listening, the bot may not answer at all.
    const react = why !== "listening";
    if (react) await slack("reactions.add", { channel: event.channel, timestamp: event.ts, name: "eyes" }).catch(() => {});
    let dir;
    try {
        if (pullTeamSkills()) restartWanted = true;
        dir = makeRunDir(`slack-${event.ts.replace(".", "-")}`);
        const task = [
            `The helper is \`node ${BOT_TOOLS}\`. The attribution line for anything you write on YouTrack is`,
            `\`[${MODEL_NAME} on the Bloom bot Mac, asked by ${sender.name} on Slack]\`.`,
            `${sender.name} ${WHERE[why]}`,
            "Their message is the last one below. Your reply goes in that message's thread.",
            "",
            "<conversation>",
            await readConversation(event),
            "</conversation>",
        ].join("\n");
        const text = await runClaude({ cwd: dir, skillFile: SKILL, task, label: `Slack (${why})` });
        if (!text && why === "listening") {
            log("stayed quiet");
            return;
        }
        await postToSlack(event.channel, text, thread);
        log("answered");
    } catch (error) {
        log(`failed: ${error.stack}`);
        await notify(`The bot failed to answer ${sender.name} in Slack:\n\`\`\`\n${error.message.slice(0, 1500)}\n\`\`\``);
        const apology = error.timedOut
            ? `Sorry, I ran out of time on that (a run is stopped after ${CLAUDE_TIMEOUT_MINUTES} minutes). The developers have been told.`
            : "Sorry, I failed to answer that. The developers have been told.";
        await postToSlack(event.channel, apology, thread).catch(() => {});
    } finally {
        if (dir) removeRunDir(dir);
        if (react) await slack("reactions.remove", { channel: event.channel, timestamp: event.ts, name: "eyes" }).catch(() => {});
    }
}

/**
 * Why the bot should take this message up, or null to drop it:
 *   "its channel"  a new message (not a thread reply) in #bloom-bot-status;
 *   "a mention"    the message mentions the bot;
 *   "its thread"   a reply in a thread the bot is part of, where the sender is the only person:
 *                  everything they say is for the bot;
 *   "listening"    a reply in a thread the bot is part of, with more than one person in it: the
 *                  bot replies only when it has something to add.
 * The bot is part of a thread in #bloom-bot-status, and of one elsewhere where it has replied.
 * Its own post that starts a thread doesn't count, so a nightly summary alone doesn't draw it in.
 */
async function reason(event) {
    if ((event.text || "").includes(`<@${botUserId}>`)) return "a mention";
    const isReply = event.thread_ts && event.thread_ts !== event.ts;
    if (!isReply) return event.channel === SLACK_STATUS_CHANNEL_ID ? "its channel" : null;
    const { messages } = await slack("conversations.replies", { channel: event.channel, ts: event.thread_ts, limit: 200 });
    const botIsIn = event.channel === SLACK_STATUS_CHANNEL_ID || messages.some((m) => m.ts !== event.thread_ts && m.user === botUserId);
    if (!botIsIn) return null;
    const people = new Set([...messages, event].filter((m) => m.user && m.user !== botUserId && !m.bot_id).map((m) => m.user));
    return people.size === 1 ? "its thread" : "listening";
}

/** Decides whether an event is a person's new message for the bot, and answers it if so. */
async function handle(event) {
    // A subtype marks edits, deletions, joins and bot posts; a person's new message has none.
    if (event.type !== "message" || event.subtype || event.bot_id || !event.user || event.user === botUserId) return;
    const why = await reason(event);
    if (!why) return;
    const sender = await user(event.user);
    if (sender.guest || sender.bot) {
        log(`ignored a message from ${sender.name}, who is a guest or a bot`);
        return;
    }
    log(`message for the bot (${why}) in ${event.channel} from ${sender.name}`);
    await answer(event, sender, why);
}

let restartWanted = false;
let lastPull = Date.now();
// The chain of answers still to give, and how many messages are on it or being answered.
let answering = Promise.resolve();
let messagesInHand = 0;
// Slack resends an event it thinks was not acknowledged; each message is answered once.
const seen = new Set();

/** Exits for a restart on new code once nothing is in hand. */
function restartIfWanted() {
    if (restartWanted && messagesInHand === 0) {
        log("bloom-bot/ changed; exiting so launchd restarts on the new code");
        process.exit(0);
    }
}

setInterval(() => {
    if (messagesInHand === 0 && Date.now() - lastPull > IDLE_PULL_MS) {
        lastPull = Date.now();
        try {
            if (pullTeamSkills()) restartWanted = true;
        } catch (error) {
            log(`pull: ${error.message}`);
        }
    }
    restartIfWanted();
}, 30_000);

/** Opens one Socket Mode connection and resolves when Slack or the network closes it. */
async function connect() {
    // apps.connections.open takes the app-level token, not the bot token that slack() uses.
    const response = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST", signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${process.env.SLACK_APP_TOKEN}` },
    });
    const opened = await response.json();
    if (!opened.ok) throw new Error(`Slack apps.connections.open: ${opened.error}`);
    const socket = new WebSocket(opened.url);
    let statusTimer;
    await new Promise((resolve) => {
        socket.addEventListener("message", (message) => {
            const envelope = JSON.parse(message.data);
            if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            if (envelope.type === "hello") {
                log("listening (Socket Mode)");
                writeStatus("slack", true);
                statusTimer = setInterval(() => writeStatus("slack", true), STATUS_MS);
            } else if (envelope.type === "disconnect") {
                socket.close();
            } else if (envelope.type === "events_api") {
                const event = envelope.payload.event;
                const key = event.client_msg_id || `${event.channel}/${event.ts}`;
                if (seen.has(key)) return;
                seen.add(key);
                // Answer in the background, one message at a time, so the socket keeps acknowledging
                // events while a Claude run takes its minutes.
                messagesInHand++;
                answering = answering
                    .then(() => handle(event))
                    .catch((error) => log(`handling message ${event.ts}: ${error.stack}`))
                    .finally(() => { messagesInHand--; restartIfWanted(); });
            }
        });
        socket.addEventListener("close", resolve);
        socket.addEventListener("error", (error) => log(`socket: ${error.message ?? error.type}`));
    });
    clearInterval(statusTimer);
}

for (;;) {
    try {
        await connect();
        log("connection closed; reconnecting");
    } catch (error) {
        writeStatus("slack", false, error.message);
        log(`connect: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
}
