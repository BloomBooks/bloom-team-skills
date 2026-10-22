// Prints the latest messages in a Zulip channel and topic, as the bot sees them. For whoever is
// maintaining the bot, so they can read what it posted without someone pasting it to them.
//
//   node read-zulip.mjs ["<channel>" ["<topic>" [<count>]]]    defaults: "bot testing", any topic, 20

import { zulipCredentials } from "./bot-runtime.mjs";

const [channel = "bot testing", topic, count = "20"] = process.argv.slice(2);
const zulip = zulipCredentials();
const narrow = [{ operator: "channel", operand: channel }];
if (topic) narrow.push({ operator: "topic", operand: topic });
const params = new URLSearchParams({
    anchor: "newest", num_before: count, num_after: "0", apply_markdown: "false", narrow: JSON.stringify(narrow),
});
const response = await fetch(`${zulip.site}/api/v1/messages?${params}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${zulip.email}:${zulip.key}`).toString("base64")}` },
    signal: AbortSignal.timeout(60_000),
});
const json = await response.json();
if (json.result !== "success") throw new Error(`Zulip: ${json.msg}`);
for (const m of json.messages) {
    console.log(`--- ${new Date(m.timestamp * 1000).toISOString()} ${m.sender_full_name} > ${m.subject}\n${m.content}`);
}
