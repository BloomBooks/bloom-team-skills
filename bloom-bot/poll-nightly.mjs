// Triages each night's BloomDesktop nightly run. Runs on the bot's Mac every 15 minutes (see
// com.bloom.bot.nightly.plist). When a scheduled nightly on master has finished since the last
// one this job took on, it:
//   - checks out BloomDesktop's master and has Claude follow that repo's nightly-triage skill,
//     with permission to edit nothing but docs/nightly-failures/README.md;
//   - commits that doc to master, if Claude changed it;
//   - posts Claude's summary to Zulip (developers > Nightly run) and to Slack
//     (#bloom-team-developers).
//   - when FIXES_ENABLED, goes on to fix what it can of the open failures (nightly-fix.mjs).
// Each run is taken on once: the job records it before starting, so a triage that fails is
// reported to the maintainer, not retried every 15 minutes.
//
// To try it without committing, pushing or posting anything:
//   node poll-nightly.mjs --test <run id>     prints the doc's diff and the summary instead
//   node poll-nightly.mjs --test-fix          prints one fix's result, diff and compile instead
// (BLOOM_BOT_FIX_SKILL=<path> points --test-fix at a nightly-fix skill not yet on master.)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
    BOT_TOOLS, HOME_DIR, MODEL_NAME,
    budgetBlock, log, makeRunDir, postToSlack, postToZulip, removeRunDir, runClaude, runJob,
} from "./bot-runtime.mjs";
import { fixNightlies } from "./nightly-fix.mjs";

// Off until BloomDesktop's master has the bot-verify workflow and the nightly-fix skill.
const FIXES_ENABLED = false;
const REPO = "BloomBooks/BloomDesktop";
const PUSH_URL = `https://github.com/${REPO}.git`;
const DOC = "docs/nightly-failures/README.md";
const SKILL = ".claude/skills/nightly-triage/SKILL.md";
const STATE_FILE = path.join(HOME_DIR, "nightly.json");
const ZULIP_CHANNEL = "developers";
const ZULIP_TOPIC = "Nightly run";
// #bloom-team-developers, a private channel, which Slack wants named by id.
const SLACK_CHANNEL_ID = "C0CE75BEJTU";
// Several runs' logs and a trace or two take a while; the default for a short answer is too tight.
const EFFORT = "medium";
const TIMEOUT_MINUTES = 45;

/** Returns the newest scheduled nightly run on master, finished or not. */
function newestScheduledRun() {
    const runs = JSON.parse(execFileSync("gh", ["run", "list", "--repo", REPO, "--workflow", "nightly.yml",
        "--branch", "master", "--event", "schedule", "--limit", "1",
        "--json", "databaseId,status,conclusion,createdAt,url"], { encoding: "utf8" }));
    return runs[0];
}

/** Returns details of one run, for --test. */
function runById(id) {
    return JSON.parse(execFileSync("gh", ["run", "view", id, "--repo", REPO,
        "--json", "databaseId,status,conclusion,createdAt,url"], { encoding: "utf8" }));
}

/** What the bot is told on top of BOT.md and the skill: how its situation differs from a
 * developer's, which the skill is written for. */
function taskText(run, repoDir, docPath) {
    return `## This job

The scheduled nightly run ${run.url} (run id ${run.databaseId}, started ${run.createdAt}, ${run.conclusion}) has
finished. Follow the nightly-triage skill above for every nightly run since the doc's "Last updated" line,
which includes this one. You are running it unattended, as the Bloom bot, so these differ from what the skill
says:

- BloomDesktop's master is already checked out at ${repoDir}. The doc is ${docPath}. Edit it there with the
  Edit tool; it is the only file you can change. Read it first. Treat its "Last updated" line as the skill says,
  setting it to today, ${new Date().toISOString().slice(0, 10)}.
- You can't run gh. Use the helper instead (node ${BOT_TOOLS} <command>):
  - \`nightly-runs\` in place of \`gh run list\`;
  - \`run <id>\` in place of \`gh run view <id> --json jobs\`;
  - \`run-log <id>\` in place of \`gh run view <id> --log-failed\`. It already drops the [WebServer] lines and
    prints the failing parts; it saves the full log to a file you can Grep and Read;
  - \`run-artifact <id> <name>\` in place of \`gh run download\`. It unzips each trace.zip into a \`trace\`
    folder beside it, so you can Read test.trace, 0-trace.trace and 0-trace.network directly;
  - \`pr <number>\` for a PR's state, and \`youtrack\` (see above) for a card's.
  Don't delete what you download; the job removes the whole folder afterwards.
- Don't run post-to-zulip.ps1 and don't commit. The job commits the doc to master if you changed it, and
  posts your summary to Zulip and to Slack. So your output (after \`=== OUTPUT ===\`) is exactly the post
  that the skill's "Post a brief summary to Zulip" section describes, in its format, and nothing else.
- Nobody reads your report to the developer (the skill's last section). If something in the skill can't be
  done with your tools, or a step went wrong, say so in a maintainer note.
- Keep to the skill's "first look" depth. You have ${TIMEOUT_MINUTES} minutes in all.
- The bot also opens draft PRs that fix nightly failures, on bot/ branches. Open ones now:
${openBotPrLines() || "  (none)"}
  Treat these like any other PR in the doc: link each from the Status of the entries it fixes.`;
}

/** The open PRs on bot/ branches, one indented line each, for the triage to link. */
function openBotPrLines() {
    const prs = JSON.parse(execFileSync("gh", ["pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
        "--json", "number,headRefName,title,url"], { encoding: "utf8" }));
    return prs.filter((pr) => pr.headRefName.startsWith("bot/"))
        .map((pr) => `  - [#${pr.number}](${pr.url}) ${pr.title}`).join("\n");
}

/** Commits the doc to master and pushes it, rebasing onto a master that moved meanwhile, and
 * returns the commit's short hash. The bot's clones refuse to push, so this pushes to the URL with
 * gh's login. */
function commitAndPushDoc(repoDir, run) {
    const git = (args, input) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", input });
    const date = run.createdAt.slice(0, 10);
    git(["add", DOC]);
    git(["commit", "-q", "-F", "-"],
        `Triage the ${date} nightly\n\n[${MODEL_NAME} from Hatton's machine during nightly-triage]\n\nThe Bloom bot brought ${DOC} up to date through ${run.url}.\n`);
    const credentials = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
    for (let attempt = 1; ; attempt++) {
        git(["fetch", "-q", "origin", "master"]);
        try {
            git(["rebase", "-q", "origin/master"]);
        } catch (error) {
            git(["rebase", "--abort"]);
            throw new Error(`the doc change conflicts with a newer edit on master: ${error.message}`);
        }
        try {
            git([...credentials, "push", "-q", PUSH_URL, "HEAD:master"]);
            return git(["rev-parse", "--short", "HEAD"]).trim();
        } catch (error) {
            // Someone pushed between the fetch and the push; fetch again and retry.
            if (attempt === 3) throw error;
        }
    }
}

/** Posts the summary to Zulip and Slack. Both are tried even if one fails. */
async function post(summary, run) {
    const failures = [];
    try {
        await postToZulip(ZULIP_CHANNEL, ZULIP_TOPIC, summary);
    } catch (error) {
        failures.push(`Zulip: ${error.message}`);
    }
    try {
        await postToSlack(SLACK_CHANNEL_ID, summary);
    } catch (error) {
        failures.push(`Slack: ${error.message}`);
    }
    if (failures.length) throw new Error(`posting the triage failed: ${failures.join("; ")}`);
}

/** Triages one run. In a test, prints the doc diff and the summary instead of committing and
 * posting them. */
async function triage(run, test) {
    const dir = makeRunDir(`nightly-${run.databaseId}`);
    try {
        execFileSync("node", [BOT_TOOLS, "checkout", "BloomDesktop"], { cwd: dir, stdio: "ignore" });
        const repoDir = path.join(dir, "BloomDesktop");
        const docPath = path.join(repoDir, DOC);
        const summary = await runClaude({
            cwd: dir,
            skillFile: path.join(repoDir, SKILL),
            task: taskText(run, repoDir, docPath),
            label: `the nightly run ${run.url}`,
            test,
            effort: EFFORT,
            timeoutMinutes: TIMEOUT_MINUTES,
            writable: [docPath],
        });
        if (!summary) throw new Error(`Claude gave no summary for ${run.url}`);
        const changed = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" }).trim();
        // Trimmed, git's " M <path>" for a changed file starts with the M.
        if (changed && changed !== `M ${DOC}`) {
            throw new Error(`the triage changed more than ${DOC}:\n${changed}`);
        }
        if (test) {
            console.log(execFileSync("git", ["-C", repoDir, "diff"], { encoding: "utf8" }) || "(the doc is unchanged)");
            console.log(`=== summary ===\n${summary}`);
            return;
        }
        let commitError;
        if (changed) {
            try {
                log(`committed ${commitAndPushDoc(repoDir, run)} to master`);
            } catch (error) {
                commitError = error;
            }
        }
        await post(summary, run);
        if (commitError) throw new Error(`the triage was posted, but its doc change was not committed: ${commitError.message}`);
    } finally {
        removeRunDir(dir);
    }
}

if (process.argv[2] === "--test") {
    await triage(runById(process.argv[3]), true);
} else if (process.argv[2] === "--test-fix") {
    await fixNightlies({ test: true });
} else {
    await runJob("nightly", async () => {
        const run = newestScheduledRun();
        if (!run || run.status !== "completed") return;
        const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : null;
        if (!state) {
            // A new install starts from the next night, not with whatever happens to be the latest.
            fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRunId: run.databaseId }));
            log(`starting after run ${run.databaseId}`);
            return;
        }
        if (run.databaseId <= state.lastRunId) return;
        if (await budgetBlock()) return;
        fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRunId: run.databaseId }));
        log(`triaging ${run.url}`);
        await triage(run, false);
        log(`triaged ${run.url}`);
        if (FIXES_ENABLED) await fixNightlies();
    });
}
