// What the bot's jobs share for working with BloomDesktop on GitHub: pushing and deleting bot/
// branches, running chosen tests on a Windows runner with the bot-verify workflow and reading
// what they did, and opening draft PRs. nightly-fix.mjs, bot-checks.mjs (`windows`) and
// runClaude()'s PR requests use it. Everything here pushes only bot/ branches.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPO = "BloomBooks/BloomDesktop";
const VERIFY_TIMEOUT_MINUTES = 120;
const PUSH_CREDENTIALS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export const gh = (args, options = {}) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });

const pushUrl = (repo) => `https://github.com/${repo}.git`;

/** Throws when a change touches .github/: a workflow file on a pushed branch runs with the repo's
 * secrets, so the bot never pushes one. */
export function refuseWorkflowChanges(repoDir, base) {
    const files = execFileSync("git", ["-C", repoDir, "diff", "--name-only", base, "HEAD"], { encoding: "utf8" })
        .split("\n").filter((f) => f.startsWith(".github/"));
    if (files.length) throw new Error(`the bot does not push changes under .github/ (${files.join(", ")})`);
}

// Files that name dependencies. A bot change may not add or bump one: it could pick a typosquatted
// or compromised package even with no prompt injection, and lockfile diffs are easy to skim past.
// BloomDesktop's bot-pr-dependencies workflow fails a bot/ PR that changes them, as a second check.
const DEPENDENCY_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|packages\.config|Directory\.Packages\.props|NuGet\.config|[^/]+\.nuspec)$/i;

/** Throws when the change from `base` to `head` (a commit or a tree id, such as worktreeTree()'s)
 * touches a dependency: a dependency file, or a PackageReference line in a .csproj. */
export function refuseDependencyChanges(repoDir, base, head) {
    const diff = (...args) => execFileSync("git", ["-C", repoDir, "diff", base, head, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const files = diff("--name-only").split("\n").filter(Boolean);
    const named = files.filter((f) => DEPENDENCY_FILE.test(f));
    const csproj = files.filter((f) => /\.(cs|fs|vb)proj$|\.props$|\.targets$/i.test(f))
        .filter((f) => /^[+-].*PackageReference/m.test(diff("--", f)));
    const all = [...named, ...csproj];
    if (all.length) throw new Error(`the bot does not change dependencies (${all.join(", ")}); a person has to add or bump a package`);
}

/** Pushes HEAD of `repoDir` to a bot/ branch of `repo`, over whatever was there. */
export function pushBranch(repoDir, branch, repo = REPO) {
    if (!branch.startsWith("bot/")) throw new Error(`refusing to push ${branch}: the bot pushes only bot/ branches`);
    execFileSync("git", ["-C", repoDir, ...PUSH_CREDENTIALS, "push", "-q", "--force", pushUrl(repo), `HEAD:refs/heads/${branch}`]);
}

/** Pushes a commit (by id) to a bot/ branch of BloomDesktop without moving the worktree's HEAD. */
export function pushCommit(repoDir, commit, branch) {
    if (!branch.startsWith("bot/")) throw new Error(`refusing to push ${branch}: the bot pushes only bot/ branches`);
    execFileSync("git", ["-C", repoDir, ...PUSH_CREDENTIALS, "push", "-q", "--force", pushUrl(REPO), `${commit}:refs/heads/${branch}`]);
}

/** Deletes a bot/ branch of `repo`. */
export function deleteBranch(repoDir, branch, repo = REPO) {
    if (!branch.startsWith("bot/")) throw new Error(`refusing to delete ${branch}`);
    execFileSync("git", ["-C", repoDir, ...PUSH_CREDENTIALS, "push", "-q", pushUrl(repo), `:refs/heads/${branch}`], { stdio: "ignore" });
}

/** A branch name under bot/ that no branch of `repo` uses yet. */
export function freeBranchName(slug, repo = REPO) {
    const base = `bot/${slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "change"}`;
    const taken = new Set(gh(["api", `repos/${repo}/git/matching-refs/heads/bot/`, "--jq", ".[].ref"]).split("\n").map((r) => r.replace("refs/heads/", "")));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Starts bot-verify on `ref` with `tests` ({ e2e_specs, visual_specs, csharp_filter,
 * component_specs }) and returns its run id, found by the unique label it is given. */
export async function dispatchVerify(ref, tests, { repeat, stopAtFirstFailure, label }) {
    const inputs = { ...tests, repeat: String(repeat), stop_at_first_failure: String(stopAtFirstFailure), label };
    gh(["workflow", "run", "bot-verify.yml", "--repo", REPO, "--ref", ref,
        ...Object.entries(inputs).flatMap(([key, value]) => ["-f", `${key}=${value ?? ""}`])]);
    for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const runs = JSON.parse(gh(["run", "list", "--repo", REPO, "--workflow", "bot-verify.yml", "--limit", "20",
            "--json", "databaseId,displayTitle"]));
        const run = runs.find((r) => r.displayTitle === label);
        if (run) return run.databaseId;
    }
    throw new Error(`bot-verify run "${label}" did not appear within 5 minutes of being started`);
}

/** Waits for a bot-verify run, downloads its results to `dir`, and returns its summary.json. */
export async function verifyResults(runId, dir) {
    const deadline = Date.now() + VERIFY_TIMEOUT_MINUTES * 60 * 1000;
    for (;;) {
        const { status } = JSON.parse(gh(["run", "view", String(runId), "--repo", REPO, "--json", "status"]));
        if (status === "completed") break;
        if (Date.now() > deadline) throw new Error(`bot-verify run ${runId} took more than ${VERIFY_TIMEOUT_MINUTES} minutes`);
        await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    gh(["run", "download", String(runId), "--repo", REPO, "--name", "verify-results", "--dir", dir]);
    return JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
}

/** Totals a bot-verify summary: { runs, failed, problems, text } with a line per suite and failure.
 * `problems` lists suites whose tests never ran or never reported (a build failed, no test matched
 * the filter): such a run proves nothing either way. */
export function totals(summary) {
    let runs = 0;
    let failed = 0;
    const problems = [];
    const lines = [];
    for (const suite of summary.suites ?? []) {
        runs += suite.runs;
        failed += suite.failed;
        lines.push(`${suite.suite}: ${suite.passed} passed, ${suite.failed} failed, of ${suite.runs} runs`);
        if (suite.problem) {
            problems.push(`${suite.suite}: ${suite.problem}`);
            lines.push(`  problem: ${suite.problem}`);
        }
        for (const failure of suite.failures ?? []) lines.push(`  - ${failure.test}: ${failure.error}`);
    }
    return { runs, failed, problems, text: lines.join("\n") };
}

/** Opens a draft PR of `branch` on `repo` and returns its URL. */
export function openDraftPr({ repo = REPO, branch, base, title, body }) {
    const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-pr-")), "body.md");
    fs.writeFileSync(bodyFile, body);
    try {
        return gh(["pr", "create", "--repo", repo, "--draft", "--base", base, "--head", branch,
            "--title", title, "--body-file", bodyFile]).trim();
    } finally {
        fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
    }
}

/** The git tree id of a worktree's current files, committed or not (new files included), without
 * touching its index. Two states with the same files have the same tree id. */
export function worktreeTree(repoDir) {
    const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-index-")), "index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
        execFileSync("git", ["-C", repoDir, "read-tree", "HEAD"], { env });
        execFileSync("git", ["-C", repoDir, "add", "-A"], { env });
        return execFileSync("git", ["-C", repoDir, "write-tree"], { env, encoding: "utf8" }).trim();
    } finally {
        fs.rmSync(path.dirname(index), { recursive: true, force: true });
    }
}

/** Where bot-checks.mjs records the checks it ran on a run folder's BloomDesktop, by tree id, so
 * a PR made from the same files can show them as its proof. */
export const checksFile = (runDir) => path.join(runDir, ".verify", "checks.json");

/** Adds one check's result to the run folder's record. */
export function recordCheck(runDir, entry) {
    const file = checksFile(runDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    all.push({ ...entry, at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
}
