---
name: pr-ready-for-human
description: Promote a preflighted, self-reviewed PR to human (peer) review. Step 3 of the review sequence — (1) run preflight, (2) the developer reviews the work themselves, (3) the developer runs this. Verifies the PR is genuinely clean (CI green, bots quiet, nothing newer than the last preflight), links the PR on the tracker card and moves it to the project's ready-for-peer-review state, marks the PR ready-for-review, and moves the personal board to its human-review column. If anything is not clean, it bounces back to preflight instead of fixing things itself.
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

> The BloomBooks "PR Review Tracker" org project board (project #2) has been retired, along
> with the CI workflows that fed it. This skill no longer touches any shared board; the only
> board it moves is the developer's personal one, via the `personal-board` skill.

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
- **The PR description says what the PR is for.** Un-drafting a PR is the moment a human starts
  reading it, and the description is the first thing they read. It should state the problem, the
  cause where that isn't obvious, and what the whole PR changes — `preflight` writes exactly that
  (its "PR narrative"), between `<!-- preflight-narrative:begin/end -->` markers. This is the one
  check that does **not** bounce: if the description is missing that, or the markers are there but
  the narrative plainly predates the current code, say so in the report and offer to refresh it —
  don't hold the promotion for it, and never overwrite a description a human wrote.

### Not clean → bounce to preflight

- Report exactly what is dirty (failing checks, the unanswered comments, the unpushed work).
- If a `personal-board` skill is available, invoke it to reflect that the ball is back in the
  developer's court.
- Tell the user to re-run `preflight`, then stop. Do **not** fix, reply, or wait here.

## Stage 2 — The tracker: PR link + card state

Use the project's **tracker skill** — whichever one its `AGENTS.md`/`CLAUDE.md` declares (see
`preflight`'s "The issue tracker" section for how that declaration works and for the five
operations every tracker skill provides). This stage needs one more:

6. **Move a card to the project's "ready for peer review" state.** Ask for it *semantically* —
   the tracker skill owns the concrete vocabulary, since the state's name, and whether the
   tracker even has states, varies by tracker and project.

Then:

1. Find this branch's ticket id. No id → skip this whole stage and note it.
2. List the card's comments and check a PR link isn't already there
   (`grep -i "github.com.*pull"`) — avoid duplicates.
3. If none, post a comment: `PR: <PR URL>`.
4. **Move the card to the ready-for-peer-review state**, then confirm the tracker echoes the new
   state back.

**Never move a card backwards.** If it's already in that state, or further along (in Bloom's
YouTrack: "Ready For Testing", "Closed"), leave it and say so in the report rather than
downgrading it. That ordering is the tracker skill's knowledge, but the no-downgrade rule is
this skill's policy.

If the tracker isn't reachable, note it in the final report and continue — this is the
lowest-stakes step.

## Stage 3 — Promote

1. **Mark the PR ready for review**: `gh pr ready <n>`. Do **not** request a specific
   reviewer — choosing a reviewer is the developer's call, made outside this skill.
2. **Personal board**: if a `personal-board` skill is available, invoke it to record that the
   developer has explicitly handed this to peer review (the user running this skill is the
   explicit command that skill requires). Skip silently if unavailable.
3. **Report**: "PR #<n> is now marked ready for review; the tracker card is in its
   ready-for-peer-review state (name it). PR: <URL>" plus anything skipped (e.g. the tracker
   was unreachable).

## Rules

- Never promote with failing CI, unanswered bot comments, or without Devin having run —
  bounce to preflight instead. No exceptions except an explicit user override ("skip the
  checks, promote anyway"), which must be noted in the report.
- Never request a teammate's review; un-drafting the PR is the handoff.
- Anything posted under the user's account (the tracker or GitHub) starts with an identifier of
  which model you are.
- Always check for duplicate comments on the card before posting.
