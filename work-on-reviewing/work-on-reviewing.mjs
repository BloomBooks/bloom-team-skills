// Sets the developer up to review a PR: opens it in Reviewable in the system browser, saves the
// card's attachments into a review folder, then finds the Orca worktree on the PR's branch (or
// makes one at the PR's tip), makes it the one Orca shows, and starts two Claude sessions there:
// one that gets oriented in the PR and waits for the developer's questions, and one that builds
// and launches Bloom, makes any test books the review needs and writes a review report
// (references/report.md). Changes nothing on the card or the PR.
//
// Usage: node work-on-reviewing.mjs <card | PR> [--repo <owner/name>] [--no-report] [--dry-run] [--json]
//   <card>       BL-16627 (or BL16627, or a YouTrack URL that contains it): the card's open PR
//                created last
//   <PR>         a PR number (1234 or #1234, in --repo), a GitHub PR URL, or a Reviewable URL
//   --repo       the repo of a PR given by number (default bloombooks/bloomdesktop); with a card,
//                the only repo searched for its PRs and worktrees
//   --no-report  starts only the Claude that answers questions (so no build and no report)
//   --dry-run    finds the PR and the worktree, then prints what it would do; opens nothing
//   --json       prints one JSON object instead of text: { ok, action ("open", "create",
//                "would-open" or "would-create"), card, pr, title, reviewable, folder,
//                attachments, attachmentsError, worktree, branch, tip, others, otherPrs, qa,
//                report, activateError, error }. `folder` is the review folder
//                (Documents/Bloom Review/<card, or PR n>); `attachments` lists the card's files
//                saved in its "card files" folder. `tip` says how the worktree stands against
//                the PR's branch on GitHub; `qa` and `report` are what Orca started
//                (launchSummary in orca-worktrees.mjs).
//
// Exit code 0 on success, 1 on any failure (the text or JSON says why).
import { execFile, execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { orcaRepoId, cardWorktrees, createWorktree, launchClaude, activateWorktree, prHeadBranch } from "../orca-worktrees.mjs";
import { cardId, readCard, openPrs, downloadAttachments } from "../youtrack-card.mjs";

const execFileP = promisify(execFile);
const DEFAULT_REPO = "bloombooks/bloomdesktop";
const REPORT_GUIDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "references", "report.md");

// ---- arguments ------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const dryRun = flag("--dry-run");
const asJson = flag("--json");
const noReport = flag("--no-report");
const repoAt = argv.indexOf("--repo");
const repoArg = repoAt >= 0 ? (argv[repoAt + 1] || "").toLowerCase() : null;
const target = argv.find((a, i) => !a.startsWith("--") && !(repoAt >= 0 && i === repoAt + 1));

function finish(result) {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.log("work-on-reviewing failed: " + result.error);
  else console.log(describe(result));
  process.exit(result.ok ? 0 : 1);
}

const git = async (wt, ...args) => (await execFileP("git", ["-C", wt, ...args], { windowsHide: true })).stdout.trim();
// Text for a first message: one line, and nothing that the orca CLI's quote() refuses when it
// runs through a shell (a quote, a % sign or a newline).
const clean = s => String(s || "").replace(/["%\r\n]+/g, " ").replace(/\s+/g, " ").trim();

// ---- the PR ---------------------------------------------------------------------------------
// A PR given as a GitHub or Reviewable URL, or as a number in `repo`: { repo, number }, or null.
function prRef(text) {
  const s = String(text || "");
  const url = s.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i) || s.match(/reviewable\.io\/reviews\/([\w.-]+\/[\w.-]+)\/(\d+)/i);
  if (url) return { repo: url[1].toLowerCase(), number: url[2] };
  const n = s.match(/^#?(\d+)$/);
  return n ? { repo: repoArg || DEFAULT_REPO, number: n[1] } : null;
}
async function readPr({ repo, number }) {
  let p;
  try {
    const { stdout } = await execFileP("gh", ["pr", "view", String(number), "-R", repo, "--json", "number,url,title,state,isDraft,headRefName,headRefOid,baseRefName"], { windowsHide: true });
    p = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`could not read ${repo} PR ${number} (is gh signed in?): ` + String(e.stderr || e.message).split("\n")[0]);
  }
  return { repo, number: p.number, url: p.url, title: p.title, state: p.state, draft: p.isDraft, head: p.headRefName, tip: p.headRefOid, base: p.baseRefName };
}
// From the PR's URL, which spells the owner and repo as GitHub does.
const reviewableUrl = pr => pr.url.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+).*$/, "https://reviewable.io/reviews/$1/$2");

function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// ---- the review folder ----------------------------------------------------------------------
// Documents/Bloom Review/<card, or "PR <n>">: the card's files, and any test books the report's
// Claude makes. Outside the worktree, so nothing there shows in git. Windows may keep Documents
// somewhere other than the home folder (OneDrive), so ask it.
function reviewFolder(card, pr) {
  let docs = "";
  if (process.platform === "win32") {
    try {
      docs = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('MyDocuments')"], { encoding: "utf8", windowsHide: true }).trim();
    } catch {}
  }
  return path.join(docs || path.join(os.homedir(), "Documents"), "Bloom Review", card || `PR ${pr.number}`);
}

// ---- the worktree ---------------------------------------------------------------------------
// Fetches the PR's branch into an existing worktree and says how the worktree stands against it.
// A worktree that is only behind, with nothing uncommitted, moves up to the PR's tip; anything
// else is left as it is. Returns { state ("tip", "updated", "ahead", "behind", "diverged",
// "unfetched"), ahead, behind, dirty }.
async function bringToTip(wt, pr) {
  try { await git(wt, "fetch", "origin", pr.head); } catch { return { state: "unfetched" }; }
  const dirty = (await git(wt, "status", "--porcelain")) !== "";
  const [ahead, behind] = (await git(wt, "rev-list", "--left-right", "--count", `HEAD...origin/${pr.head}`)).split(/\s+/).map(Number);
  if (!ahead && !behind) return { state: "tip", ahead, behind, dirty };
  if (!ahead && !dirty) {
    await git(wt, "merge", "--ff-only", "origin/" + pr.head);
    return { state: "updated", ahead, behind, dirty };
  }
  return { state: ahead && behind ? "diverged" : ahead ? "ahead" : "behind", ahead, behind, dirty };
}
// What the Claudes must know about a worktree that is not at the PR's tip.
function tipFacts(tip, pr) {
  const facts = [];
  const where = `the PR's branch on GitHub (origin/${pr.head})`;
  if (tip.state === "unfetched") facts.push(`The PR's branch could not be fetched, so this worktree may not match ${where}.`);
  if (tip.state === "ahead") facts.push(`This worktree has ${tip.ahead} commit(s) that ${where} lacks.`);
  if (tip.state === "behind") facts.push(`This worktree is ${tip.behind} commit(s) behind ${where}.`);
  if (tip.state === "diverged") facts.push(`This worktree and ${where} have diverged (${tip.ahead} local commit(s), ${tip.behind} missing).`);
  if (tip.dirty) facts.push("This worktree has uncommitted changes.");
  if (facts.length) facts.push(`The PR under review is what is on GitHub: read it from origin/${pr.head}, and say so when the files on disk differ from it. Do not change this worktree.`);
  return facts;
}

// ---- the Claude sessions --------------------------------------------------------------------
function questionsPrompt(pr, card, folder, facts) {
  return clean([
    `You are here to answer the developer's questions about ${pr.url} (${clean(pr.title)})${card ? `, for card ${card}` : ""}, which they are reviewing in Reviewable.`,
    ...facts,
    `Get oriented first, without reviewing it: git fetch origin ${pr.base}, then read the PR's description (gh pr view ${pr.number} -R ${pr.repo}), its commits and the files it changes (git diff --stat origin/${pr.base}...origin/${pr.head}).`,
    `Then tell the developer in two or three sentences what the PR does and that you are ready for their questions, and wait.`,
    `When you answer: cite file:line, tell apart what the PR changed from what was there before (git diff origin/${pr.base}...origin/${pr.head}), say when you are inferring rather than reading, and change no code, commit nothing and post nothing on the PR or the card unless the developer asks.`,
    `Files from the card, and any test books made for this review, are in ${folder}.`,
    noReport ? "" : `Another Claude in this worktree is building and launching Bloom and writing a review report on the PR; it gives the developer a link when done.`,
  ].join(" "));
}
function reportPrompt(pr, card, folder, facts) {
  return clean([
    `Write a review report on ${pr.url}${card ? ` (card ${card})` : ""} for the developer, who is reviewing it in Reviewable: read ${REPORT_GUIDE} and follow it. The review folder is ${folder}.`,
    ...facts,
  ].join(" "));
}

// ---- output ---------------------------------------------------------------------------------
function describe(r) {
  const would = r.action.startsWith("would-");
  const lines = [`${r.card ? r.card + ": " : ""}${r.pr} — ${r.title}${r.prState !== "OPEN" ? ` (${r.prState.toLowerCase()})` : r.draft ? " (draft)" : ""}`];
  lines.push(`${would ? "Would open" : "Opened"} ${r.reviewable} in the browser.`);
  if (r.attachments?.length) lines.push(`Saved the card's files in ${path.join(r.folder, "card files")}: ${r.attachments.map(a => a.name).join(", ")}.`);
  else if (r.card && !would && !r.attachmentsError) lines.push("The card has no attached files.");
  if (r.attachmentsError) lines.push("Could not save the card's files: " + r.attachmentsError);
  if (r.action.endsWith("open")) {
    lines.push(`${would ? "Would use" : "Using"} the worktree ${r.worktree} (branch ${r.branch}).`);
    const t = r.tip || {};
    const tipText = {
      tip: "It is at the PR's tip.",
      updated: `It was ${t.behind} commit(s) behind the PR and was moved up to its tip.`,
      ahead: `It has ${t.ahead} commit(s) the PR on GitHub lacks; left as it is.`,
      behind: `It is ${t.behind} commit(s) behind the PR but has uncommitted changes, so it was left as it is.`,
      diverged: `It has diverged from the PR (${t.ahead} local commit(s), ${t.behind} missing); left as it is.`,
      unfetched: "The PR's branch could not be fetched into it.",
    }[t.state];
    if (tipText) lines.push(tipText + (t.dirty && t.state !== "behind" ? " It has uncommitted changes." : ""));
  } else {
    lines.push(`${would ? "Would create" : "Created"} a worktree on the PR's branch ${r.branch}${r.worktree ? ` at ${r.worktree}` : ""}.`);
  }
  lines.push(`${would ? "Would start" : "Started"} a Claude there to answer your questions about the PR${r.qa?.kind ? ` (${r.qa.kind === "structured" ? "a chat" : "a terminal"})` : ""}.`);
  if (!noReport) lines.push(`${would ? "Would start" : "Started"} another Claude there that builds and launches Bloom, makes any test books the review needs (in ${r.folder}), and writes a review report with a link.`);
  if (r.activateError) lines.push("Could not make it the worktree Orca shows: " + r.activateError);
  else if (!would) lines.push("Orca now shows that worktree (its window stays where it is).");
  if (r.others?.length) lines.push("Other worktrees for this card: " + r.others.join(", "));
  if (r.otherPrs?.length) lines.push("Other open PRs for this card: " + r.otherPrs.join(", "));
  return lines.join("\n");
}

// ---- main -----------------------------------------------------------------------------------
async function main() {
  if (repoArg !== null && !/^[\w.-]+\/[\w.-]+$/.test(repoArg)) throw new Error("--repo needs <owner/name>, e.g. bloombooks/bloomdesktop");
  const ref = prRef(target);
  let card = ref ? null : cardId(target);
  if (!ref && !card) throw new Error("usage: node work-on-reviewing.mjs <BL-nnnnn | PR number | PR URL> [--repo <owner/name>] [--no-report] [--dry-run] [--json]");

  const result = { ok: true, dryRun };
  let pr;
  if (card) {
    const prs = await openPrs(card, await readCard(card), repoArg);
    if (!prs.length) throw new Error(`${card} has no open PR${repoArg ? " in " + repoArg : ""}`);
    // The one created last: a card's later PR builds on or follows its earlier ones.
    prs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const last = prs.at(-1);
    pr = await readPr({ repo: last.repo, number: last.number });
    result.otherPrs = prs.slice(0, -1).map(p => p.url);
  } else {
    pr = await readPr(ref);
    card = cardId(pr.title) || cardId(pr.head);
  }
  Object.assign(result, { card, pr: pr.url, title: pr.title, prState: pr.state, draft: pr.draft, reviewable: reviewableUrl(pr) });

  if (!dryRun) openBrowser(result.reviewable);
  result.folder = reviewFolder(card, pr);
  if (card && !dryRun) {
    try { result.attachments = await downloadAttachments(card, path.join(result.folder, "card files")); }
    catch (e) { result.attachmentsError = e.message; }
  }

  await orcaRepoId(pr.repo);
  const asPr = { url: pr.url, repo: pr.repo, number: pr.number, head: pr.head };
  const worktrees = await cardWorktrees(card, [asPr], pr.repo);
  const onPr = worktrees.filter(w => w.onPr);
  result.others = worktrees.filter(w => w !== onPr[0]).map(w => w.path);

  let facts = [];
  if (onPr.length) {
    const wt = onPr[0];
    Object.assign(result, { action: dryRun ? "would-open" : "open", worktree: wt.path, branch: wt.branch });
    if (!dryRun) {
      result.tip = await bringToTip(wt.path, pr);
      facts = tipFacts(result.tip, pr);
      result.qa = await launchClaude(wt.path, questionsPrompt(pr, card, result.folder, facts));
    }
  } else {
    // Refuses a PR from a fork before anything is made.
    const head = await prHeadBranch(pr.repo, pr.number);
    Object.assign(result, { action: dryRun ? "would-create" : "create", branch: head });
    if (!dryRun) {
      // createWorktree tells its Claude first about a branch that does not match the PR's.
      const made = await createWorktree({ card, title: pr.title, pr: pr.url, prompt: questionsPrompt(pr, card, result.folder, []) });
      Object.assign(result, { worktree: made.path, qa: made.launch });
    }
  }
  if (!dryRun && !noReport) result.report = await launchClaude(result.worktree, reportPrompt(pr, card, result.folder, facts), { focus: false });
  // Orca's window stays where it is, behind Reviewable; inside it, this worktree is the one shown.
  if (!dryRun) await activateWorktree(result.worktree).catch(e => { result.activateError = e.message; });
  return result;
}

main().then(finish, e => finish({ ok: false, error: e.message }));
