#!/usr/bin/env node
// Sets up the dashboard service on this machine, from this checkout. Safe to run again: each step
// replaces what an earlier run made.
//
//   node install.mjs               1. Claude Code hooks in ~/.claude/settings.json that tell the
//                                     service what each session is doing (HOOKS below)
//                                  2. the service itself, started now when Orca runs (replacing
//                                     one that runs from another checkout)
//                                  3. the Bloom plugin loaded into Orca (../orca-plugins.mjs),
//                                     which starts the service whenever Orca runs
//   node install.mjs --approve     the same, and approves the access the Orca plugin asks for
//   node install.mjs --no-plugin   steps 1 and 2 only (orca-plugins.mjs runs this before it loads
//                                  the plugin)
//   node install.mjs --uninstall   removes the hooks and stops the service
//
// update-team-skills and its daily auto-update run this, so a pull that changes any of it takes
// effect without the developer doing anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORIGIN, dataDir, dataFile, serviceKey, readJsonFile } from "./env.mjs";

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const settingsFile = path.join(os.homedir(), ".claude", "settings.json");

// The hook events the service listens to. Each is an HTTP hook, which starts no process and which
// Claude Code treats as a non-blocking error when the service is not running. `matcher` narrows
// the two tool events to the tools that matter: the Skill tool (a skill that the model invokes),
// and the tools that can change files (after which the service reads git in that worktree).
export const HOOKS = [
  { event: "UserPromptSubmit" },
  { event: "UserPromptExpansion" },
  { event: "PreToolUse", matcher: "Skill" },
  { event: "PostToolUse", matcher: "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit" },
  { event: "Stop" },
  { event: "StopFailure" },
  { event: "Notification" },
  { event: "SessionEnd" },
];
// A hook of ours, by its address or its script, so that a later run finds and replaces it.
const isOurs = h => (h.type === "http" && /^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(h.url || "") && h.headers?.["x-bloom-key"] !== undefined)
  || (h.type === "command" && /dashboard[\\/]service[\\/]hook-session\.mjs/.test(h.command || ""));

/** `settings` with the service's hooks removed and, unless `remove`, added again as they are now. */
export function withHooks(settings, { key, dir, remove = false }) {
  const out = { ...settings, hooks: { ...(settings.hooks || {}) } };
  for (const [event, groups] of Object.entries(out.hooks)) {
    const kept = (groups || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (kept.length) out.hooks[event] = kept; else delete out.hooks[event];
  }
  if (!remove) {
    const http = { type: "http", url: ORIGIN + "/hook", headers: { "x-bloom-key": key }, timeout: 2 };
    for (const { event, matcher } of HOOKS) (out.hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [http] });
    (out.hooks.SessionStart ??= []).push({ hooks: [{ type: "command", command: `node "${path.join(dir, "hook-session.mjs").replace(/\\/g, "/")}"`, timeout: 5 }] });
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function installHooks(remove) {
  const text = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "{}";
  let settings;
  try { settings = JSON.parse(text.trimStart() || "{}"); }
  catch (e) { throw new Error(`${settingsFile} is not valid JSON, so the hooks were not written: ${e.message}`); }
  const next = JSON.stringify(withHooks(settings, { key: serviceKey(), dir: here, remove }), null, 2) + "\n";
  if (next === text) return "unchanged";
  fs.copyFileSync(settingsFile, dataFile("settings.before-hooks.json"));
  const tmp = settingsFile + ".bloom-tmp";
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, settingsFile);
  return remove ? "removed" : "written";
}

// Run as a script, and not imported: through the skills link, argv[1] is another path to this file.
const isMain = (() => { try { return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const remove = args.includes("--uninstall");
  fs.mkdirSync(dataDir(), { recursive: true });
  console.log(`Claude Code hooks in ${settingsFile}: ${installHooks(remove)}`);
  if (remove) {
    const pid = readJsonFile(dataFile("service.json"))?.pid;
    try { if (pid) process.kill(pid); } catch {}
    console.log("The service: stopped");
  } else {
    // A service that runs this checkout's code is left alone: it restarts itself when that code
    // changes. One that runs another checkout's is replaced.
    const running = await fetch(ORIGIN + "/status", { signal: AbortSignal.timeout(1500) }).then(r => r.json(), () => null);
    const same = running?.dashboardService && path.resolve(running.code?.dir || "") === path.resolve(here, "..", "..");
    const started = spawnSync(process.execPath, [path.join(here, "start.mjs"), ...(same ? [] : ["--replace"])], { encoding: "utf8", windowsHide: true });
    console.log("The service: " + (started.stdout || started.stderr || "").trim());
    if (args.includes("--no-plugin")) process.exit(0);
    const { loadOrcaPlugins, describe } = await import("../orca-plugins.mjs");
    const result = loadOrcaPlugins({ approve: args.includes("--approve"), setUp: false });
    for (const line of describe(result)) console.log("Orca: " + line);
    for (const p of result.plugins || []) if (p.state === "needs-approval") { for (const a of p.access || []) console.log("    " + a); process.exitCode = 3; }
    if (process.exitCode === 3) console.log(`To approve that access: node "${fileURLToPath(import.meta.url)}" --approve`);
  }
}
