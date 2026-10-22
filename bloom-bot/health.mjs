// Hourly check that the bot can still do its jobs (see com.bloom.bot.health.plist): disk space,
// each token, and whether each job's last run succeeded. Problems go to Zulip at most once a day
// each, through bot-runtime's notify().

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { log, notify, readStatuses, runJob } from "./bot-runtime.mjs";

const MIN_FREE_GIB = 5;
// A job whose last success is older than this has stopped working, even if no run reported an
// error (launchd stopped starting it, or it hangs).
const STALE_MS = { youtrack: 30 * 60 * 1000 };

/** Fails with the service's reply unless a GET with this bearer token succeeds. */
async function checkToken(name, url, token) {
    if (!token) return `${name}: no token in ~/.config/bloom-bot/env`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${token}` } });
    return response.ok ? null : `${name}: ${response.status} ${(await response.text()).slice(0, 200)}`;
}

await runJob("health", async () => {
    const problems = [];

    const { bavail, bsize } = fs.statfsSync(os.homedir());
    const freeGiB = (bavail * bsize) / 1024 ** 3;
    if (freeGiB < MIN_FREE_GIB) problems.push(["disk", `only ${freeGiB.toFixed(1)} GiB of disk free`]);

    for (const [kind, problem] of [
        ["token:youtrack", await checkToken("YouTrack token",
            "https://issues.bloomlibrary.org/youtrack/api/users/me?fields=login", process.env.YOUTRACK_BOT)],
        ["token:sentry", await checkToken("Sentry token",
            "https://sentry.io/api/0/organizations/bloom-app/", process.env.SENTRY_BOT_TOKEN)],
    ]) {
        if (problem) problems.push([kind, problem]);
    }
    try {
        const reply = execFileSync("claude", ["-p", "--model", "haiku", "Reply with just: ok"],
            { encoding: "utf8", input: "", timeout: 120000 });
        if (!/ok/i.test(reply)) problems.push(["token:claude", `Claude replied: ${reply.slice(0, 200)}`]);
    } catch (error) {
        problems.push(["token:claude", `Claude failed: ${String(error.stderr || error.message).slice(0, 300)}`]);
    }

    for (const [job, status] of Object.entries(readStatuses())) {
        if (job === "health") continue;
        if (status.error) problems.push([`job:${job}`, `the ${job} job's last run failed: ${status.error.slice(0, 300)}`]);
        const stale = STALE_MS[job];
        if (stale && Date.now() - Date.parse(status.lastSuccess ?? 0) > stale) {
            problems.push([`stale:${job}`, `the ${job} job hasn't succeeded since ${status.lastSuccess ?? "it was set up"}`]);
        }
    }

    for (const [kind, problem] of problems) {
        log(problem);
        await notify(`Bot health check: ${problem}`, kind);
    }
    if (problems.length === 0) log("healthy");
});
