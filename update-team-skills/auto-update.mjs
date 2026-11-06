#!/usr/bin/env node
// Keeps the bloom-team-skills clone current without anyone running /update-team-skills.
//
//   node auto-update.mjs            Claude Code's SessionStart hook runs this. If the clone has not
//                                   been updated today, it starts a detached copy with --now and
//                                   exits at once, so the session never waits for the network.
//   node auto-update.mjs --now      Pull and link, in the foreground. Prints what it did.
//   node auto-update.mjs --install  Add the SessionStart hook to ~/.claude/settings.json.
//
// The pull is `git pull --ff-only`, and only when the clone is on main with no uncommitted changes
// to tracked files: people edit skills in their clone, and this must never touch that work.
// Any skill folder that has no link in ~/.claude/skills gets one. A running Claude Code session
// notices changed and newly linked skills within a few seconds, so the session that started the
// pull gets the new text too.
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

function pull() {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (!branch.ok) return { ok: false, msg: `not a git clone: ${branch.out}` };
    if (branch.out !== "main") return { ok: false, msg: `skipped pull: the clone is on ${branch.out}, not main` };
    const dirty = git("status", "--porcelain", "--untracked-files=no");
    if (!dirty.ok) return { ok: false, msg: `git status failed: ${dirty.out}` };
    if (dirty.out) return { ok: false, msg: "skipped pull: the clone has uncommitted changes" };
    const before = git("rev-parse", "HEAD").out;
    const r = git("pull", "--ff-only", "--quiet");
    if (!r.ok) return { ok: false, msg: `pull failed: ${r.out.split("\n").slice(-2).join(" ")}` };
    const after = git("rev-parse", "HEAD").out;
    if (before === after) return { ok: true, msg: "already up to date" };
    const n = git("rev-list", "--count", `${before}..${after}`).out;
    return { ok: true, msg: `pulled ${n} commit(s), now ${after.slice(0, 9)}` };
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

function runNow() {
    const result = pull();
    const linked = linkNewSkills();
    log(`${result.msg}${linked.length ? `; linked ${linked.join(", ")}` : ""}`);
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
} else if (arg === "--now") {
    runNow();
} else if (!updatedToday()) {
    spawn(process.execPath, [scriptPath, "--now"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
