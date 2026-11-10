// How much of a PR the developer has reviewed themselves, file by file, from GitHub's "Viewed"
// checkboxes and Reviewable's per-file review marks. A file counts as reviewed when either one
// says so for the file's current content:
// - GitHub: the developer's viewerViewedState is VIEWED. GitHub turns it to DISMISSED by itself
//   when the file changes afterwards.
// - Reviewable: the developer's latest mark on the file was made at a revision whose commit has
//   the same content for that file as the PR's head. Reviewable keeps a mark on the revision it
//   was made at, so this compares the file's blob in that revision's commit with its blob in the
//   PR's files. Comparing blobs, not commits, keeps a mark through a squash or a rebase: the old
//   commit is then no ancestor of the head, and GitHub's compare would list every file.
//
// The `reviewable` CLI is signed in as an agent identity, so its own `reviewed` flag is the
// agent's; `review files view` lists everyone's marks (`lastReviewMarks`), and the developer's
// are the ones under their GitHub login.
//
// Usage: node own-review.mjs <PR URL>
// Prints { files, reviewed, left: [paths], github, reviewable }; github and reviewable say whether
// each source could be read. Prints null when neither could.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
async function out(cmd, args) {
  // On Windows the `reviewable` CLI is a .cmd shim (Volta and npm install it that way), which
  // execFile cannot start without a shell, so cmd.exe runs it.
  if (process.platform === "win32" && cmd === "reviewable") [cmd, args] = ["cmd.exe", ["/d", "/c", cmd, ...args]];
  const { stdout } = await exec(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true, timeout: 120000 });
  return stdout;
}
// The CLI can print a notice before or after its JSON.
function json(text) {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  return JSON.parse(text.slice(start, end + 1));
}
// Runs fn over items, at most `limit` at a time.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

async function githubFiles(owner, repo, number) {
  const files = [];
  let head = null, after = null;
  do {
    const q = `query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){pullRequest(number:$n){
      headRefOid files(first:100,after:$a){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}}}`;
    const args = ["api", "graphql", "-f", "query=" + q, "-F", "o=" + owner, "-F", "r=" + repo, "-F", "n=" + number];
    if (after) args.push("-F", "a=" + after);
    const pr = JSON.parse(await out("gh", args)).data.repository.pullRequest;
    head = pr.headRefOid;
    files.push(...pr.files.nodes);
    after = pr.files.pageInfo.hasNextPage ? pr.files.pageInfo.endCursor : null;
  } while (after);
  return { head, files };
}

// path -> the commit of the revision at which the developer last marked the file reviewed.
async function reviewableMarks(slug, login, paths) {
  const pr = "--pr=" + slug;
  const listed = json(await out("reviewable", ["review", "files", "list", pr])).filter(f => !f.virtual && paths.has(f.path));
  const marks = new Map();
  await pool(listed, 6, async f => {
    const view = json(await out("reviewable", ["review", "files", "view", pr, "--key=" + f.key]));
    const mine = (view.lastReviewMarks || []).find(m => m.username?.toLowerCase() === login);
    if (mine?.revision?.headCommitSha) marks.set(f.path, mine.revision.headCommitSha);
  });
  return marks;
}

// The blob of each file in the PR at its head, from GitHub's list of the PR's files.
async function headBlobs(owner, repo, number) {
  const files = JSON.parse(await out("gh", ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/pulls/${number}/files?per_page=100`]));
  return new Map(files.flat().map(f => [f.filename, f.sha]));
}
// The blob of a file in a commit, or null when GitHub cannot give it.
async function blobAt(owner, repo, sha, file) {
  try {
    return (await out("gh", ["api", `repos/${owner}/${repo}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "--jq", ".sha"])).trim() || null;
  } catch { return null; }
}

export async function ownReview(prUrl, githubLogin) {
  const m = String(prUrl).match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error("not a GitHub PR URL: " + prUrl);
  const [, owner, repo, number] = m;
  const login = String(githubLogin).toLowerCase();
  let gh = null;
  try { gh = await githubFiles(owner, repo, Number(number)); } catch {}
  if (!gh) return null;
  const reviewed = new Set(gh.files.filter(f => f.viewerViewedState === "VIEWED").map(f => f.path));

  let reviewableOk = false;
  const rest = new Set(gh.files.map(f => f.path).filter(p => !reviewed.has(p)));
  if (rest.size) {
    try {
      const marks = await reviewableMarks(`${owner}/${repo}/${number}`, login, rest);
      const blobs = marks.size ? await headBlobs(owner, repo, number) : new Map();
      await pool([...marks], 6, async ([path, sha]) => {
        const now = blobs.get(path);
        if (now && (sha === gh.head || (await blobAt(owner, repo, sha, path)) === now)) reviewed.add(path);
      });
      reviewableOk = true;
    } catch (e) {
      console.error("own-review: could not read Reviewable's marks:", e.message);
    }
  } else reviewableOk = true;

  const left = gh.files.map(f => f.path).filter(p => !reviewed.has(p));
  return { files: gh.files.length, reviewed: gh.files.length - left.length, left, github: true, reviewable: reviewableOk };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { developer } = await import("../developer.mjs");
  const url = process.argv[2];
  if (!url) { console.error("usage: node own-review.mjs <PR URL>"); process.exit(1); }
  console.log(JSON.stringify(await ownReview(url, (await developer()).github), null, 2));
}
