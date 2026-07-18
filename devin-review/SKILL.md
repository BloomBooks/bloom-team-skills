---
name: devin-review
description: Kick off a Devin AI code review for a GitHub PR, wait for it, then post unresolved Bugs and Investigate flags as GitHub inline review-thread comments, and resolve the threads for findings Devin now considers fixed or that we assessed as non-issues. Every finding's thread ends with a documented outcome — including recording a developer's later "leave as is" decision as a reply before resolving. Devin does NOT post to GitHub automatically — this skill bridges that gap.
argument-hint: "PR URL or number, e.g. BloomBooks/BloomDesktop#7949"
user-invocable: true
---

# Devin Review Skill

## The deal with Devin — read this first

Unlike other review bots we have wired up (Greptile, CodeRabbit, …), **Devin never pushes its
findings or fixes to the PR for us** — that is a paid feature we don't have. Everything Devin
produces lives only on its website. It doesn't even *begin* a review until we ask for one, and
"asking" means loading the review URL. So it is **always our job** to:

1. **trigger the review** by navigating to the review page for the PR (see "Triggering a
   review" — in BloomDesktop, `pr-automation.yml` does this on every push by loading that URL
   from a CI runner; without some such visit, no review ever runs),
2. wait for the analysis to finish,
3. go back to the review page and gather the findings, and
4. mirror them to the PR as review comments (Procedure §3–§5).

If nobody does that, the review might as well not have happened — none of it is visible on
GitHub. That gathering-and-mirroring job is what this skill is.

**No finding disappears silently.** Every current (current-commit, non-Informational) Bug and
Investigate flag ends up as a PR review thread with a **documented outcome**, one of:
- **fixed** — Devin marks it Resolved; we reply and resolve the thread (step 6);
- **not an issue / false positive** — we assessed it during the run; reply with the reasoning,
  then resolve (step 6);
- **decided by the developer** — it went to the developer (e.g. via `preflight`'s decision
  report); the thread stays **open** until the decision comes back, then it gets a reply
  recording the decision and is resolved (see "Recording a developer decision" below).

A thread that just gets resolved with no reply, or a finding that never reaches the PR at all,
loses the record of *why* we didn't act — that record is the point.

## Authorization — invoking this skill IS your permission to post to GitHub
Running this skill (directly, or via `preflight`'s bot gauntlet) is the user's **explicit
authorization** to make the GitHub writes it defines: posting Devin's unresolved Bugs and
Investigate flags as inline review-thread comments, resolving the threads for findings Devin now
considers fixed, and adding the "Consulted Devin … up to `<SHA>`" log comment. Do **not** stop to
re-confirm before mirroring findings — the general "outward-facing actions need confirmation
first" guard does not apply here, because mirroring Devin's findings to GitHub is the entire
purpose of the skill. (This does not authorize posting any `@devin` mention — see the warning in
Procedure — nor any write beyond the ones listed here.)

This authorizes the *agent's intent*; it does not grant *harness* permission. In **auto mode**
the classifier may still **deny** the `gh` posts/thread-resolves this skill makes ("denied by the
Claude Code auto mode classifier"). If so, don't try to route around it — report the findings
back to the caller (or the developer) as pending, and point them at the one-time settings change
in the bloom-team-skills repo README, **"Making the review skills actually autonomous"**
(`autoMode.allow` / `permissions.allow`).

## When To Use

- When a new PR is created or a new commit pushed, as part of the bot-wait phase before human review.
- Invoked by `preflight` during its bot gauntlet; consulted by `pr-ready-for-human` for its "has Devin run?" verification.
- When the user explicitly wants a Devin review run and reported.

This skill is the **single source of truth for operating Devin** (devinreview.com /
app.devin.ai). Other skills should reference it rather than restating trigger/read mechanics.

## URLs

Given `owner/repo` and PR number (e.g. `BloomBooks/BloomDesktop` / `7949`):

- **Results page**: `https://app.devin.ai/review/<owner>/<repo>/pull/<number>`

Navigating to the results page both triggers a review (if none exists yet) and shows results once complete. The `devinreview.com/<owner>/<repo>/pull/<number>` URL is an alias for the same page.

**This works for _any_ public GitHub PR — Devin is not per-repo "installed."** The mnemonic: take
the PR's `github.com/<owner>/<repo>/pull/<n>` URL and swap the host to `devinreview.com` — that is
the review page. A repo does **not** need a Devin GitHub app, a CI workflow, or any prior Devin
comment for this to work. So Devin should **never** be reported as "not configured / not installed
/ not available" for a repo — if it has a GitHub PR, it has a Devin review page. The only thing
that varies per repo is how the review gets *triggered* (next section).

## Triggering a review

- **Automatic — every push.** BloomDesktop's `.github/workflows/pr-automation.yml` runs on
  `pull_request: [opened, synchronize]` and loads the review URL from a clean CI runner, which
  kicks off a Devin review of that commit. So every pushed commit already has a review
  triggered — "did we trigger Devin?" is almost always yes; the useful questions are *did it
  finish* and *did it find anything*.
- **Manual (re-)trigger — use the proven CI path, not a browser:**
  ```bash
  # find the latest pr-automation run for the branch, then re-run it (re-loads the trigger URL)
  gh run list --workflow pr-automation.yml --branch <branch> --limit 1 --json databaseId
  gh run rerun <databaseId>
  ```
  The trigger is idempotent per commit — when in doubt, re-triggering is cheap.
- Navigating to the results page (Procedure §1) also triggers a review if none exists — but
  opening it in a normal *interactive* browser may just hit the auth wall (`auth.devin.ai`)
  and is not a reliable trigger. Use the CI re-run, or the isolated-context chrome-devtools
  navigation from Procedure §1.

## Reading Devin state without the browser (gh signals)

**These gh signals only exist where BloomDesktop's `pr-automation.yml` runs.** On a repo without
that workflow there is no `pr-automation` check and (unless someone posted one) no
`devin-ai-integration` comment — that means Devin was not *auto-triggered on push* and hasn't been
mirrored, **not** that Devin is unavailable. There you trigger it yourself (navigate the review
URL / run the browser Procedure) rather than reading it from `gh`.

For callers that only need to know *whether* Devin has run (board syncs, promotion checks) —
no login and no browser required:

```bash
gh pr view <n> --json state,mergedAt,commits,reviews,comments,statusCheckRollup
```

- **Triggered for HEAD?** A `pr-automation` check run whose head SHA == the PR HEAD ⇒ Devin
  was triggered for the latest commit. (It almost always is.)
- **Finished with findings?** A `devin-ai-integration` review/comment (badge marker
  `<!-- devin-review-badge-begin`) dated **after** the latest commit ⇒ Devin finished and had
  findings — treat those as review comments to weigh. But remember the mental model above:
  at most this is a badge/summary — the actionable findings still have to be gathered from
  the website and mirrored by this skill. And **no** such post proves nothing: still running
  or finished-clean look identical from the API.
- A `Devin Review` *status context* in `statusCheckRollup` is unreliable / often absent — do
  **not** depend on it. Devin reports via the review **comment**, not a status check.
- Because "finished but clean" and "still running" look identical from the API, durable memory
  of consultations matters: this skill's own record is the "Consulted Devin …" PR comment
  (Procedure §7). A caller may keep its own marker too (e.g. the `personal-board` skill stamps
  a `devin: <sha> <state>` note on the worktree).

## Reading the review: the job-result API (the ONLY reliable read)

⚠️ **Do not scrape the page DOM or text for findings.** The unauthenticated review page no
longer renders findings sections at all — no Info tab, no "View results" gate, no Bugs/Flags
blocks — so DOM/text greps read **"0 findings" even when findings exist** (this missed all 4
informational flags on bloom-player #438, 2026-07-17, and the consultation log had to be
corrected). Navigating the page is still how a review gets *triggered* (Procedure §1), but all
review *state* is read from the page's own same-origin JSON API, fetched via `evaluate_script`
from the isolated-context tab:

- **Jobs list** — which reviews exist and whether they're done:
  `GET /api/pr-review/jobs?pr_path=github.com%2F<owner>%2F<repo>%2Fpull%2F<n>`
  → `jobs[]`, each with `job_id`, `status` (`running` → `completed`), `commit_sha`, and
  `versions[]` (use the **last** entry's `id`). The job whose `commit_sha` equals the PR HEAD
  is the one you care about; jobs for older commits are the superseded ("Outdated") reviews —
  never post from them.
- **Job result** — the findings themselves:
  `GET /api/pr-review/job-result/<job_id>/<version_id>?pr_path=<same>`
  → `lifeguard_status` (`complete` when the findings pass is done) and `lifeguard_result`:
  - `head_sha` — must equal the PR HEAD you expect (freshness check);
  - `bugs[]` — the **Bugs**. Full description is in the entry (inspect the fields; there is
    no separate click-to-expand step). Check each entry for a resolved/fixed marker field and
    treat marked ones as the old "• Resolved" state (reconcile in step 6, don't post).
  - `analyses[]` — the **Flags**: `{id, title, analysis, file_path, start_line, end_line,
    side, needs_investigation}`. `needs_investigation: true` = **Investigate** (post);
    `false` = **Informational** (skip, but count them in the consultation log — never report
    them as absent).

If the API shape ever changes, do not assume the logged-out page shows findings — it may
render none at all; fix the endpoint usage instead (the git history of this file has the old
DOM-scraping procedure, which worked on the pre-2026-07 page layout).

## Write for a human reader (not a log dump)

Everything this skill posts to GitHub is read by an engineer skimming the PR, so write it in
plain English for a normal engineer — not a dense status line. (John's words for a bad one:
"might as well be assembly code.")

- **One finding per thread, shaped as a post + a reply.** The **post** says, in plain terms,
  what Devin flagged and why it might matter. The **reply** says what we decided —
  fixed / not an issue / false positive — and *why*. Don't cram several findings, their
  reasoning, and commit SHAs into a single paragraph; give each its own resolvable thread. This
  applies to **Investigate** flags we assessed as non-issues too: post the flag, reply with the
  reasoning, resolve — rather than dismissing them all in prose in the consultation log.
- **Translate code-speak into what it means for a user or reviewer.** Say "pressing Esc still
  closes the dialog" not "onCancel is wired"; "the button has a screen-reader label" not
  "aria-label is set"; "translations are matched by the string's key, not its English text" not
  "keyed by trans-unit id". Name the human-visible behavior, not the symbol.
- **Keep the consultation log (step 7) short.** Its job is only to record what was run and point
  to the per-finding threads — it is *not* where findings get explained. A few plain sentences:
  what ran, the handful of things it raised each with a one-line outcome and a link to its
  thread, and that CI/other bots were clean.

## Procedure

> ⚠️ **Do NOT post `@devin review` (or any `@devin` mention) to GitHub.** That is *not* how this skill triggers Devin, and this repo has no Devin GitHub app to respond to it — the mention goes nowhere and no review runs. Devin is triggered **only** by navigating to the `app.devin.ai` results page via chrome-devtools (step 1). If all you have done is post a `@devin review` comment, you have **not** run this skill. (This exact mistake left PR #613 with a `@devin review` comment but no findings, no consultation log, and no idea whether Devin was satisfied.)

### 1. Navigate to the Review Page

Use the Chrome DevTools CLI with an **isolated context** (no shared cookies). This is critical — navigating while logged in to Devin consumes on-demand credits. The isolated context is unauthenticated but still shows all findings.

```bash
chrome-devtools new_page "https://app.devin.ai/review/<owner>/<repo>/pull/<number>" --isolatedContext "devin-noauth"
sleep 6
```

Close this tab when done to avoid accumulating isolated-context tabs.

### 2. Wait for the review job for the current commit (via the jobs API)

**a. Know the commit you expect.** Capture the PR head SHA up front (also reused in steps 5–7):

```bash
HEAD_SHA=$(gh pr view <number> --repo <owner>/<repo> --json headRefOid --jq .headRefOid)
```

**b. Completion = the jobs API says so — never the page text.** Poll the jobs endpoint from
the isolated-context tab until the job whose `commit_sha == $HEAD_SHA` reaches a terminal
`status`:

```bash
TAB=<id from new_page>   # e.g. "11"
EXPECT="/review/<owner>/<repo>/pull/<number>"
PRPATH="github.com%2F<owner>%2F<repo>%2Fpull%2F<number>"
# poll until the HEAD-sha job is terminal, max ~30 min; select + verify tab EVERY iteration
for i in $(seq 1 60); do
  chrome-devtools select_page "$TAB" >/dev/null 2>&1
  chrome-devtools evaluate_script "() => location.pathname" 2>/dev/null | grep -q "$EXPECT" || { sleep 25; continue; }
  RES=$(chrome-devtools evaluate_script "async () => { const r = await fetch('/api/pr-review/jobs?pr_path=$PRPATH'); const j = await r.json(); const job = j.jobs.find(x => x.commit_sha === '$HEAD_SHA'); return job ? job.job_id + '|' + job.status + '|' + (job.versions[job.versions.length-1]||{}).id : 'nojob'; }" 2>/dev/null | grep -oE 'pr-review-job-[a-z0-9]+\|[a-z_]+\|version-[a-z0-9-]+' | head -1)
  STATUS=$(echo "$RES" | cut -d'|' -f2)
  [ -n "$STATUS" ] && [ "$STATUS" != "running" ] && { echo "TERMINAL: $RES"; break; }
  sleep 25
done
```

- `nojob` on the first minute or two → the navigation may not have registered the trigger yet;
  reload the page once and keep polling. `nojob` persisting past ~3 min → re-trigger (§
  "Triggering a review").
- `status: completed` → proceed to §3, using the captured `job_id` and (latest) `version_id`.
- Still `running` at the **30 min** cap → record the timeout (the caller reports it verbatim).

Notes that keep this loop honest, all learned the hard way:

- ⚠️ **Never string-compare the CLI's whole output.** `chrome-devtools evaluate_script` prints
  an update-nag banner and a fenced ` ```json ` block around the value, so
  `[ "$(chrome-devtools …)" = "true" ]` can never match and the loop spins forever (stalled a
  bloom-player #430 run). Extract the value with a pattern match, as above.
- ⚠️ **Pin the tab: select + verify `location.pathname` every iteration.** The `devin-noauth`
  isolated context is shared by every session on the machine; `evaluate_script` runs against
  whichever tab is currently selected, which silently drifts to the newest page — a
  bloom-player #433 run briefly read a different PR's review this way. The fetch is
  same-origin, so it must run from a tab that is actually on `app.devin.ai`.
- Make the **first** check ~30 s after the trigger — small-delta re-reviews can finish inside
  one poll interval; don't gate on ever *observing* a `running` state (an over-wait bug hit
  bloom-harvester #234 twice). The job for `$HEAD_SHA` being `completed` is sufficient
  evidence, full stop.
- Jobs for **older commits** in the list are the superseded reviews (what the old UI showed as
  `Outdated`); ignore them entirely.

### 3. Enumerate Findings (from the job-result JSON)

Fetch the result for the `job_id`/`version_id` captured in §2 (same tab-pinning rule):

```bash
chrome-devtools evaluate_script "async () => { const r = await fetch('/api/pr-review/job-result/<job_id>/<version_id>?pr_path=$PRPATH'); const j = await r.json(); window.__devinResult = j; const lg = j.lifeguard_result || {}; return JSON.stringify({ status: j.lifeguard_status, headSha: lg.head_sha, bugs: (lg.bugs||[]).length, flags: (lg.analyses||[]).length }); }"
```

Sanity checks before trusting it: `status` must be `complete`, `headSha` must equal
`$HEAD_SHA`, and the finding `file_path`s must belong to *this* repo (a `build.gradle` finding
on a TypeScript-only PR means you fetched from the wrong tab, not that Devin hallucinated).
Stashing the JSON on `window.__devinResult` lets later `evaluate_script` calls slice out
individual findings without re-fetching.

Collect from `lifeguard_result`:

- **Bugs** (`bugs[]`): post each (step 5) **unless** the entry carries a resolved/fixed marker
  field — those are the old UI's "• Resolved" bugs, meaning Devin confirmed the PR already
  fixes them: record their titles for reconciliation (step 6), do NOT post.
- **Investigate flags** (`analyses[]` with `needs_investigation: true`): post (step 5).
- **Informational flags** (`analyses[]` with `needs_investigation: false`): do NOT post as
  review threads (low signal) — but **assess them** (occasionally one deserves a cheap fix or
  a clarifying comment) and **count them in the consultation log** (step 7). Never report
  them as absent just because they aren't mirrored.

If `bugs` and the Investigate subset are both empty, the review is **clean** — post nothing
(still do step 6 for any resolved bugs, and step 7 logging).

### 4. Full Descriptions

No extra extraction step: the JSON already carries the full text — `analysis` on each flag,
and the description field(s) on each bug entry. Use title + full text when posting; the title
alone is not enough for a useful GitHub comment.

### 5. Post Findings to GitHub as Inline Review Threads

Post each finding as an **inline review comment anchored to its diff line**, so it becomes a *resolvable* GitHub review thread. (Top-level PR comments have no "Resolve" affordance, so we can never close the loop on them — that is why we prefer review threads.) The "Post to GitHub" button on the Devin page is not functional — always post via `gh`.

**Gather the existing Devin threads once.** This one query serves both dedup (this step) and resolution (step 6): it returns each thread's GraphQL id (to resolve), its first comment's REST id (to reply), the body (to match by title), and whether it is already resolved.

```bash
gh api graphql -f owner=<owner> -f repo=<repo> -F number=<number> -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes{
        id isResolved
        comments(first:1){ nodes{ databaseId body } }
      }}
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[]
  | select(.comments.nodes[0].body | startswith("[Devin]"))
  | {threadId:.id, isResolved, commentId:.comments.nodes[0].databaseId, body:.comments.nodes[0].body}'
```

A finding is **already posted** if one of those thread bodies contains the same finding title. Skip posting it again. (Also glance at legacy top-level comments: `gh api repos/<owner>/<repo>/issues/<number>/comments --jq '.[].body' | grep "\[Devin\]"`.)

**Snap the line to the diff first.** Devin's line number is frequently a line or two off from the actual diff hunk (it points at the logical location, not always a changed/context line). Anchoring the raw number then over-triggers the fallback. Before posting, compute the file's commentable RIGHT-side lines and, if Devin's line isn't one of them, snap to the nearest within a small window (±3):

```bash
# RIGHT-side line numbers that accept an inline comment, for <file>
commentable_lines() {
  gh api repos/<owner>/<repo>/pulls/<number>/files --paginate \
    --jq '.[] | select(.filename=="'"$1"'") | .patch' \
  | awk '
      /^@@/ { match($0, /\+([0-9]+)/, m); ln = m[1]; next }  # RIGHT start of hunk
      /^-/  { next }                                          # deleted line: no RIGHT number
      { print ln; ln++ }                                      # context/added: commentable
    '
}
```

Snap rule: if `<line>` ∈ `commentable_lines <file>`, use it as-is; else snap to the nearest within ±3 (ties → the lower line); else skip straight to the file-level rung below. For a range finding, snap `start_line` and `line` independently; if only one endpoint lands in the diff, post a single-line comment on it.

**Post with a fallback ladder** — line → file-level → top-level, stopping at the first that succeeds. GitHub only accepts a line-anchored comment when the line is part of the diff (else HTTP 422, common for Investigate flags on unchanged context lines). The first two rungs both create *resolvable* threads that step 6 can close; only the last does not.

```bash
# Body (Bug shown; use "**Investigate**" for flags). Keep file:line in the body
# so it's still legible if we fall back.
BODY=$(cat <<'EOF'
[Devin] **Bug**: <Title>

<Full description>
EOF
)

# 1) line-anchored on the snapped line
#    range: also pass -F start_line=<start> -f start_side="RIGHT" and set line=<end>
gh api repos/<owner>/<repo>/pulls/<number>/comments \
  -f commit_id="$HEAD_SHA" -f path="<file>" -F line=<line> -f side="RIGHT" -f body="$BODY" \
  || \
# 2) file-level review comment — still a resolvable thread (appears in the step-5 query)
gh api repos/<owner>/<repo>/pulls/<number>/comments \
  -f commit_id="$HEAD_SHA" -f path="<file>" -f subject_type=file -f body="$BODY" \
  || \
# 3) last resort: top-level issue comment (NOT resolvable) — tag it so step 6 recognizes it
gh pr comment <number> --repo <owner>/<repo> --body "[Devin] **Bug**: <Title> (\`<file>:<line>\` — outside diff, not resolvable as a thread)

<Full description>"
```

Record which findings fell through to rung 3 (top-level) — those cannot be natively resolved later; step 6 edits them instead.

### 6. Reconcile Outcomes

Two kinds of findings get their thread replied-to and resolved in this step: bugs **Devin** now
considers fixed, and findings **we** assessed as not-an-issue during this run.

**a. Findings we assessed as not an issue / false positive.** For each posted finding the
caller judged mistaken or not worth acting on *on its own authority* (a clear-cut call that
doesn't need the developer — see the caller's autonomy rules): reply on its thread in plain
English with the reasoning ("Not an issue: pressing Esc still closes the dialog because …"),
then resolve the thread (same `gh` commands as below). The documented, resolved thread is the
record. Findings that need the **developer's** decision are NOT resolved here — leave the
thread open and let the decision come back later (see "Recording a developer decision").

**b. Bugs Devin now marks • Resolved** (collected in step 3) — match each by title against the Devin threads gathered in step 5:

- **We posted it before and its thread is still unresolved** → reply to document why, then resolve the thread. (This covers both line-anchored and file-level threads — both appear in the step-5 query.)

  ```bash
  # Reply on the thread (needs the REST comment id from the query above)
  gh api repos/<owner>/<repo>/pulls/<number>/comments \
    -F in_reply_to=<commentId> \
    -f body="[Devin] ✅ Devin now considers this fixed (as of \`$HEAD_SHA\`). Resolving."

  # Resolve the thread (needs the GraphQL thread id)
  gh api graphql -f threadId=<threadId> -f query='
  mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } } }'
  ```

- **We posted it before only as a top-level fallback comment** (rung 3, no thread) → it cannot be natively resolved; edit that comment to prepend a `✅ Resolved (<SHA>)` marker so a human sees it is closed.
- **We never posted it** → no action; it was fixed before we ever flagged it.
- **Its thread is already `isResolved: true`** → no action.

Note: Investigate flags have no "Resolved" state in Devin — when Devin stops flagging one, it simply disappears from the re-review's `analyses[]` (only the prior commit's job still lists it). Do **not** auto-resolve threads for vanished flags (no reliable signal); leave those for the human reviewer.

### 7. Log that Devin was run — even if it found no issues

Because it is quite expensive to consult Devin, it's important that we can avoid consulting it if we know that we have not committed anything since the last time we consulted it. For this reason, whenever a consultation with Devin is finished, add a comment to the PR: "Consulted Devin on (date time) up to commit (SHA)". Of course it is vital that we actually gave Devin sufficient time to do the check (step 2) before we decide it has no new findings.

### 8. Report

Return a summary:

- N unresolved Bugs found — N posted, N skipped (already posted), N fell back to file-level, N fell back to top-level (line not in diff)
- N Resolved Bugs — N threads resolved, N fallback comments marked, N no-action (never posted / already resolved)
- N Investigate flags found — N posted, N skipped
- N Informational items found (not posted — low signal)
- N findings assessed not-an-issue — replied & resolved (step 6a)
- If this was a re-review and the current commit's job has no bugs and no Investigate flags: report **"re-review clean — bots quiet."** (Include the informational count.)
- Whether any findings need developer attention before moving to human review — these are the
  threads deliberately left **open**, awaiting a decision (see next section)

## Recording a developer decision ("leave as is")

Findings that crossed the caller's autonomy line go to the developer (e.g. via `preflight`'s
decision report) with their thread left **open**. When the decision comes back — typically the
developer pasting the report's copy-back block into a session — whoever processes it closes the
loop **in that same session**, per finding:

1. Find the finding's thread: the step-5 GraphQL query, matched by title (the decision-report
   item links the exact comment, which is faster still).
2. **Reply on the thread** in plain English recording the decision and the reasoning — e.g.
   "Decided not to act on this: the dialog is only reachable from the admin screen, so the
   extra guard isn't worth the complexity." Include the developer's own words/notes where
   given. Prefix with the model identifier per the user's identity conventions.
3. **Resolve the thread** (same mutation as step 6). If the finding only exists as a rung-3
   top-level comment, edit it to prepend a `Decided: leave as is — <one-line reason>` marker
   instead.

This reply-and-resolve is **unconditional** — it happens for every decided finding, whatever
the decision. (If the developer also ticked the report's `Leave comment` box, that additionally
means recording the decision as a **code comment in the repo** near the relevant code — the
caller handles that; it is separate from, not instead of, the thread reply.)

## Real Example (PR #7949)

**Bugs (3 total, 1 unresolved):**

- ✅ Post: "Legacy ebook layout name normalization fails for mixed-case input" — `SizeAndOrientation.cs:80`
- ⏭ Skip: "buildSavePageContentString calls removeEditingDebris..." — `bloomEditing.ts:1322` — Resolved
- ⏭ Skip: "Overlay can get permanently stuck if exception occurs..." — `ExternalApi.cs:240` — Resolved

**Flags (6 Investigate, several Informational):**

- ✅ Post: "Scale inconsistency in computeImageFitTopPercent..." — `autoFitImageOverTextSplits.ts:284`
- ✅ Post: "BringBookUpToDate may write to disk before per-page processing..." — `BookProcessor.cs:36`
- ⏭ Skip: All Informational items

Each posted finding went in as an **inline** review thread on its `file:line`; any whose line fell outside the diff fell back to a file-level (still resolvable) comment, and only truly un-anchorable ones to a top-level comment.

## Real Example (re-review after a fix commit)

After the developer pushed fixes, re-navigating started a new job; the jobs API showed it `running`, then `completed` for the new head sha, and its job-result had empty `bugs` and no `needs_investigation` analyses — while the *previous* commit's job still listed the old findings. Correct outcome: post nothing, resolve any threads whose bugs the new result marks fixed (step 6), log the consultation (step 7), and report **"re-review clean — bots quiet."** (Reading the old commit's job here would have wrongly re-posted the superseded bug.)

## Notes

- Devin does **not** post its findings to GitHub automatically — that is why this skill exists.
- Findings are posted as **inline review-thread comments** (anchored to the diff line, or file-level when the line isn't in the diff), not top-level PR comments, specifically so they can be resolved later. Top-level is only the last-resort rung.
- On a **re-review** (new commit), a **new job** is created; the prior commit's job (and its findings) remains in the jobs list — never post from a job whose `commit_sha` isn't the PR HEAD. Judge completeness by that job's `status` and the job-result's `lifeguard_status`/`head_sha` (see step 2), never by page text.
- Never conclude "no findings" from the rendered page — the unauthenticated layout renders none even when they exist; only the job-result JSON is trustworthy (see "Reading the review").
- A Resolved bug means Devin confirmed the PR already fixes what it found. If we **never posted** it, no GitHub action is needed. If we **did post** it in a prior run, resolve that thread now (step 6) so the comment we created doesn't linger looking unaddressed.
- Titles are the matching key between a Devin finding and the GitHub thread we posted for it, both for dedup (step 5) and resolution (step 6). Keep the `[Devin] **Bug**: <Title>` / `[Devin] **Investigate**: <Title>` format stable.
- Informational items are observations, not action items. Skip them.
- Use the `chrome-devtools` **CLI** (Bash commands) for all browser automation in this skill — not the MCP plugin (disabled; spawns zombie node processes) and not the Orca browser.
- Always use `--isolatedContext "devin-noauth"` when opening Devin pages. Navigating while logged in consumes on-demand credits; the isolated context is unauthenticated but still shows all findings.
