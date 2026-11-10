// What the developer did on their most recent working days, for the dashboard's History section.
//
// History covers today and the WEEKDAYS - 1 weekdays (Monday to Friday) before it, in this
// machine's time zone, so Monday's standup covers Thursday, Friday, the weekend and Monday. This
// returns the days in that span with any of the activity below; the page adds the weekdays that
// have none, and leaves out a Saturday or Sunday that has none.
//
// Each day has three lists:
// - finished: one of the developer's PRs was marked ready for review that day (or opened ready,
//   not as a draft), or was merged that day, by anyone;
// - worked: any of
//   - commits the developer authored: on their PRs, on a card's worktree branch (pushed or not),
//     or on a repo's default branch without a PR;
//   - files changed but not committed yet, by the day each was last saved, in a card's worktree or
//     a repo's own checkout;
//   - the developer's prompts to Claude Code in a session that ran in a card's worktree or a repo's
//     checkout (from the session transcripts in ~/.claude/projects), which covers work that has
//     not reached a file yet;
//   a card finished that day is listed only as finished;
// - reviewed: the developer commented on or reviewed someone else's PR that day (reviewed.mjs,
//   which also leaves out comments that agents posted for them).
// A line is a card when its PR's title or branch, its worktree's branch, or its commit's message
// names one; a PR that names no card is the line "<repo>#<number>", and other work in a repo is the
// line "<repo>". Repos are the BloomBooks repos that Orca knows. Agents commit under the developer's
// git name, so their commits count.
//
// The team's stand-up meeting is at STANDUP each weekday, local time. Work done on a weekday before
// it was reported at that meeting, so a day lists a card once for the work before stand-up
// (beforeStandup: true) and once for the work after it.
//
// The Bloom bot opens PRs on GitHub as Hatton, so a PR authored by the developer can be someone
// else's work. Its ready-for-review and merge count only when its card is or was assigned to the
// developer. The bot also commits as Hatton, on branches named bot/…, so for those PRs commits too
// count only on the developer's own cards. Its nightly triage goes straight to master under the
// git name "John Hatton", so commits count only when their author name is the developer's git
// name exactly.
//
// Run on its own to see the days: node standup.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mayHoldPrompt, promptText, typedPrompt } from "./transcripts.mjs";

export const WEEKDAYS = 3;
// The stand-up meeting's time of day, local time, Monday to Friday. board.html gets it from
// /api/state.
export const STANDUP = { hour: 8, minute: 45 };
// Whether a time falls on a weekday before that day's stand-up.
export function beforeStandup(t) {
  const d = new Date(t);
  return d.getDay() % 6 !== 0 && d.getHours() * 60 + d.getMinutes() < STANDUP.hour * 60 + STANDUP.minute;
}
const LOOK_BACK_DAYS = 14;
const CARDS = /\bBL-\d+/gi;
const CARD_URL = id => "https://issues.bloomlibrary.org/youtrack/issue/" + id;
// At most this many uncommitted files are looked at per checkout.
const MAX_FILES = 300;
// The first prompt of a session that the dashboard itself starts: opening the dashboard is not work.
// It is matched against promptText(), which reads a slash command as "/dashboard".
const DASHBOARD_PROMPT = /^\s*(open the dashboard\b|\/dashboard\b)/i;
// What a line says for work in a repo that no commit message describes.
const UNCOMMITTED = "Changes not committed yet";
const PROMPTED = "Sessions with Claude Code";

function gh(args) {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    // GraphQL with a PR it cannot see exits non-zero but still prints the data it found.
    const text = String(e.stdout || "");
    if (text.includes("{")) return JSON.parse(text);
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ` + String(e.stderr || e.message).split("\n")[0]);
  }
}
function git(dir, ...args) {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).trim(); }
  catch { return ""; }
}

// The local calendar day of a time, as "2026-11-06".
export function dayOf(t) {
  const d = new Date(t);
  const two = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
// The first day that History covers: the weekday WEEKDAYS - 1 weekdays before today.
export function historyStart(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let n = 0; n < WEEKDAYS - 1;) { d.setDate(d.getDate() - 1); if (d.getDay() % 6) n++; }
  return dayOf(d);
}
/**
 * The times a PR was offered for review, from GitHub's { createdAt, isDraft, timelineItems } with
 * its ReadyForReviewEvent and ConvertToDraftEvent nodes: each ReadyForReviewEvent, and its
 * creation when it was opened ready, not as a draft. It was opened ready when the first of those
 * events turned it into a draft, or, with no such event, when it is not a draft now.
 */
export function readyTimes(pr) {
  const marks = [...(pr.timelineItems?.nodes || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const times = marks.filter(m => m.__typename === "ReadyForReviewEvent").map(m => m.createdAt);
  const openedReady = marks.length ? marks[0].__typename === "ConvertToDraftEvent" : !pr.isDraft;
  if (openedReady) times.unshift(pr.createdAt);
  return times;
}
const cardsIn = (...texts) => {
  for (const t of texts) { const m = String(t || "").match(CARDS); if (m) return [...new Set(m.map(c => c.toUpperCase()))]; }
  return [];
};
const normPath = p => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * yt(path, params) calls the YouTrack REST API; githubLogin, youtrackLogin and gitName identify
 * the developer; worktrees are gather.mjs's worktree records ({ card, path, base }); repos are
 * the BloomBooks repos Orca knows ({ name, slug: "BloomBooks/x", path }); reviewed is
 * reviewedCards' list. Returns [{ date, finished, worked, reviewed }] for the days from
 * historyStart() on that have any activity, newest day first, each list
 * [{ id, url, summary, state, pr, prState, at, beforeStandup }] newest first, where at is the
 * latest time that counted, prState is "merged", "draft" or "open" (for a line with a pr), and
 * beforeStandup says the line covers only the work before that day's stand-up.
 */
export async function standupDays({ yt, githubLogin, youtrackLogin, gitName, worktrees = [], repos = [], reviewed = [] }) {
  const since = Date.now() - LOOK_BACK_DAYS * 864e5;
  const sinceIso = new Date(since).toISOString();
  const sinceDay = sinceIso.slice(0, 10);
  const me = githubLogin.toLowerCase();
  // { kind, id, pr, at, title, needsOwnCard, fromCommit }
  const events = [];
  // What a repo line links to.
  const repoUrl = new Map(repos.map(r => [r.name, `https://github.com/${r.slug}/commits?author=${githubLogin}`]));
  // Commits already counted through a PR, so the default branch does not count them again.
  const counted = new Set();
  // Each PR's state, by URL: "merged", "draft" or "open".
  const prState = new Map(reviewed.map(r => [r.pr, r.merged ? "merged" : "open"]));

  // ---- the developer's PRs: ready for review, merged, and their commits
  const found = new Map();
  for (let page = 1; ; page++) {
    const r = gh(["api", "-X", "GET", "search/issues", "-f", `q=is:pr org:BloomBooks author:${githubLogin} updated:>=${sinceDay}`, "-f", "per_page=100", "-f", "page=" + page]);
    for (const i of r.items) {
      const [owner, repo] = i.repository_url.split("/").slice(-2);
      found.set(i.html_url, { owner, repo, number: i.number });
    }
    if (r.items.length < 100) break;
  }
  const prs = [...found.entries()];
  for (let k = 0; k < prs.length; k += 25) {
    const batch = prs.slice(k, k + 25);
    const query = "{" + batch.map(([, p], n) => `p${n}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) {
      pullRequest(number: ${p.number}) { title headRefName createdAt isDraft mergedAt
        timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT], last: 50) { nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } } }
        commits(last: 100) { nodes { commit { oid authoredDate author { user { login } } } } } } }`).join("\n") + "}";
    const data = gh(["api", "graphql", "-f", "query=" + query]).data || {};
    batch.forEach(([url, p], n) => {
      const pr = data[`p${n}`]?.pullRequest;
      if (!pr) return;
      const ids = cardsIn(pr.title, pr.headRefName);
      prState.set(url, pr.mergedAt ? "merged" : pr.isDraft ? "draft" : "open");
      const keys = ids.length ? ids : [`${p.repo}#${p.number}`];
      const byBot = pr.headRefName.startsWith("bot/");
      const readyAt = readyTimes(pr);
      for (const c of pr.commits.nodes) counted.add(c.commit.oid);
      for (const id of keys) {
        for (const at of readyAt) events.push({ kind: "finished", id, pr: url, at, title: pr.title, needsOwnCard: ids.length > 0 });
        if (pr.mergedAt) events.push({ kind: "finished", id, pr: url, at: pr.mergedAt, title: pr.title, needsOwnCard: ids.length > 0 });
        for (const c of pr.commits.nodes) {
          if ((c.commit.author?.user?.login || "").toLowerCase() === me) events.push({ kind: "worked", id, pr: url, at: c.commit.authoredDate, title: pr.title, needsOwnCard: byBot && ids.length > 0, fromCommit: true });
        }
      }
    });
  }

  // ---- checkouts: a card's worktree, or a repo's own checkout
  const places = [
    ...worktrees.filter(w => w.card).map(w => ({ id: w.card, path: w.path, base: w.base || "origin/master", card: true })),
    ...repos.map(r => ({ id: r.name, path: r.path, card: false })),
  ];
  // The place a folder belongs to: the longest checkout path it is in.
  const byLength = [...places].sort((a, b) => normPath(b.path).length - normPath(a.path).length);
  const placeOf = dir => {
    const d = normPath(dir);
    return byLength.find(p => d === normPath(p.path) || d.startsWith(normPath(p.path) + "/"));
  };

  for (const place of places) {
    if (!existsSync(place.path)) continue;
    // Commits: a worktree's own branch, or a repo's default branch (pushed or only local).
    if (gitName) {
      let range;
      if (place.card) range = [`${place.base}..HEAD`];
      else {
        const main = (git(place.path, "rev-parse", "--abbrev-ref", "origin/HEAD") || "origin/master").replace(/^origin\//, "");
        range = [main, "origin/" + main];
      }
      // The whole author name, not a part of it: the Bloom bot commits its nightly triage straight
      // to master as "John Hatton", which --author=Hatton would also match.
      const author = "^" + gitName.replace(/[.*[\]^$\\]/g, "\\$&") + " <";
      const log = git(place.path, "log", "--no-merges", `--author=${author}`, `--since=${sinceIso}`, "--format=%H%x09%aI%x09%s", ...range);
      for (const l of log.split("\n").filter(Boolean)) {
        const [sha, at, subject] = l.split("\t");
        if (counted.has(sha)) continue;
        counted.add(sha);
        const id = place.card ? place.id : (cardsIn(subject)[0] || place.id);
        events.push({ kind: "worked", id, pr: "", at, title: place.card ? "" : subject, fromCommit: true });
      }
    }
    // Files changed but not committed, by when each was last saved.
    // An untracked folder that holds a .git entry is another checkout (a repo's worktrees often sit
    // inside its own checkout): its files are that checkout's work, not this one's.
    const files = [];
    for (const e of git(place.path, "status", "--porcelain", "-z").split("\0").filter(Boolean)) {
      if (/^.D|^D/.test(e)) continue;
      const f = e.slice(3);
      if (!e.startsWith("??") || !f.endsWith("/")) { files.push(f); continue; }
      if (existsSync(join(place.path, f, ".git"))) continue;
      files.push(...git(place.path, "ls-files", "--others", "--exclude-standard", "-z", "--", f).split("\0").filter(Boolean));
    }
    files.splice(MAX_FILES);
    // Each file gives the day it was last saved; different files can give different days.
    for (const f of files) {
      let t;
      try { t = statSync(join(place.path, f)).mtimeMs; } catch { continue; }
      if (t >= since) events.push({ kind: "worked", id: place.id, pr: "", at: new Date(t).toISOString(), title: place.card ? "" : UNCOMMITTED });
    }
  }

  // ---- the developer's prompts in Claude Code sessions
  const projects = join(homedir(), ".claude", "projects");
  let folders = [];
  try { folders = readdirSync(projects); } catch {}
  for (const folder of folders) {
    let names = [];
    try { names = readdirSync(join(projects, folder)).filter(n => n.endsWith(".jsonl")); } catch { continue; }
    for (const name of names) {
      const file = join(projects, folder, name);
      try { if (statSync(file).mtimeMs < since) continue; } catch { continue; }
      let text;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      let first = true, skipSession = false;
      for (const line of text.split("\n")) {
        if (!mayHoldPrompt(line)) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const content = typedPrompt(o);
        // Notices that arrive as user turns are not prompts.
        if (!content || content.includes("[SYSTEM NOTIFICATION")) continue;
        if (first) { first = false; skipSession = DASHBOARD_PROMPT.test(promptText(content)); }
        if (skipSession || Date.parse(o.timestamp) < since) continue;
        // A folder whose path names a card is that card's, even once Orca no longer lists its
        // worktree; otherwise the checkout the folder is in.
        const named = cardsIn(o.cwd)[0];
        const place = named ? { id: named, card: true } : placeOf(o.cwd);
        if (place) events.push({ kind: "worked", id: place.id, pr: "", at: o.timestamp, title: place.card ? "" : PROMPTED });
      }
    }
  }

  // ---- comments and reviews on other people's PRs
  for (const r of reviewed) {
    for (const at of r.commentDates || [r.commentedAt]) events.push({ kind: "reviewed", id: r.id, pr: r.pr, at, title: r.summary });
  }

  // ---- the cards' titles and States, and whether each is or was the developer's
  const ids = [...new Set(events.map(e => e.id).filter(id => /^BL-\d+$/.test(id)))];
  const issues = new Map(await Promise.all(ids.map(async id =>
    [id, await yt("/issues/" + id, { fields: "summary,customFields(name,value(name,login))" }).catch(() => null)])));
  const ownCache = new Map();
  async function isOwn(id) {
    if (!ownCache.has(id)) ownCache.set(id, (async () => {
      const assignee = issues.get(id)?.customFields?.find(c => c.name === "Assignee")?.value;
      if ([assignee].flat().some(u => u?.login === youtrackLogin)) return true;
      const history = await yt(`/issues/${id}/activities`, { categories: "CustomFieldCategory", fields: "field(name),added(login),removed(login)", $top: "2000" }).catch(() => []);
      return history.some(a => a.field?.name === "Assignee" && [...(a.added || []), ...(a.removed || [])].some(u => u?.login === youtrackLogin));
    })());
    return ownCache.get(id);
  }

  // ---- into days
  const byDay = new Map();
  for (const e of events) {
    if (Date.parse(e.at) < since) continue;
    if (e.needsOwnCard && !(await isOwn(e.id))) continue;
    const date = dayOf(e.at);
    if (!byDay.has(date)) byDay.set(date, { finished: new Map(), worked: new Map(), reviewed: new Map() });
    const list = byDay.get(date)[e.kind];
    const early = beforeStandup(e.at);
    const key = early ? e.id + " before stand-up" : e.id;
    const was = list.get(key);
    if (!was) { list.set(key, { ...e, early }); continue; }
    if (e.at > was.at) was.at = e.at;
    if (!was.pr && e.pr) was.pr = e.pr;
    // A repo line says what a commit says, if any commit that day has a message.
    if (e.fromCommit && !was.fromCommit) { was.title = e.title; was.fromCommit = true; }
    else if (e.fromCommit && e.at >= was.at && e.title) was.title = e.title;
  }
  const line = e => {
    const card = /^BL-\d+$/.test(e.id);
    const i = card ? issues.get(e.id) : null;
    return {
      id: e.id, url: card ? CARD_URL(e.id) : (e.pr || repoUrl.get(e.id) || ""),
      summary: i?.summary || e.title || e.id,
      state: card ? i?.customFields?.find(c => c.name === "State")?.value?.name ?? "" : "",
      pr: e.pr, prState: e.pr ? prState.get(e.pr) || "open" : "", at: new Date(e.at).toISOString(),
      beforeStandup: e.early,
    };
  };
  const newest = (a, b) => b.at.localeCompare(a.at);
  const start = historyStart();
  return [...byDay.keys()].filter(date => date >= start).sort().reverse().map(date => {
    const d = byDay.get(date);
    // A card finished on one side of stand-up is listed only as finished on that side.
    for (const key of d.finished.keys()) d.worked.delete(key);
    return {
      date,
      finished: [...d.finished.values()].map(line).sort(newest),
      worked: [...d.worked.values()].map(line).sort(newest),
      reviewed: [...d.reviewed.values()].map(line).sort(newest),
    };
  });
}

/**
 * The BloomBooks repos among the ones Orca knows (`orca repo list`'s `repos`), as standupDays
 * wants them: { name, slug, path }.
 */
export function bloomRepos(repos) {
  return (repos || [])
    .map(r => ({ path: r.path, key: r.gitRemoteIdentity?.canonicalKey || "" }))
    .filter(r => /^github\.com\/bloombooks\//i.test(r.key))
    .map(r => ({ path: r.path, slug: r.key.slice("github.com/".length), name: r.key.split("/").pop() }));
}

// node standup.mjs: print the developer's days.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const { developer } = await import("../developer.mjs");
  const { reviewedCards } = await import("./reviewed.mjs");
  const token = process.env.YOUTRACK_BOT || execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('YOUTRACK_BOT','User')"], { encoding: "utf8" }).trim();
  const yt = async (p, params) => {
    const url = new URL("https://issues.bloomlibrary.org/youtrack/api" + p);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (!r.ok) throw new Error(`YouTrack ${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const { orca } = await import("../orca-worktrees.mjs");
  const { cardOf } = await import("./row-facts.mjs");
  const worktrees = ((await orca("worktree", "list")).worktrees || []).filter(w => !w.isArchived).map(w => {
    const card = cardOf(w.branch, w.path);
    return card ? { card, path: w.path, base: git(w.path, "rev-parse", "--abbrev-ref", "origin/HEAD") || "origin/master" } : null;
  }).filter(Boolean);
  const dev = await developer();
  const reviewed = await reviewedCards(yt, dev.github, dev.youtrack.login);
  for (const day of await standupDays({ yt, githubLogin: dev.github, youtrackLogin: dev.youtrack.login, gitName: dev.git, worktrees, repos: bloomRepos((await orca("repo", "list")).repos), reviewed })) {
    console.log(day.date);
    for (const kind of ["finished", "worked", "reviewed"]) for (const c of day[kind]) console.log(`  ${kind.padEnd(9)} ${c.beforeStandup ? "early " : "      "}${c.id.padEnd(22)} ${c.state.padEnd(21)} ${c.summary}`);
  }
}
