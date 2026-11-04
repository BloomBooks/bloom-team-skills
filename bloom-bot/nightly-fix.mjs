// After the morning triage, has Claude fix the open nightly failures, each as a draft PR posted to
// Zulip and Slack for any developer to pick up. poll-nightly.mjs calls fixNightlies() once its
// triage is done. The plan this follows is BloomDesktop's docs/bot-nightly-fixes/PLAN.md.
//
// For each PR: Claude, following BloomDesktop's nightly-fix skill, picks what to fix and changes a
// fresh worktree, checking C# and vitest on this Mac as bloom-tests (bot-checks.mjs). This script
// then commits to a bot/ branch, pushes it, and runs the named tests on a GitHub Windows runner
// with the bot-verify workflow: on master first when the failure is flaky (it must fail there), and
// on the branch. A clean run becomes a draft PR. A failing one goes back to Claude once; after
// that, or when master would not fail, the bot posts what it found and deletes the branch.
//
// Claude never pushes, opens PRs or starts workflows; this script does, and only on bot/ branches,
// the bot-verify workflow and draft PRs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
    BOT_DIR, BOT_TOOLS, MODEL_NAME,
    budgetBlock, log, makeRunDir, postToSlack, postToZulip, removeRunDir, runClaude,
} from "./bot-runtime.mjs";
import { compileCSharp } from "./bot-checks.mjs";
import {
    REPO, deleteBranch, dispatchVerify, freeBranchName, gh, openDraftPr, pushBranch, refuseDependencyChanges, refuseWorkflowChanges, totals, verifyResults,
} from "./bot-github.mjs";

const DOC = "docs/nightly-failures/README.md";
const SKILL = ".claude/skills/nightly-fix/SKILL.md";
const BOT_CHECKS = path.join(BOT_DIR, "bot-checks.mjs");
const ZULIP_CHANNEL = "developers";
const ZULIP_TOPIC = "Nightly run";
const SLACK_CHANNEL_ID = "C0CE75BEJTU"; // #bloom-team-developers
// A morning's ceiling on PRs, whatever the budget says, so one bad morning can't flood the channel.
const MAX_PRS_PER_MORNING = 3;
const REPEAT = 10;
const EFFORT = "high";
const TIMEOUT_MINUTES = 60;

const gitIn = (repoDir) => (args, input) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", input });

/** The open PRs on bot/ branches, as "#123 bot/x: title" lines, for Claude to leave alone. */
function openBotPrs() {
    const prs = JSON.parse(gh(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
        "--json", "number,headRefName,title,url"]));
    return prs.filter((pr) => pr.headRefName.startsWith("bot/")).map((pr) => `#${pr.number} ${pr.headRefName}: ${pr.title} (${pr.url})`);
}

/** What the bot is told on top of BOT.md and the nightly-fix skill. */
function fixTask({ repoDir, botPrs, takenThisMorning, retry }) {
    const common = `## This job

You are running the nightly-fix skill unattended, as the Bloom bot, on a Mac that cannot run Bloom.
BloomDesktop's master is checked out at ${repoDir}; make your change there (you may Edit and Write any
file under it, and nowhere else, so write no helper scripts of your own: use Grep and Read to dig through
logs and traces). Your result becomes a draft PR that any developer may pick up; nobody is waiting on you.

Tools, instead of what the skill assumes:
- The helper \`node ${BOT_TOOLS}\` reads runs and artifacts: \`nightly-runs\`, \`run <id>\`, \`run-log <id>\`,
  \`run-artifact <id> <name>\` (unzips Playwright traces), \`pr <number>\`.
- \`node ${BOT_CHECKS} compile\` compiles the C# with your change; \`node ${BOT_CHECKS} vitest <files>\` runs
  vitest files (paths relative to src/BloomBrowserUI). Run them from ${path.dirname(repoDir)}.
- E2E, visual regression, C# unit and React component tests run on a GitHub Windows runner after you
  finish: name them in your result and the job runs them, ${REPEAT} times for a flaky failure.

Open PRs on bot/ branches (leave what they cover alone):
${botPrs.length ? botPrs.join("\n") : "(none)"}
${takenThisMorning.length ? `\nAlready taken this morning by an earlier run of this job:\n${takenThisMorning.join("\n")}\n` : ""}`;

    const retryText = retry ? `
## Your first fix did not hold

You made the change that is in the worktree now. The tests the job ran on Windows reported:

${retry.summary}

The full results, including any Playwright report and traces, are in ${retry.resultsDir}. Find out
why, and change the worktree so the fix holds. This is the last try.
` : "";

    return `${common}${retryText}
## Your result

After \`=== OUTPUT ===\`, give exactly one JSON object and nothing else:

{
  "action": "fix" | "findings" | "none",
  "slug": "a few lowercase words joined by hyphens, naming what it fixes (for the bot/ branch)",
  "title": "PR title, a plain sentence",
  "entries": ["the doc headings this addresses, exactly as written"],
  "kind": "deliberate-change" | "flaky" | "bug",
  "changesExistingTests": true | false,
  "body": "the PR description in Markdown: the skill's report. When changesExistingTests is true it must start with what the tests checked before and after and why the tests were wrong. Say which tests prove the fix, but no results: you have run none of the Windows tests, and the job adds a Proof section with what they did",
  "post": "two or three plain sentences for the team channel: what failed, the cause, what the PR does",
  "verify": {
    "e2e_specs": "space-separated paths under src/BloomE2E/tests, or empty",
    "visual_specs": "a vitest test-name pattern for src/BloomVisualRegressionTests, or empty",
    "csharp_filter": "a dotnet test --filter expression for BloomTests, or empty",
    "component_specs": "space-separated component-tester filters, or empty"
  }
}

"none" means nothing is left to fix (every open entry is covered); only "action" is needed then.
"findings" means you could not fix it: fill "entries", "title" and "post", and put what you found in "body".
For "fix", "verify" must name at least one test unless "kind" is "deliberate-change" and vitest covers it.`;
}

/** Reads Claude's JSON result. */
function parseResult(text) {
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
        return JSON.parse(json);
    } catch (error) {
        throw new Error(`Claude's result is not JSON (${error.message}): ${text.slice(0, 500)}`);
    }
}

/** True when the result names any test for the Windows runner. */
function hasWindowsTests(result) {
    return Object.values(result.verify ?? {}).some((value) => String(value).trim());
}

/** Posts to the nightly's Zulip topic and Slack channel; both are tried even if one fails. */
async function post(message) {
    const failures = [];
    await postToZulip(ZULIP_CHANNEL, ZULIP_TOPIC, message).catch((error) => failures.push(`Zulip: ${error.message}`));
    await postToSlack(SLACK_CHANNEL_ID, message).catch((error) => failures.push(`Slack: ${error.message}`));
    if (failures.length) throw new Error(`posting failed: ${failures.join("; ")}`);
}

/** Commits the worktree to `branch`, after checking that the C# still compiles. */
function commitFix(repoDir, branch, result, attempt) {
    const git = gitIn(repoDir);
    const compiled = compileCSharp(repoDir);
    if (!compiled.ok) throw new Error(`Claude's fix does not compile:\n${compiled.report}`);
    if (attempt === 1) git(["checkout", "-q", "-b", branch]);
    git(["add", "-A"]);
    git(["commit", "-q", "-F", "-"],
        `${result.title}\n\n[${MODEL_NAME} from Hatton's machine during nightly-fix]\n\nFixes the nightly failure(s): ${result.entries.join("; ")}.\n`);
    refuseWorkflowChanges(repoDir, "origin/master");
    refuseDependencyChanges(repoDir, "origin/master", "HEAD");
}

/** Opens the draft PR and returns its URL. */
function openPr(branch, result, proof) {
    const parts = [`[${MODEL_NAME} from Hatton's machine during nightly-fix]`, result.body.trim()];
    if (proof) parts.push(`## Proof\n\n${proof}`);
    parts.push(`Nightly failures doc: [${DOC}](https://github.com/${REPO}/blob/master/${DOC})`);
    return openDraftPr({ branch, base: "master", title: result.title, body: parts.join("\n\n") });
}

/**
 * One PR's worth of work: a Claude session picks and fixes a piece of the doc, the fix is proved
 * on Windows, and becomes a draft PR or a post of what was found. Returns Claude's result, or null
 * when nothing was left to fix. In a test, stops after the Mac checks and prints the change.
 */
async function fixOne({ botPrs, takenThisMorning, test }) {
    const dir = makeRunDir(`nightly-fix-${takenThisMorning.length + 1}`);
    try {
        execFileSync("node", [BOT_TOOLS, "checkout", "BloomDesktop"], { cwd: dir, stdio: "ignore" });
        const repoDir = path.join(dir, "BloomDesktop");
        const skillFile = process.env.BLOOM_BOT_FIX_SKILL ?? path.join(repoDir, SKILL);
        const claude = (retry) => runClaude({
            cwd: dir, skillFile, test, effort: EFFORT, timeoutMinutes: TIMEOUT_MINUTES,
            task: fixTask({ repoDir, botPrs, takenThisMorning, retry }),
            label: "a nightly fix",
            writable: [`${repoDir}/**`],
            commands: [`node ${BOT_CHECKS}`],
        });

        const result = parseResult(await claude(null));
        if (result.action === "none") return null;
        if (result.action === "findings") {
            if (test) console.log(`=== findings ===\n${JSON.stringify(result, null, 1)}`);
            else await post(`[Bloom bot] Could not fix: ${result.title}\n${result.post}\n\n${result.body}`);
            return result;
        }
        if (test) {
            console.log(`=== result ===\n${JSON.stringify(result, null, 1)}\n=== diff ===\n${gitIn(repoDir)(["diff"])}`);
            console.log(`=== compile ===\n${compileCSharp(repoDir).report}`);
            return result;
        }

        const branch = freeBranchName(result.slug);
        const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
        let proof = "";
        if (!hasWindowsTests(result)) {
            commitFix(repoDir, branch, result, 1);
            pushBranch(repoDir, branch);
            proof = "Checked on the bot's Mac (C# compile, vitest); no Windows-only test is involved.";
        } else {
            const flaky = result.kind !== "deliberate-change";
            // On master, a flaky failure must show itself, or there is nothing to prove fixed.
            const masterRun = flaky
                ? await dispatchVerify("master", result.verify, { repeat: REPEAT, stopAtFirstFailure: true, label: `${branch} master ${stamp}` })
                : null;
            let fixSummary;
            for (let attempt = 1; ; attempt++) {
                commitFix(repoDir, branch, result, attempt);
                pushBranch(repoDir, branch);
                const fixRun = await dispatchVerify(branch, result.verify, {
                    repeat: flaky ? REPEAT : 1, stopAtFirstFailure: false, label: `${branch} fix ${attempt} ${stamp}`,
                });
                fixSummary = totals(await verifyResults(fixRun, path.join(dir, `verify-fix-${attempt}`)));
                if (fixSummary.failed === 0 && fixSummary.runs > 0 && fixSummary.problems.length === 0) break;
                if (attempt === 2) {
                    deleteBranch(repoDir, branch);
                    await post(`[Bloom bot] Could not fix: ${result.title}\nTwo tries failed on Windows:\n${fixSummary.text}\n\n${result.post}`);
                    return result;
                }
                const retried = parseResult(await claude({ summary: fixSummary.text, resultsDir: path.join(dir, `verify-fix-${attempt}`) }));
                if (retried.action !== "fix") {
                    deleteBranch(repoDir, branch);
                    await post(`[Bloom bot] Could not fix: ${result.title}\n${retried.post ?? result.post}\n\n${retried.body ?? ""}`);
                    return result;
                }
                Object.assign(result, retried);
            }
            if (masterRun) {
                const master = totals(await verifyResults(masterRun, path.join(dir, "verify-master")));
                if (master.problems.length > 0 && master.failed === 0) {
                    // Not a "could not reproduce": the tests never ran on master.
                    deleteBranch(repoDir, branch);
                    throw new Error(`the bot-verify run on master for ${branch} proved nothing:\n${master.text}`);
                }
                if (master.failed === 0) {
                    deleteBranch(repoDir, branch);
                    await post(`[Bloom bot] Could not reproduce: ${result.title}\nOn master, ${REPEAT} repeats of the tests all passed (${master.runs} test results), so there is nothing for a fix to prove. ${result.post}`);
                    return result;
                }
                // `runs` counts single test results, so a spec file of 13 tests repeated 10 times is 130.
                proof = `On master: a test failed within ${REPEAT} repeats of the tests (${master.failed} failed of ${master.runs} test results before the run stopped at the first failure).\n`
                    + `On this branch: every test passed in all ${REPEAT} repeats (${fixSummary.runs} test results).\n\n${fixSummary.text}`;
            } else {
                proof = `On this branch: every test passed (${fixSummary.runs} test results).\n\n${fixSummary.text}`;
            }
        }
        const url = openPr(branch, result, proof);
        log(`opened ${url}`);
        const flag = result.changesExistingTests ? " It changes what an existing test checks; see the top of the PR." : "";
        await post(`[Bloom bot] Draft PR for anyone to pick up: [${result.title}](${url})\n${result.post}${flag}`);
        return result;
    } finally {
        removeRunDir(dir);
    }
}

/** Fixes what it can of the open nightly failures, one PR at a time, while the budget allows. */
export async function fixNightlies({ test = false } = {}) {
    const takenThisMorning = [];
    for (let i = 0; i < MAX_PRS_PER_MORNING; i++) {
        if (await budgetBlock()) {
            log("stopping fixes: no budget left this week");
            return;
        }
        const result = await fixOne({ botPrs: openBotPrs(), takenThisMorning, test });
        if (!result) return;
        takenThisMorning.push(`${result.title} (${result.entries?.join("; ")})`);
        if (test) return;
    }
}
