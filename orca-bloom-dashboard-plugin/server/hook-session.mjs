#!/usr/bin/env node
// Claude Code's SessionStart hook, as a command: passes the hook's payload on to the dashboard
// service together with the session's process id, which the HTTP hooks cannot carry. The service
// checks that process to notice a session that died without saying so. It never fails or delays
// the session: any problem ends it quietly within a second.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  const port = Number(process.env.BLOOM_DASHBOARD_PORT || 47600);
  const key = fs.readFileSync(path.join(os.homedir(), ".claude", "bloom-dashboard", "service.key"), "utf8").trim();
  await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bloom-key": key },
    body: JSON.stringify({ payload: JSON.parse(text), pid: Number(process.env.CLAUDE_PID) || null }),
    signal: AbortSignal.timeout(1000),
  });
} catch {}
