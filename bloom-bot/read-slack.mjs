// Prints the latest messages in the bot's Slack channel, #bloom-bot-status, with each thread's
// replies, as the bot sees them. For whoever is maintaining the bot, so they can read what it
// posted without someone pasting it to them.
//
//   node read-slack.mjs [<count>]    default 20

import { SLACK_STATUS_CHANNEL_ID, slack } from "./bot-runtime.mjs";

const count = process.argv[2] ?? "20";
const names = new Map();
/** A message's writer: the person's name, or the bot's. */
async function who(m) {
    if (!m.user) return m.bot_profile?.name || m.username || "a bot";
    if (!names.has(m.user)) names.set(m.user, (await slack("users.info", { user: m.user })).user.real_name);
    return names.get(m.user);
}
const line = async (m, indent) => `${indent}--- ${new Date(Number(m.ts) * 1000).toISOString()} ${await who(m)}\n${indent}${(m.text || "").replace(/\n/g, `\n${indent}`)}`;

const { messages } = await slack("conversations.history", { channel: SLACK_STATUS_CHANNEL_ID, limit: count });
for (const m of messages.reverse()) {
    console.log(await line(m, ""));
    if (m.reply_count) {
        const { messages: replies } = await slack("conversations.replies", { channel: SLACK_STATUS_CHANNEL_ID, ts: m.ts });
        for (const r of replies.slice(1)) console.log(await line(r, "    "));
    }
}
