---
name: pr-ready-for-human
description: Promote a preflighted, self-reviewed PR to human (peer) review. Step 3 of the review sequence — (1) run preflight, (2) the developer reviews the work themselves, (3) the developer runs this. Verifies the PR is genuinely clean (CI green, bots quiet, nothing newer than the last preflight), links YouTrack and moves the card to Ready For Code Review, marks the PR ready-for-review, and moves the shared and personal boards to their human-review columns. If anything is not clean, it bounces back to preflight instead of fixing things itself.
argument-hint: "optional: PR number or branch name — defaults to current worktree"
user-invocable: true
---

# PR Ready For Human Review

## Where this fits

This is **step 3** of the review sequence:

1. **`preflight`** — commits & pushes, opens a *draft* PR, runs the local review gate and the
   bot gauntlet (Devin, Greptile, CI, …), resolves or replies to bot feedback, and lands the
   work for the developer's own review. It never un-drafts the PR.
2. **The developer personally reviews the work.**
3. **This skill** — the developer invoking it *is* the explicit command to hand the work to a
   human teammate. Nothing here fixes code or waits on bots; if that's still needed, the
   answer is "go back to step 1", not a built-in repair loop.

If a new commit lands after this skill has run, the sequence restarts at step 1 —
re-run `preflight`, re-review, then run this again.

## GitHub Project Board Reference

Project: **PR Review Tracker** — https://github.com/orgs/BloomBooks/projects/2

GraphQL IDs (hardcoded — do not re-query unless these stop working):
- Project ID: `PVT_kwDOAFlSFM4Bawkp`
- Status field ID: `PVTSSF_lADOAFlSFM4BawkpzhVl0_w`
- Status option IDs:
  - `97860183` → "Waiting for AI-Review"
  - `99a3f545` → "Has Comments"
  - `05eedb52` → "Ready for Human"

## Stage 1 — Verify the PR is actually clean

Check all of the following. **Any failure → do not promote** (see "Not clean" below).

- **Everything committed & pushed**: `git status` clean, no unpushed commits
  (`git log --branches --not --remotes --oneline`).
- **An open PR exists** for the branch (`gh pr list --head <branch> --json number,url,state,isDraft`).
  No PR means preflight never ran — bounce; do not create one here, that would skip the gauntlet.
- **CI green**: `gh pr checks <n>`.
- **Bots quiet**: no unresolved bot comments/reviews newer than the last commit
  (`gh api repos/<owner>/<repo>/pulls/<n>/comments`, `.../issues/<n>/comments`, `.../pulls/<n>/reviews`).
- **Devin has run against HEAD**: use the `devin-review` skill's no-browser signals (a
  `devin-ai-integration` post covering HEAD, or the caller's durable marker — see the
  `personal-board` skill's Devin marker if available). Never promote without Devin having run.
- **Mergeable** with the base branch.

### Not clean → bounce to preflight

- Report exactly what is dirty (failing checks, the unanswered comments, the unpushed work).
- Set the shared project board card to **"Has Comments"** (`99a3f545`).
- If a `personal-board` skill is available, invoke it to reflect that the ball is back in the
  developer's court.
- Tell the user to re-run `preflight`, then stop. Do **not** fix, reply, or wait here.

## Stage 2 — YouTrack: PR link + card state

Use the **`youtrack-api`** skill for the mechanics (auth, base URL, comments):

1. Find the issue id (`BL-XXXXX`) from the branch name, PR title, or recent commits.
2. List the issue's comments and check a PR link isn't already there
   (`grep -i "github.com.*pull"`) — avoid duplicates.
3. If none, post a comment: `PR: <PR URL>`.
4. **Move the card's State to "Ready For Code Review"** (exact value name, including
   capitalization):

   ```bash
   curl -s -X POST "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>?fields=customFields(name,value(name))" \
     -H "Authorization: Bearer $YOUTRACK" -H "Content-Type: application/json" \
     -d '{"customFields":[{"name":"State","$type":"StateIssueCustomField","value":{"name":"Ready For Code Review"}}]}'
   ```

   Verify the response echoes `State = Ready For Code Review`. If the card is already in
   that state (or further along, e.g. "Ready For Testing"/"Closed"), leave it alone and note
   that instead of downgrading it.

If no YouTrack token is available, note it in the final report and continue — this is the
lowest-stakes step.

## Stage 3 — Promote

1. **Mark the PR ready for review**: `gh pr ready <n>`. Do **not** request a specific
   reviewer — choosing a reviewer is the developer's call, made outside this skill.
2. **Shared project board** → "Ready for Human":
   - Find the PR's item in project 2 (add it if missing — `addProjectV2ItemById` with the PR
     node id from `gh pr view <n> --json id`).
   - Set Status via `updateProjectV2ItemFieldValue` with option `05eedb52`.
3. **Personal board**: if a `personal-board` skill is available, invoke it to record that the
   developer has explicitly handed this to peer review (the user running this skill is the
   explicit command that skill requires). Skip silently if unavailable.
4. **Report**: "PR #<n> is now marked ready and in **Ready for Human**; YouTrack card is in
   **Ready For Code Review**. PR: <URL>" plus anything skipped (e.g. YouTrack token missing).

## Rules

- Never promote with failing CI, unanswered bot comments, or without Devin having run —
  bounce to preflight instead. No exceptions except an explicit user override ("skip the
  checks, promote anyway"), which must be noted in the report.
- Never request a teammate's review; un-drafting + the board column is the handoff.
- Anything posted under the user's account (YouTrack or GitHub) starts with an identifier of
  which model you are.
- Always check for duplicate YouTrack comments before posting.
