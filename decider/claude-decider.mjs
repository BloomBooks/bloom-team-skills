// Serves one decider page on 127.0.0.1, opens it in the default browser, and waits for the
// page to POST its answers. Prints the answers to stdout and exits, so the agent that started
// this in the background is notified the moment the user sends.
//
// Usage: node claude-decider.mjs --name <form-name> <page.html> [--no-open] [--timeout-min N]
//
// The file name and --name are what a person sees in Task Manager's "Command line" column,
// so keep this file named claude-decider.mjs and pass a short name for the form.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const USAGE = "usage: node claude-decider.mjs --name <form-name> <page.html> [--no-open] [--timeout-min N]";
let pagePath = null, name = null, noOpen = false, timeoutMin = 115;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-open") noOpen = true;
  else if (a === "--name") name = argv[++i];
  else if (a === "--timeout-min") timeoutMin = Number(argv[++i]);
  else if (a.startsWith("--")) { console.error("unknown option " + a + "\n" + USAGE); process.exit(2); }
  else pagePath = a;
}
if (!pagePath || !name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || !(timeoutMin > 0)) {
  console.error(USAGE + "\n--name takes lowercase letters, digits and hyphens");
  process.exit(2);
}

// The token keeps other web pages from posting to this port.
const token = crypto.randomBytes(16).toString("hex");
const endpoint = "/answers/" + token;

// A line at the top of every served form saying where it came from. Inline styles, so the
// form's own CSS can't hide it and the form needs nothing to show it.
const SERVED_BY = `<div style="font:600 14px/1.4 system-ui,sans-serif;color:#2f2a22;background:#eadfc8;` +
  `border-bottom:1px solid #cdbd9c;` +
  `padding:8px max(16px,env(safe-area-inset-right,0px)) 8px max(16px,env(safe-area-inset-left,0px))">` +
  `Served by the Bloom Team Decider skill</div>`;

function page() {
  let html = fs.readFileSync(pagePath, "utf8");
  const inject = `<script>window.DECIDER_ENDPOINT=${JSON.stringify(endpoint)};</script>`;
  if (!/^\s*<!doctype/i.test(html)) {
    html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${inject}</head><body>${SERVED_BY}${html}</body></html>`;
  } else {
    html = html.replace(/<head[^>]*>/i, m => m + inject);
    html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, m => m + SERVED_BY) : SERVED_BY + html;
  }
  return html;
}

// Inside an Orca terminal, bring the tab of the session that started this server to the front.
function focusOrcaTab(done) {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) { done("ORCA_FOCUS skipped: not running in an Orca terminal"); return; }
  if (!/^[\w-]+$/.test(handle)) { done("ORCA_FOCUS skipped: unexpected terminal handle"); return; }
  const cli = process.env.ORCA_CLI_COMMAND || "orca";
  let out = "";
  let finished = false;
  const finish = note => { if (!finished) { finished = true; done(note); } };
  // On Windows `orca` is a .cmd shim, which needs a shell; a single command string avoids
  // Node's warning about passing an args array with shell: true. The handle was checked above.
  const command = `${cli} terminal switch --terminal ${handle} --json`;
  const child = process.platform === "win32"
    ? spawn(command, { shell: true, windowsHide: true })
    : spawn(cli, ["terminal", "switch", "--terminal", handle, "--json"]);
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  child.on("error", e => finish("ORCA_FOCUS failed: " + e.message));
  child.on("close", code => finish("ORCA_FOCUS exit " + code + ": " + out.trim().replace(/\s+/g, " ").slice(0, 300)));
  setTimeout(() => { child.kill(); finish("ORCA_FOCUS timed out"); }, 5000).unref();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page());
    return;
  }
  if (req.method === "POST" && req.url === endpoint) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }), () => {
        focusOrcaTab(focusNote => {
          process.stdout.write(focusNote + "\n=== DECIDER ANSWERS (" + name + ") ===\n" + body + "\n=== END DECIDER ANSWERS ===\n", () => {
            server.close();
            process.exit(0);
          });
        });
      });
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log("DECIDER_URL " + url + " (" + name + ", pid " + process.pid + ")");
  if (!noOpen) {
    const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
  }
});
server.on("error", e => { console.error("SERVER_ERROR " + e.message); process.exit(1); });

setTimeout(() => {
  console.log("DECIDER_TIMEOUT no answers after " + timeoutMin + " minutes");
  process.exit(3);
}, timeoutMin * 60 * 1000).unref();
