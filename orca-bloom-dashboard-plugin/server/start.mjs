#!/usr/bin/env node
// Starts the dashboard service from this checkout as a process of its own, with no window, and
// exits. Whoever runs this (the Orca plugin, the installer, a developer's shell) does not keep the
// service, which runs until Orca quits. A service that already runs keeps the port and the new one
// exits at once, so starting twice is harmless. While Orca is not running, none is started.
//
//   node start.mjs             start it unless one runs
//   node start.mjs --show      the same, then show the dashboard window
//   node start.mjs --replace   stop the one that runs (whatever checkout it runs from) and start
//                              this checkout's
//   node start.mjs --board "Bloom 6.6"   show that Kanban Board's cards from now on ("6.6" means
//                              the same; "all" shows every board; "current" picks the board with
//                              the most cards changed lately)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { ORIGIN, dataDir, dataFile, serviceKey, writeJsonFile, orcaRunning } from "./env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

async function running() {
  try {
    const r = await fetch(ORIGIN + "/status", { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.dashboardService ? j : null;
  } catch { return null; }
}
const tell = body => fetch(ORIGIN + "/tell", { method: "POST", headers: { "content-type": "application/json", "x-bloom-key": serviceKey() }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });

const boardAt = args.indexOf("--board");
if (boardAt >= 0) {
  const name = (args[boardAt + 1] || "").trim();
  if (!name) { console.log('--board needs a name, "all" or "current"'); process.exit(2); }
  fs.mkdirSync(dataDir(), { recursive: true });
  if (name.toLowerCase() === "current") fs.rmSync(dataFile("board.json"), { force: true });
  else writeJsonFile(dataFile("board.json"), { board: name.toLowerCase() === "all" ? "" : /^\d/.test(name) ? "Bloom " + name : name });
}

let was = await running();
if (was && args.includes("--replace")) {
  try { process.kill(was.pid); } catch {}
  for (let i = 0; i < 40 && (await running()); i++) await new Promise(r => setTimeout(r, 250));
  was = null;
}
if (!was && !(await orcaRunning())) {
  console.log("not started: Orca is not running. The dashboard service runs only while Orca does; start Orca, and its Bloom plugin starts the service.");
  process.exit(args.includes("--show") ? 1 : 0);
}
if (!was) {
  spawn(process.execPath, [path.join(here, "service.mjs"), "--wait", "10000"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 60 && !(await running()); i++) await new Promise(r => setTimeout(r, 250));
}
const now = await running();
if (!now) { console.log("the dashboard service did not start; see ~/.claude/bloom-dashboard/service.log"); process.exit(1); }
console.log(`${was ? "already running" : "started"}: ${ORIGIN}/ (process ${now.pid}, code in ${now.code.dir})`);
if (boardAt >= 0) await tell({ kind: "board" }).catch(() => {});
if (args.includes("--show")) await tell({ kind: "show" }).catch(e => console.log("could not show the window: " + e.message));
