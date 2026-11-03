// Serves one decider page on 127.0.0.1, opens it in the default browser, and waits for the
// page to POST its answers. Prints the answers to stdout and exits, so the agent that started
// this in the background is notified the moment the user sends.
//
// Usage: node claude-decider.mjs --name <form-name> <page.html> [--topic "<few words>"] [--no-open] [--timeout-min N]
//
// The file name and --name are what a person sees in Task Manager's "Command line" column,
// so keep this file named claude-decider.mjs and pass a short name for the form. The bar and the
// browser tab show what the session is working on: the git branch of the folder this starts in
// (the session's worktree, e.g. "BL-16822-Inline-Fixes"), or --topic's words instead.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const USAGE = 'usage: node claude-decider.mjs --name <form-name> <page.html> [--topic "<few words>"] [--no-open] [--timeout-min N]';
let pagePath = null, name = null, topic = null, noOpen = false, timeoutMin = 115;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-open") noOpen = true;
  else if (a === "--name") name = argv[++i];
  else if (a === "--topic") topic = (argv[++i] || "").trim();
  else if (a === "--timeout-min") timeoutMin = Number(argv[++i]);
  else if (a.startsWith("--")) { console.error("unknown option " + a + "\n" + USAGE); process.exit(2); }
  else pagePath = a;
}
if (!pagePath || !name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || !(timeoutMin > 0)) {
  console.error(USAGE + "\n--name takes lowercase letters, digits and hyphens");
  process.exit(2);
}
if (!topic) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (branch && branch !== "HEAD") topic = branch;
  } catch {}
}
if (!topic || topic.length > 60 || /[\r\n]/.test(topic)) {
  console.error(USAGE + "\nStart it in the session's worktree so the bar can show its branch, or pass --topic: a few words on one line, at most 60 characters");
  process.exit(2);
}
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The token keeps other web pages from posting to this port.
const token = crypto.randomBytes(16).toString("hex");
const endpoint = "/answers/" + token;

// A bar at the top of every served form saying which tool it came from and what the session is
// working on (its branch, or --topic); the skill's tag sits at its far right. Inline styles, so the
// form's own CSS can't hide it and the form needs nothing to show it. Its content row is as wide
// as a decider form's column. Its charcoal is the ink of the icon and of the palette that the
// decider's SKILL.md gives forms. The dashboard's board.html carries the same bar on its own dark
// page, with its own mark.
// The decider's icon, a question mark on an orange circle: the tab's icon and the bar's mark. The
// dashboard's is an orange speedometer.
const ICON = "data:image/svg+xml,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cg%20clip-path%3D%22url(%23clip0_4296_95)%22%3E%3Ccircle%20cx%3D%2212.0149%22%20cy%3D%2212%22%20r%3D%2211.9851%22%20fill%3D%22%23D97757%22%2F%3E%3Cpath%20d%3D%22M13.5229%2016.5915H10.2918C10.2834%2016.1271%2010.2791%2015.8442%2010.2791%2015.7429C10.2791%2014.6958%2010.4523%2013.8345%2010.7986%2013.159C11.145%2012.4834%2011.8377%2011.7235%2012.8767%2010.8791C13.9157%2010.0346%2014.5366%209.48156%2014.7393%209.21979C15.0519%208.80603%2015.2082%208.35005%2015.2082%207.85185C15.2082%207.15943%2014.9294%206.56834%2014.3719%206.07859C13.8228%205.58038%2013.0794%205.33128%2012.1418%205.33128C11.2379%205.33128%2010.4819%205.58883%209.87366%206.10392C9.26545%206.61901%208.84731%207.40431%208.61923%208.45982L5.3501%208.05451C5.44302%206.54301%206.08502%205.25951%207.2761%204.204C8.47562%203.14848%2010.0468%202.62073%2011.9897%202.62073C14.034%202.62073%2015.6601%203.15693%2016.8681%204.22933C18.0761%205.29328%2018.68%206.53457%2018.68%207.95318C18.68%208.73848%2018.4562%209.48156%2018.0085%2010.1824C17.5692%2010.8833%2016.6231%2011.8375%2015.1702%2013.045C14.4183%2013.6698%2013.9495%2014.1723%2013.7637%2014.5522C13.5863%2014.9322%2013.506%2015.612%2013.5229%2016.5915ZM10.2918%2021.3793V17.8201H13.8524V21.3793H10.2918Z%22%20fill%3D%22%23FBF9F6%22%2F%3E%3C%2Fg%3E%3Cdefs%3E%3CclipPath%20id%3D%22clip0_4296_95%22%3E%3Crect%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22white%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%3C%2Fsvg%3E";
const PLEX = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@600&family=IBM+Plex+Mono&display=swap">`;
const SERVED_BY = `<div role="banner" style="background:#2F2F2F;color:#fff;margin:0">` +
  `<div style="box-sizing:content-box;max-width:760px;min-height:40px;margin:0 auto;` +
  `padding:10px max(16px,env(safe-area-inset-right,0px)) 10px max(16px,env(safe-area-inset-left,0px));` +
  `display:flex;flex-wrap:wrap;align-items:center;gap:12px">` +
  `<img src="${ICON}" alt="" width="28" height="28" style="display:block;flex:none">` +
  `<span style="font:600 16px/1.2 'IBM Plex Sans',system-ui,sans-serif;letter-spacing:-0.01em;color:#fff">Decider</span>` +
  `<span style="font:400 16px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;color:#F2EFE8;` +
  `border-left:1px solid #5A5955;padding-left:12px;min-width:0;overflow-wrap:anywhere">${escapeHtml(topic)}</span>` +
  `<span style="margin-left:auto;font:400 12px/1.4 'IBM Plex Mono',ui-monospace,Consolas,monospace;color:#C9C5BC;` +
  `border:1px solid #4A4946;border-radius:999px;padding:2px 10px">bloom-team skill</span>` +
  `</div></div>`;

const FAVICON = `<link rel="icon" href="${ICON}">`;
// The tab reads the topic first, so a row of decider tabs can be told apart.
const TITLE = `<title>${escapeHtml(topic)} · Decider</title>`;

function page() {
  let html = fs.readFileSync(pagePath, "utf8").replace(/<title>[\s\S]*?<\/title>/i, "");
  const inject = `${TITLE}<script>window.DECIDER_ENDPOINT=${JSON.stringify(endpoint)};</script>${PLEX}${FAVICON}`;
  if (!/^\s*<!doctype/i.test(html)) {
    html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${inject}<style>body{margin:0}</style></head><body>${SERVED_BY}${html}</body></html>`;
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
