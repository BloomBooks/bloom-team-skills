#!/usr/bin/env node
// Keeps the bloom-team-skills clone current without anyone running /update-team-skills.
//
//   node auto-update.mjs            Claude Code's SessionStart hook runs this. If the clone has not
//                                   been updated today, it starts a detached copy with --now and
//                                   exits at once, so the session never waits for the network.
//   node auto-update.mjs --now      Pull and link, in the foreground. Prints what it did.
//   node auto-update.mjs --install  Add the SessionStart hook to ~/.claude/settings.json, and the
//                                   TEAM-AGENTS.md import to ~/.claude/CLAUDE.md.
//   node auto-update.mjs --pull     Only the pull (see pull()), even with uncommitted changes; for
//                                   /update-team-skills. Exit code 1 when it did not happen.
//
// The pull is `git pull --ff-only` on main, or a merge of origin/main into any other branch, and
// only when the clone has no uncommitted changes to tracked files: people edit skills in their
// clone, and this must never touch that work.
// Any skill folder that has no link in ~/.claude/skills gets one. A running Claude Code session
// notices changed and newly linked skills within a few seconds, so the session that started the
// pull gets the new text too.
// The dashboard service is then set up from the clone (orca-bloom-dashboard-plugin/install.mjs): its Claude
// Code hooks, the service itself, and its Orca plugin, which starts the service with Orca. Orca does not run the
// plugin until the developer approves its access, which /update-team-skills asks for.
// Each run also makes sure ~/.claude/CLAUDE.md imports this clone's TEAM-AGENTS.md.
//
// ~/.claude/bloom-team-skills-update.json records the last successful update day; each run's
// result is appended to ~/.claude/bloom-team-skills-update.log.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(scriptPath));
const claudeDir = path.join(os.homedir(), ".claude");
const skillsDir = path.join(claudeDir, "skills");
const stampFile = path.join(claudeDir, "bloom-team-skills-update.json");
const logFile = path.join(claudeDir, "bloom-team-skills-update.log");
const settingsFile = path.join(claudeDir, "settings.json");
const claudeMdFile = path.join(claudeDir, "CLAUDE.md");

const today = () => new Date().toISOString().slice(0, 10);

function updatedToday() {
    try {
        return JSON.parse(fs.readFileSync(stampFile, "utf8")).day === today();
    } catch {
        return false;
    }
}

function log(line) {
    const text = `${new Date().toISOString()} ${line}`;
    console.log(text);
    try {
        fs.appendFileSync(logFile, text + "\n");
    } catch {}
}

function git(...args) {
    const r = spawnSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || String(r.error ?? "") };
}

// On main, a fast-forward pull. On any other branch, origin/main merged into it, since the skills
// run from whatever this clone has checked out: a developer working on a skill in a branch here
// would otherwise run last week's versions of every other skill. A merge that conflicts is aborted,
// leaving the branch as it was. With uncommitted changes to tracked files, nothing is done unless
// `allowDirty` (a developer running /update-team-skills, whose git then refuses a merge that would
// touch those files); a background run must never touch work in progress.
function pull({ allowDirty = false } = {}) {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (!branch.ok) return { ok: false, msg: `not a git clone: ${branch.out}` };
    const dirty = git("status", "--porcelain", "--untracked-files=no");
    if (!dirty.ok) return { ok: false, msg: `git status failed: ${dirty.out}` };
    if (dirty.out && !allowDirty) return { ok: false, msg: "skipped pull: the clone has uncommitted changes" };
    if (branch.out !== "main") return mergeMain(branch.out);
    const before = git("rev-parse", "HEAD").out;
    const r = git("pull", "--ff-only", "--quiet");
    if (!r.ok) return { ok: false, msg: `pull failed: ${r.out.split("\n").slice(-2).join(" ")}` };
    const after = git("rev-parse", "HEAD").out;
    if (before === after) return { ok: true, msg: "already up to date" };
    const n = git("rev-list", "--count", `${before}..${after}`).out;
    return { ok: true, msg: `pulled ${n} commit(s), now ${after.slice(0, 9)}` };
}

function mergeMain(branch) {
    const fetched = git("fetch", "--quiet", "origin", "main");
    if (!fetched.ok) return { ok: false, msg: `fetch of main failed: ${fetched.out.split("\n").slice(-2).join(" ")}` };
    const n = git("rev-list", "--count", "HEAD..origin/main").out;
    if (n === "0") return { ok: true, msg: `on ${branch}, which already has everything in main` };
    const r = git("merge", "--no-edit", "--quiet", "origin/main");
    if (r.ok) return { ok: true, msg: `on ${branch}: merged ${n} commit(s) from main, now ${git("rev-parse", "HEAD").out.slice(0, 9)} (not pushed)` };
    const conflicts = git("diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
    if (conflicts.length) git("merge", "--abort");
    return {
        ok: false,
        msg: conflicts.length
            ? `on ${branch}: merging main conflicts in ${conflicts.join(", ")}, so the merge was undone and the branch lacks main's last ${n} commit(s)`
            : `on ${branch}: merging main failed: ${r.out.split("\n").slice(-2).join(" ")}`,
    };
}

function linkNewSkills() {
    const linked = [];
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const entry of fs.readdirSync(repo, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const target = path.join(repo, entry.name);
        if (!fs.existsSync(path.join(target, "SKILL.md"))) continue;
        const link = path.join(skillsDir, entry.name);
        let present = true;
        try {
            fs.lstatSync(link);
        } catch {
            present = false;
        }
        if (present) continue;
        try {
            // A junction needs neither Developer Mode nor an elevated shell; other systems ignore the type.
            fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
            linked.push(entry.name);
        } catch (e) {
            log(`could not link ${entry.name}: ${e.message}`);
        }
    }
    return linked;
}

// A link into this clone whose folder no longer holds a SKILL.md is left from a skill that a pull
// renamed or removed. Links that lead anywhere else are the developer's own and are left alone.
function unlinkGoneSkills() {
    const removed = [];
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        const link = path.join(skillsDir, entry.name);
        let target;
        try {
            target = path.resolve(skillsDir, fs.readlinkSync(link));
        } catch {
            continue; // not a link
        }
        const inside = path.relative(repo, target);
        if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || fs.existsSync(path.join(target, "SKILL.md"))) continue;
        try {
            // Removes the link itself, whether a junction or a symlink, and never what it leads to.
            fs.rmSync(link, { recursive: false, force: true });
            removed.push(entry.name);
        } catch (e) {
            log(`could not remove the link ${entry.name}: ${e.message}`);
        }
    }
    return removed;
}

// Run after the pull, so that the day's new version of the installer is the one that runs. Exit
// code 3 means that the Orca plugin waits for the developer's approval, which is not a failure.
function installDashboard() {
    const script = path.join(repo, "orca-bloom-dashboard-plugin", "install.mjs");
    if (!fs.existsSync(script)) return "";
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 120_000, windowsHide: true });
    if (r.error) return `dashboard not set up: ${r.error.message}`;
    const lines = `${r.stdout || ""}${r.stderr || ""}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return r.status === 0 || r.status === 3 ? `dashboard: ${lines.filter((l) => !l.startsWith("To approve")).join("; ")}` : `dashboard not set up: ${lines.at(-1) || "exit " + r.status}`;
}

// TEAM-AGENTS.md holds the rules that apply in every session, and Claude Code only loads it through
// an @-import in the developer's global CLAUDE.md. Adds that import when no line imports a
// TEAM-AGENTS.md yet; an existing one, wherever it points, is the developer's and is left alone.
// Returns what it did, or "" when the import was already there.
function ensureTeamAgentsImport() {
    let text = "";
    try {
        text = fs.readFileSync(claudeMdFile, "utf8");
    } catch (e) {
        if (e.code !== "ENOENT") return `could not read ${claudeMdFile}: ${e.message}`;
    }
    if (/^@\S*TEAM-AGENTS\.md\s*$/m.test(text)) return "";
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const gap = text === "" ? "" : text.endsWith(eol) ? eol : eol + eol;
    const line = `@${path.join(repo, "TEAM-AGENTS.md").replaceAll("\\", "/")}`;
    fs.writeFileSync(claudeMdFile, `${text}${gap}# Team-wide agent rules${eol}${eol}${line}${eol}`);
    return `added ${line} to ${claudeMdFile}`;
}

async function runNow() {
    const result = pull();
    const linked = linkNewSkills();
    const unlinked = unlinkGoneSkills();
    const imported = ensureTeamAgentsImport();
    const plugins = installDashboard();
    log(`${result.msg}${linked.length ? `; linked ${linked.join(", ")}` : ""}${unlinked.length ? `; removed the links of ${unlinked.join(", ")}` : ""}${imported ? `; ${imported}` : ""}${plugins ? `; ${plugins}` : ""}`);
    // A skipped or failed pull leaves the day unrecorded, so the next session tries again.
    if (result.ok) fs.writeFileSync(stampFile, JSON.stringify({ day: today() }) + "\n");
}

function hookCommand() {
    return `node "${scriptPath.replaceAll("\\", "/")}"`;
}

function install() {
    let settings = {};
    if (fs.existsSync(settingsFile)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
        } catch (e) {
            console.error(`${settingsFile} is not valid JSON, so the hook was not added: ${e.message}`);
            process.exit(1);
        }
    }
    settings.hooks ??= {};
    settings.hooks.SessionStart ??= [];
    const existing = settings.hooks.SessionStart.flatMap((g) => g.hooks ?? []).find((h) =>
        String(h.command ?? "").includes("update-team-skills/auto-update.mjs"),
    );
    const command = hookCommand();
    if (existing) {
        if (existing.command === command) {
            console.log("hook already installed");
            return;
        }
        existing.command = command;
        console.log(`hook updated: ${command}`);
    } else {
        settings.hooks.SessionStart.push({ hooks: [{ type: "command", command, timeout: 10 }] });
        console.log(`hook installed: ${command}`);
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
}

const arg = process.argv[2];
if (arg === "--install") {
    install();
    console.log(ensureTeamAgentsImport() || "TEAM-AGENTS.md import already in CLAUDE.md");
} else if (arg === "--now") {
    await runNow();
} else if (arg === "--pull") {
    const result = pull({ allowDirty: true });
    console.log(result.msg);
    process.exit(result.ok ? 0 : 1);
} else if (!updatedToday()) {
    spawn(process.execPath, [scriptPath, "--now"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
