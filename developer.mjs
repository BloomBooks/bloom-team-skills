// Who the developer at this machine is, on each service the team skills talk to.
//
// The answer is kept in ~/.claude/bloom-developer.json, so it is worked out once per machine:
//   {
//     "name": "John Hatton",                                   // how skills address the developer
//     "git": "Hatton",                                         // git config user.name
//     "github": "hatton",                                      // GitHub login
//     "youtrack": { "login": "Hatton", "fullName": "John Hatton" }
//   }
//
// Usage:
//   node developer.mjs                 prints the record, working out and saving what is missing
//   node developer.mjs --set youtrack=<login>
//   node developer.mjs --set github=<login> | name=<display name> | <otherKey>=<value>
// A skill may keep one more per-developer value here under a key of its own.
// From another script:
//   import { developer } from "<repo>/developer.mjs";   // throws if the record is incomplete
//
// The YouTrack login is found by searching YouTrack users (as the Bot) for the git name and the
// GitHub display name. When that finds no single match, the script exits with code 2 and lists
// the candidates; ask the developer which login is theirs and save it with --set.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FILE = join(homedir(), ".claude", "bloom-developer.json");
const YT = "https://issues.bloomlibrary.org/youtrack/api";

function run(cmd, args) {
  try {
    // git, gh and powershell are real executables, so no shell is needed (and a shell would
    // mangle the quotes in gh's --jq expression).
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
function userEnv(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== "win32") return "";
  return run("powershell.exe", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`]);
}

function load() {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
}
function save(rec) {
  writeFileSync(FILE, JSON.stringify(rec, null, 2) + "\n");
}

async function youtrackUsers(token, query) {
  const url = `${YT}/users?query=${encodeURIComponent(query)}&fields=login,fullName,banned&$top=20`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!r.ok) throw new Error(`YouTrack user search failed: ${r.status} ${await r.text()}`);
  return (await r.json()).filter(u => !u.banned);
}

// Fills in whatever the record lacks. Returns { rec, problems }.
async function resolve(rec) {
  const problems = [];
  rec.git ||= run("git", ["config", "--global", "user.name"]) || run("git", ["config", "user.name"]);
  if (!rec.github || !rec.name) {
    const gh = run("gh", ["api", "user", "--jq", '.login + "\\t" + (.name // "")']);
    const [login, ghName] = gh.split("\t");
    rec.github ||= login || undefined;
    rec.name ||= ghName || undefined;
  }
  if (!rec.github) problems.push("GitHub login unknown: sign in with `gh auth login`, or save it with --set github=<login>.");

  if (!rec.youtrack?.login) {
    const token = userEnv("YOUTRACK_BOT");
    if (!token) {
      problems.push("YouTrack login unknown and YOUTRACK_BOT is not set, so it can't be looked up.");
    } else {
      const names = [...new Set([rec.git, rec.name].filter(Boolean))];
      const found = new Map();
      for (const n of names) for (const u of await youtrackUsers(token, n)) found.set(u.login, u);
      const lower = s => (s || "").toLowerCase();
      const exact = [...found.values()].filter(u =>
        names.some(n => lower(u.login) === lower(n) || lower(u.fullName) === lower(n)));
      if (exact.length === 1) {
        rec.youtrack = { login: exact[0].login, fullName: exact[0].fullName };
      } else {
        const list = [...found.values()].map(u => `${u.login} (${u.fullName})`).join(", ") || "none";
        problems.push(`YouTrack login not settled. Searched for ${names.join(" / ")}; candidates: ${list}. ` +
          "Ask the developer which is theirs and save it with --set youtrack=<login>.");
      }
    }
  }
  rec.name ||= rec.youtrack?.fullName || rec.git;
  return { rec, problems };
}

// For scripts: the saved record, completed and saved if anything was missing.
export async function developer() {
  const before = JSON.stringify(load());
  const { rec, problems } = await resolve(JSON.parse(before));
  if (JSON.stringify(rec) !== before) save(rec);
  if (problems.length) throw new Error(problems.join("\n") + `\n(run node ${new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")})`);
  return rec;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const rec = load();
  if (args[0] === "--set") {
    for (const pair of args.slice(1)) {
      const [key, ...rest] = pair.split("=");
      const value = rest.join("=");
      if (!value) { console.error("usage: --set youtrack=<login> | github=<login> | name=<name>"); process.exit(1); }
      if (key === "youtrack") rec.youtrack = { login: value };
      else if (/^[a-z][A-Za-z]*$/.test(key)) rec[key] = value;
      else { console.error("bad key " + key); process.exit(1); }
    }
    save(rec);
  }
  const { rec: done, problems } = await resolve(rec);
  // A login set by hand gets its full name from YouTrack when the Bot can see it.
  if (done.youtrack?.login && !done.youtrack.fullName) {
    const token = userEnv("YOUTRACK_BOT");
    const u = token && (await youtrackUsers(token, done.youtrack.login)).find(x => x.login === done.youtrack.login);
    if (u) done.youtrack.fullName = u.fullName;
    else if (token) problems.push(`YouTrack has no active user with login ${done.youtrack.login}.`);
  }
  save(done);
  console.log(JSON.stringify(done, null, 2));
  if (problems.length) { console.error(problems.join("\n")); process.exit(2); }
}
