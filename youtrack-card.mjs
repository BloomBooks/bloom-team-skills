// Reads a YouTrack card as the Bot, and finds the card's open PRs on GitHub.
// work-on-youtrack/work-on-youtrack.mjs and work-on-reviewing/work-on-reviewing.mjs share these.
//
//   import { yt, readCard, cardFields, openPrs, downloadAttachments } from "<repo>/youtrack-card.mjs";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parsePr } from "./orca-worktrees.mjs";

const execFileP = promisify(execFile);
const YT = "https://issues.bloomlibrary.org/youtrack/api";

// The card id ("BL-16627") in an argument such as BL-16627, BL16627 or a YouTrack URL, or null.
export function cardId(text) {
  const digits = (String(text || "").match(/\bBL-?(\d+)\b/i) || [])[1];
  return digits ? "BL-" + digits : null;
}

function userEnv(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== "win32") return "";
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: "utf8", windowsHide: true }).trim();
  } catch { return ""; }
}
function botToken() {
  const token = userEnv("YOUTRACK_BOT");
  if (!token) throw new Error("YOUTRACK_BOT is not set, so the card cannot be read (see the youtrack-api skill)");
  return token;
}
// A GET of `path` under YouTrack's REST API, or a POST of `body` when given.
export async function yt(path, body) {
  const r = await fetch(YT + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + botToken(), Accept: "application/json", ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  if (r.status === 404) throw new Error(`YouTrack has no ${path.split("?")[0]}`);
  if (!r.ok) throw new Error(`YouTrack ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const field = (i, name) => i.customFields?.find(c => c.name === name)?.value ?? null;
// The card's State (with its ordinal) and Assignee.
export async function cardFields(id) {
  const i = await yt(`/issues/${id}?fields=customFields(name,value(name,login,fullName,ordinal))`);
  const state = field(i, "State"), assignee = field(i, "Assignee");
  return { state: state?.name ?? null, stateOrdinal: state?.ordinal ?? null, assignee: assignee && { login: assignee.login, fullName: assignee.fullName || assignee.login } };
}
// { summary, description, comments: [text], state, stateOrdinal, assignee }
export async function readCard(id) {
  const i = await yt(`/issues/${id}?fields=idReadable,summary,description,comments(text,deleted)`);
  return {
    summary: i.summary || "",
    description: i.description || "",
    comments: (i.comments || []).filter(c => !c.deleted).map(c => c.text || ""),
    ...(await cardFields(id)),
  };
}

// The open PRs that name the card in their title or branch (the rule orca-bloom-dashboard-plugin/server/gather.mjs uses),
// found among the GitHub PR links on the card (`info` from readCard) and a GitHub search of
// BloomBooks for the card id; only those in `repo` ("owner/name", lower case) when given.
// Returns [{ url, repo, number, title, head, createdAt }] in PR-number order.
export async function openPrs(card, info, repo = null) {
  const urls = new Set();
  for (const text of [info.description, ...info.comments]) {
    for (const m of text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) urls.add(m[0]);
  }
  try {
    const { stdout } = await execFileP("gh", ["search", "prs", card, "--owner", "BloomBooks", "--state", "open", "--json", "url", "--limit", "20"], { windowsHide: true });
    for (const p of JSON.parse(stdout || "[]")) urls.add(p.url);
  } catch (e) {
    throw new Error("could not search GitHub for the card's PRs (is gh signed in?): " + String(e.stderr || e.message).split("\n")[0]);
  }
  const names = new RegExp(`\\b${card}\\b`, "i");
  const prs = [];
  const seen = new Set();
  for (const url of urls) {
    const parsed = parsePr(url);
    if (!parsed || seen.has(parsed.repo + "#" + parsed.number)) continue;
    seen.add(parsed.repo + "#" + parsed.number);
    if (repo && parsed.repo !== repo) continue;
    let p;
    try {
      const { stdout } = await execFileP("gh", ["pr", "view", parsed.number, "-R", parsed.repo, "--json", "url,title,state,headRefName,number,createdAt"], { windowsHide: true });
      p = JSON.parse(stdout);
    } catch { continue; }
    if (p.state !== "OPEN" || !(names.test(p.title) || names.test(p.headRefName))) continue;
    prs.push({ url: p.url, repo: parsed.repo, number: p.number, title: p.title, head: p.headRefName, createdAt: p.createdAt });
  }
  return prs.sort((a, b) => a.number - b.number);
}

// Saves every attachment of the card into `dir`, skipping one already there at the same size.
// Returns [{ name, size, path, skipped }].
export async function downloadAttachments(card, dir) {
  const list = await yt(`/issues/${card}/attachments?fields=name,url,size,removed`);
  const out = [];
  for (const a of list.filter(a => !a.removed && a.url)) {
    const name = path.basename(a.name).replace(/[<>:"/\|?*]/g, "_");
    const file = path.join(dir, name);
    const have = await stat(file).then(s => s.size, () => -1);
    if (have === a.size) { out.push({ name, size: a.size, path: file, skipped: true }); continue; }
    // The url already starts with /youtrack/api/files/...?sign=..., which authorizes the request.
    const r = await fetch("https://issues.bloomlibrary.org" + a.url);
    if (!r.ok) throw new Error(`could not download ${name} from ${card}: ${r.status}`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    out.push({ name, size: a.size, path: file, skipped: false });
  }
  return out;
}
