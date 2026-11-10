// Gives the Worktree panel's worker the environment that the tools it runs need. worker.ts imports
// this first.
//
// Orca starts its plugin workers from its install folder with ELECTRON_RUN_AS_NODE set and without
// the user's folders in the environment. There a command named `orca` finds Orca.exe in the
// current folder before the orca CLI on PATH and runs it as Node, and gh cannot find its login
// under APPDATA. own-review.mjs and orca-worktrees.mjs run gh, reviewable, orca and code with this
// process's environment, so the fix goes on process.env itself.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const env = process.env;
const home = os.homedir();
delete env.ELECTRON_RUN_AS_NODE;
delete env.NoDefaultCurrentDirectoryInExePath;
env.USERPROFILE ||= home;
env.APPDATA ||= path.join(home, "AppData", "Roaming");
env.LOCALAPPDATA ||= path.join(home, "AppData", "Local");
// Nor does it have the variables saved in the user's environment that the tools need
// (REVIEWABLE_URL and the token for reviewable, YOUTRACK_BOT), or every folder of the user's PATH
// (reviewable lives in ~/.vite-plus/bin). Those are read from the registry: each user variable the
// worker lacks is added, and the user's and the machine's PATH folders join its PATH.
if (process.platform === "win32") {
  try {
    const saved = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "@{ user = [Environment]::GetEnvironmentVariables('User'); machinePath = [Environment]::GetEnvironmentVariable('Path','Machine') } | ConvertTo-Json -Depth 3"],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 }));
    const has = name => Object.keys(env).some(k => k.toLowerCase() === name.toLowerCase());
    for (const [name, value] of Object.entries(saved.user || {})) if (name.toLowerCase() !== "path" && !has(name)) env[name] = String(value);
    const userPath = Object.entries(saved.user || {}).find(([k]) => k.toLowerCase() === "path")?.[1] || "";
    const key = Object.keys(env).find(k => k.toLowerCase() === "path") || "Path";
    const have = new Set((env[key] || "").split(";").map(p => p.toLowerCase()));
    const more = `${userPath};${saved.machinePath || ""}`.split(";").map(p => p.replace(/%([^%]+)%/g, (m, v) => env[v] ?? m)).filter(p => p && !have.has(p.toLowerCase()));
    if (more.length) env[key] = [env[key], ...more].filter(Boolean).join(";");
  } catch {}
}
