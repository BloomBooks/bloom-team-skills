// Checks a bot fix on the Mac, as the macOS account bloom-tests: compiles Bloom's C#, or runs named
// vitest files. Those run code from the branch (tests, and the repo's MSBuild steps), and
// bloom-tests cannot read John's home folder, where the bot's tokens are. John's account runs
// commands as bloom-tests through one sudoers rule (/etc/sudoers.d/bloom-tests).
//
// The fix lives in a BloomDesktop worktree that bloom-tests cannot read, so each check sends it
// the worktree's changes as a patch against master, and bloom-tests applies it to its own clone
// (~bloom-tests/BloomDesktop, which has its own node_modules, lib/dotnet and .NET SDK).
//
//   node bot-checks.mjs compile               from the folder holding ./BloomDesktop
//   node bot-checks.mjs vitest <file>...      paths relative to src/BloomBrowserUI

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_USER = "bloom-tests";
const MAX_PRINT_CHARS = 20_000;

/** Returns the commit on master that the worktree's changes are measured from, and those changes
 * (committed or not, tracked or new) as one binary patch. */
function changesSinceMaster(repoDir) {
    const git = (...args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const base = git("merge-base", "HEAD", "origin/master").trim();
    git("add", "-A");
    const patch = git("diff", "--cached", "--binary", base);
    git("reset", "-q");
    return { base, patch };
}

/** Runs a zsh script as bloom-tests, in its BloomDesktop clone reset to `base` with `patch`
 * applied, and returns { status, output }. */
function runAsTestUser(repoDir, script) {
    const { base, patch } = changesSinceMaster(repoDir);
    const setup = [
        "set -e",
        "export PATH=$HOME/node/bin:$HOME/.dotnet:$PATH DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1",
        "cd $HOME/BloomDesktop",
        // Undo the last check's patch (and pnpm's rewrites of pnpm-workspace.yaml); ignored
        // folders such as node_modules, lib and output stay.
        "git checkout -q -- . && git clean -fdq",
        `git cat-file -e ${base}^{commit} 2>/dev/null || git fetch -q origin`,
        `git checkout -q --detach ${base}`,
        "patch=$(cat); if [ -n \"$patch\" ]; then printf '%s\\n' \"$patch\" | git apply --binary --whitespace=nowarn; fi",
        "set +e",
    ].join("\n");
    // sudo starts in this process's folder, which bloom-tests may not be able to enter.
    const result = spawnSync("sudo", ["-n", "-u", TEST_USER, "-H", "/bin/zsh", "-c", `${setup}\n${script}`],
        { cwd: "/tmp", input: patch, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const output = `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    return { status: result.status, output };
}

/** Keeps the end of long output, which is where a build or test run says how it went. */
function tail(text) {
    return text.length > MAX_PRINT_CHARS ? `... (start cut)\n${text.slice(-MAX_PRINT_CHARS)}` : text;
}

/** Compiles BloomTests, which builds BloomExe too, and returns { ok, report }. */
export function compileCSharp(repoDir) {
    const { status, output } = runAsTestUser(repoDir,
        "dotnet build src/BloomTests/BloomTests.csproj -p:EnableWindowsTargeting=true -v:q -nologo 2>&1");
    // MSBuild prints each error twice (as it happens and in the summary); once is enough.
    const errors = [...new Set(output.split("\n").filter((line) => /error [A-Z]+\d+/.test(line)))];
    const ok = status === 0;
    return { ok, report: ok ? "C# build succeeded" : `C# build FAILED\n${tail(errors.join("\n") || output)}` };
}

/** Runs vitest on the given files (relative to src/BloomBrowserUI) and returns { ok, report }. */
export function runVitest(repoDir, files) {
    if (files.length === 0) throw new Error("name at least one vitest file");
    for (const file of files) {
        if (!/^[\w./@-]+$/.test(file)) throw new Error(`unexpected characters in a file name: ${file}`);
    }
    const { status, output } = runAsTestUser(repoDir, [
        "cd src/BloomBrowserUI",
        // Only when the patch changed what to install; strict-dep-builds is off in bloom-tests'
        // pnpm config, because the macOS-only fsevents is not in the repo's allowBuilds list.
        "git diff --quiet HEAD -- package.json pnpm-lock.yaml || pnpm install --frozen-lockfile --reporter=silent",
        `pnpm exec vitest run ${files.join(" ")} 2>&1`,
    ].join("\n"));
    return { ok: status === 0, report: tail(output) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, ...args] = process.argv.slice(2);
    const repoDir = path.join(process.cwd(), "BloomDesktop");
    let result;
    if (command === "compile") {
        result = compileCSharp(repoDir);
    } else if (command === "vitest") {
        result = runVitest(repoDir, args);
    } else {
        console.error("usage: bot-checks.mjs compile | vitest <file>...");
        process.exit(1);
    }
    console.log(result.report);
    process.exit(result.ok ? 0 : 1);
}
