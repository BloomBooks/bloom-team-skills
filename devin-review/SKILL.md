---
name: devin-review
description: Kick off a Devin AI code review for a GitHub PR, wait for it, then post unresolved Bugs and Investigate flags as GitHub inline review-thread comments, and resolve the threads for findings Devin now considers fixed. Devin does NOT post to GitHub automatically — this skill bridges that gap.
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

## Page Structure

The right sidebar of the review page has two tabs: **Info** and **Chat**.

### The "View results" gate

When analysis finishes, the Info tab may show only an **"Analysis complete"** card with a **"View results"** button — the Bugs/Flags sections are **not rendered until you click it**. Do not conclude "no findings" from an initial snapshot; click "View results" first (see Procedure §3). (Older/other layouts show the sections inline; clicking is then a no-op.)

### Outdated findings (after a new commit)

When a new commit is pushed, Devin re-analyzes. While it regenerates — and sometimes after — the **previous commit's** findings remain on the page grouped under **`Outdated N Bug`** / **`Outdated N Flag`** regions. These are superseded; **never post or re-post them**. Only findings that are **not** inside an `Outdated …` region are current. The header counts (e.g. `1 Bug`) can be the count *inside* an Outdated region, so trust the finding **buttons and their region**, not the header text.

The **Info** tab contains:

### Bugs section

Header shows **"N Bug"** where N = count of *unresolved* bugs. Click to expand if collapsed.

Each bug entry:

```
{Title}
Bug  {file}:{line}             ← unresolved
{Title}
Bug  {file}:{line} • Resolved  ← already fixed; skip
```

→ **Post unresolved Bugs to GitHub** as inline review-thread comments. **Resolved** bugs need cross-run reconciliation: if we posted the bug in a prior run, resolve its GitHub thread now; if we never posted it, no action (it was already fixed when Devin first saw it). See step 6.

### Flags section

Header shows **"N Flags"**. Click to expand — it is collapsed by default.

Contains two sub-categories:

**Investigate** items (post these):

```
{Title}
Investigate  {file}:{line-range}
```

**Informational** items (skip these — these are the low-signal "comments"):

```
{Title}
Informational  {file}:{line-range}
```

→ **Post Investigate flags to GitHub. Skip Informational flags.**

### Other sidebar fields

Checks, Reviewers, Assignees, Labels — these are metadata only, no action from this skill.

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

### 2. Check if Review is Complete (and analyzing the *current* commit)

Do **not** grep the page for `Bug`/`Flags` to decide completeness — those words appear in the PR description and in stale `Outdated` regions, so a cached prior-commit review reads as "done." Instead:

**a. Know the commit you expect.** Capture the PR head SHA up front (also reused in steps 5–7):

```bash
HEAD_SHA=$(gh pr view <number> --repo <owner>/<repo> --json headRefOid --jq .headRefOid)
```

**b. Completion = generation finished, not text match.** There are **two** independent progress markers and you must wait for **both** to clear:

- `Generating` (or `Generating…`) — the left **"Devin's AI analysis" summary** panel.
- `PR analysis in progress` — the right **Info sidebar**, which runs the actual **findings** pass (Bugs/Flags) and finishes *later* than the summary.

⚠️ The summary panel finishes well before the findings pass. If you check only `Generating`, you will see it clear while the Info sidebar still says `PR analysis in progress`, open the results, and wrongly conclude **zero findings** — the bug/flag list is still being generated. (This exact trap hid the one real bug on PR #613 on the first poll.) Reload, then confirm **both** are gone:

```bash
chrome-devtools navigate_page --type reload --ignoreCache true >/dev/null; sleep 6
chrome-devtools evaluate_script "() => document.body.innerText.includes('Generating')"          # expect false
chrome-devtools evaluate_script "() => /analysis in progress/i.test(document.body.innerText)"    # expect false
```

- either `true` → still analyzing. Come back in ~2–3 min (poll; typical run is 10–20 min). **Timeout 30 min** from trigger.
- **both** `false` → analysis done. Proceed to §3 (which opens "View results" and reads only current, non-Outdated findings).

Make the **first** check ~30 s after the trigger, not minutes later — re-reviews of small deltas
often finish faster than a lazy first poll, and every extra interval is dead time the developer
sits through.

**c. Staleness on a re-trigger — one cache-busted reload settles it; then believe the page.**
Right after navigating to re-review a new commit, the *first paint* can show the **previous**
commit's cached findings before the page catches up. The cure is exactly **one**
`--ignoreCache` reload, then a freshness check: the page header shows a **`Commits N`** count —
compare it to the PR's actual commit count:

```bash
chrome-devtools evaluate_script "() => { const t=document.body.innerText; const m=t.match(/Commits\s*(\d+)/); return {commits: m?m[1]:'?', gen: t.includes('Generating'), prog: /analysis in progress/i.test(t)}; }"
```

- Commit count matches the PR **and** both markers are `false` → the analysis shown **is** the
  terminal state for `$HEAD_SHA`. Proceed to §3 immediately.
- Commit count is stale → reload again after ~30 s; the page hasn't seen the push yet.
- Markers `true` → normal §2b polling.

⚠️ Do **not** demand *more* evidence than that. Two real over-waits (bloom-harvester PR #234,
2026-07-14, user had to interrupt twice) came from exactly this: requiring an observed
`Generating` transition, or two consecutive idle polls, or waiting for `Outdated` / `• Resolved`
markers to appear before believing "done". A small-delta re-review can complete inside the first
poll interval (and may never visibly restart), so a wait gated on watching the restart happen —
or on markers Devin may not render — never fires and just runs to its timeout on a
long-finished review.

### 3. Enumerate Findings

First open the Info tab and click **"View results"** (the gate — see Page Structure), then expand the Flags section:

```bash
# Open Info tab + click "View results" if present
chrome-devtools evaluate_script "() => { const info=[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='Info'); info?.click(); const vr=[...document.querySelectorAll('button,a')].find(e=>/view results/i.test(e.textContent)); vr?.click(); return vr?'opened results':'no gate (inline)'; }"
sleep 2
# Expand the Flags section if collapsed
chrome-devtools evaluate_script "() => { const btn = [...document.querySelectorAll('button')].find(el => /Flag/.test(el.textContent) && el.getAttribute('aria-expanded')!=='true'); btn?.click(); return btn?.textContent?.trim(); }"
sleep 2
```

Then snapshot to get accessible UIDs for all finding buttons:

```bash
chrome-devtools take_snapshot 2>/dev/null | grep -E "Bug|Investigate|Informational|Resolved|Outdated"
```

Each finding appears as a button whose accessible name contains the title, type label (`Bug`, `Investigate`, `Informational`), and file:line. Resolved bugs additionally contain `• Resolved`. Findings under an `Outdated N Bug`/`Outdated N Flag` **region** belong to a superseded commit.

Collect:

- **Unresolved Bugs**: button text contains `Bug`, NOT `• Resolved`, NOT under an `Outdated …` region — to post (step 5)
- **Investigate flags**: button text contains `Investigate`, NOT under an `Outdated …` region — to post (step 5)
- **Resolved Bugs**: buttons containing `• Resolved` — record their titles; used to reconcile/resolve GitHub threads (step 6). Do NOT post these.
- **Skip entirely**: `Informational` items (low signal, no post, no reconcile), and **anything under an `Outdated …` region**

If *every* current Bug/Flag sits under an `Outdated …` region and there are no non-outdated findings, the re-review is **clean** — post nothing (still do step 6 for any `• Resolved` bugs, and step 7 logging).

### 4. Extract Full Descriptions

Each finding has a **full description** visible only after clicking the finding button. Always extract it — the one-line summary alone is not enough for a useful GitHub comment.

For each finding to post (unresolved Bug or Investigate):

```bash
# Click the finding button by its UID from the snapshot
chrome-devtools click "{uid}"
sleep 2

# Extract: title + body up to the action buttons
# "Ask Devin" is a reliable end-of-description marker for both Bug and Flag panels.
# The dismiss buttons just before it are "Copy bug"/"Copy flag"/"Prompt for agents".
chrome-devtools evaluate_script "() => { var t = document.body.innerText; var askD = t.indexOf('Ask Devin'); var copyIdx = t.lastIndexOf('Copy ', askD); var promptIdx = t.lastIndexOf('Prompt for agents', askD); var end = Math.min(copyIdx > 0 ? copyIdx : askD, promptIdx > 0 ? promptIdx : askD); var start = t.lastIndexOf('TITLE_PREFIX', end); return start >= 0 ? t.slice(start, end).trim() : 'not found'; }"

# Dismiss the panel before clicking the next finding
chrome-devtools press_key "Escape"
sleep 1
```

Where `TITLE_PREFIX` is a distinctive prefix of the finding title (enough to be unambiguous in the page text — avoid words like "the", "a", file names that appear in code diffs).

The extracted text will be: `{Title}\n\n{Full description paragraphs}`

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

### 6. Reconcile Resolved Findings

For each bug Devin now marks **• Resolved** (collected in step 3), match it by title against the Devin threads gathered in step 5:

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

Note: Investigate flags have no "Resolved" state in Devin — when Devin stops flagging one, it simply disappears from the list (or moves to an `Outdated` region on a re-review). Do **not** auto-resolve threads for vanished/outdated flags (no reliable signal); leave those for the human reviewer.

### 7. Log that Devin was run — even if it found no issues

Because it is quite expensive to consult Devin, it's important that we can avoid consulting it if we know that we have not committed anything since the last time we consulted it. For this reason, whenever a consultation with Devin is finished, add a comment to the PR: "Consulted Devin on (date time) up to commit (SHA)". Of course it is vital that we actually gave Devin sufficient time to do the check (step 2) before we decide it has no new findings.

### 8. Report

Return a summary:

- N unresolved Bugs found — N posted, N skipped (already posted), N fell back to file-level, N fell back to top-level (line not in diff)
- N Resolved Bugs — N threads resolved, N fallback comments marked, N no-action (never posted / already resolved)
- N Investigate flags found — N posted, N skipped
- N Informational items found (not posted — low signal)
- If this was a re-review and all prior findings are now `Outdated`/resolved with no current findings: report **"re-review clean — bots quiet."**
- Whether any findings need developer attention before moving to human review

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

After the developer pushed fixes, re-navigating showed `Generating…`, then completed with the prior findings grouped under **`Outdated 1 Bug`** and **`Outdated 1 Flag`** and **no current findings**. Correct outcome: post nothing, resolve any threads whose bugs are now `• Resolved` (step 6), log the consultation (step 7), and report **"re-review clean — bots quiet."** (A naive `grep "Bug|Flags"` here would have wrongly re-posted the outdated bug.)

## Notes

- Devin does **not** post its findings to GitHub automatically — that is why this skill exists.
- Findings are posted as **inline review-thread comments** (anchored to the diff line, or file-level when the line isn't in the diff), not top-level PR comments, specifically so they can be resolved later. Top-level is only the last-resort rung.
- On a **re-review** (new commit), prior findings show under `Outdated …` regions — never re-post them. Judge completeness by **both** the `Generating…` (summary) **and** `PR analysis in progress` (Info sidebar / findings pass) markers clearing for the current head SHA, not by matching "Bug"/"Flags" text — the summary finishes before the findings pass (see step 2b).
- Findings may hide behind a **"View results"** button; click it before concluding there are none.
- A Resolved bug means Devin confirmed the PR already fixes what it found. If we **never posted** it, no GitHub action is needed. If we **did post** it in a prior run, resolve that thread now (step 6) so the comment we created doesn't linger looking unaddressed.
- Titles are the matching key between a Devin finding and the GitHub thread we posted for it, both for dedup (step 5) and resolution (step 6). Keep the `[Devin] **Bug**: <Title>` / `[Devin] **Investigate**: <Title>` format stable.
- Informational items are observations, not action items. Skip them.
- Use the `chrome-devtools` **CLI** (Bash commands) for all browser automation in this skill — not the MCP plugin (disabled; spawns zombie node processes) and not the Orca browser.
- Always use `--isolatedContext "devin-noauth"` when opening Devin pages. Navigating while logged in consumes on-demand credits; the isolated context is unauthenticated but still shows all findings.
