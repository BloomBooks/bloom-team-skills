// What every part of the dashboard service shares about where it runs: its port, its files in
// ~/.claude/bloom-dashboard/, the key that local programs show it, and the environment it needs
// however it was started.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PORT = Number(process.env.BLOOM_DASHBOARD_PORT || 47600);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const serviceDir = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
export const dashboardDir = path.dirname(serviceDir);
export const repoDir = path.dirname(dashboardDir);

// Worked out on each use, so that a test can point the home folder at a temporary one.
export const dataDir = () => path.join(os.homedir(), ".claude", "bloom-dashboard");
export const dataFile = name => path.join(dataDir(), name);

/**
 * The files the service keeps in dataDir():
 *   service.json       { pid, port, startedAt } while it runs
 *   service.key        the key that hooks, skill scripts and the Orca plugin send (x-bloom-key)
 *   service.log        what it did, one line each
 *   service-events.jsonl  each fact that changed a run or a row's state, for "Why?" on a row
 *   runs.json          the sessions and runs (runs.mjs)
 *   cache.json         the last good read of each outside source, shown until the next read
 *   config.json        { model, prose } (prose.mjs)
 *   board.json         { board } the Kanban Board the rows are for
 *   tasks.json         the developer's to-do items; the one file nothing can work out again
 *   progress/          a preflight run's phases, one file per worktree (progress.mjs)
 *   deciders/          the forms waiting for the developer's answers (deciders.mjs)
 */
export function serviceKey() {
  const file = dataFile("service.key");
  fs.mkdirSync(dataDir(), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(16).toString("hex"));
  return fs.readFileSync(file, "utf8").trim();
}

export function readJsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").trimStart()); } catch { return fallback; }
}
// Written whole to a temporary file and renamed, so a crash cannot leave half a file.
export function writeJsonFile(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

/**
 * Makes the process's environment what the developer's own shell has, whoever started it. Orca
 * starts its plugin workers in its install folder with ELECTRON_RUN_AS_NODE set and without most
 * user variables: there a command named `orca` finds Orca.exe before the CLI, `reviewable` is not
 * on the Path, and its token is missing, which reads as "no file reviewed". So: the working
 * folder becomes the data folder, the Electron variables go, and each variable and Path entry of
 * the Windows user and machine environment that the process lacks is added.
 */
export function ownEnvironment() {
  fs.mkdirSync(dataDir(), { recursive: true });
  process.chdir(dataDir());
  for (const name of Object.keys(process.env)) if (/^ELECTRON_/i.test(name)) delete process.env[name];
  // Claude Code sets this in its child processes; with it Windows stops finding a .cmd's target.
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  if (process.platform !== "win32") return;
  const home = os.homedir();
  process.env.USERPROFILE ||= home;
  process.env.APPDATA ||= path.join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA ||= path.join(home, "AppData", "Local");
  process.env.ProgramFiles ||= "C:\\Program Files";
  const expand = v => v.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
    let text;
    try { text = execFileSync("reg.exe", ["query", key], { encoding: "utf8", windowsHide: true }); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s{4}(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
      if (!m) continue;
      const [, name, value] = m;
      if (name.toLowerCase() === "path") {
        const have = new Set((process.env.Path || process.env.PATH || "").split(";").map(p => p.toLowerCase()));
        const add = expand(value).split(";").filter(p => p && !have.has(p.toLowerCase()));
        if (add.length) process.env.Path = [process.env.Path || process.env.PATH || "", ...add].filter(Boolean).join(";");
      } else if (process.env[name] === undefined) {
        process.env[name] = expand(value);
      }
    }
  }
}

/**
 * Whether the Orca app runs on this machine, from the list of processes. Orca's daemon host has
 * the same process name and is not the app. Only Windows is asked; elsewhere, and when the list
 * cannot be read, the answer is yes, so that a failed read never stops the service.
 */
export function orcaRunning() {
  if (process.platform !== "win32") return Promise.resolve(true);
  const name = process.env.BLOOM_DASHBOARD_ORCA_PROCESS || "Orca";
  const count = `@(Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -notmatch 'daemon-host-profiles' }).Count`;
  return new Promise(resolve => execFile("powershell.exe", ["-NoProfile", "-Command", count], { windowsHide: true, timeout: 20_000 },
    (error, stdout) => resolve(error ? true : Number(String(stdout).trim()) > 0)));
}

let logFile = null;
export function log(message) {
  logFile ??= dataFile("service.log");
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch {}
}
