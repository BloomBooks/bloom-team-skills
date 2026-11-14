#!/usr/bin/env node
// Tells the dashboard service on this machine that something it shows has just changed, so that
// it reads again now instead of at its next minute. A skill's script runs this after it changes a
// card or a PR:
//
//   node tell.mjs card-changed    a card's State, assignee or tags changed in YouTrack
//   node tell.mjs pr-changed      a PR was opened, marked ready or draft, merged or pushed
//
// It never fails or delays the caller: with no service running it does nothing, in under two
// seconds, and exits 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KINDS = ["card-changed", "pr-changed", "refresh"];

/** Sends `kind` to the service. Resolves true when a service took it, false otherwise. */
export async function tellDashboard(kind) {
  try {
    const key = fs.readFileSync(path.join(os.homedir(), ".claude", "bloom-dashboard", "service.key"), "utf8").trim();
    const r = await fetch(`http://127.0.0.1:${Number(process.env.BLOOM_DASHBOARD_PORT || 47600)}/tell`, {
      method: "POST", headers: { "content-type": "application/json", "x-bloom-key": key },
      body: JSON.stringify({ kind }), signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch { return false; }
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const kind = process.argv[2];
  if (!KINDS.includes(kind)) console.warn("tell.mjs: expected one of " + KINDS.join(", "));
  else console.log((await tellDashboard(kind)) ? "told the dashboard" : "no dashboard service is running");
}
