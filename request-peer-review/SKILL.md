---
name: request-peer-review
description: Hand a preflighted, self-reviewed PR to a teammate for peer review. Step 3 of the review sequence — (1) run preflight, (2) the developer reviews the work themselves, (3) the developer runs this. Verifies the PR is genuinely clean (CI green, bots quiet, nothing newer than the last preflight), squashes the branch to a single commit (unless the commit split genuinely helps the reviewer), links the PR on the tracker card, makes the card accurate about the PR, and moves it to the project's ready-for-peer-review state, marks the PR ready-for-review, and moves the personal board to its human-review column. If anything is not clean, it bounces back to preflight instead of fixing things itself. For a card tagged "Approved Plan", merge-without-peer-review is the alternative.
argument-hint: "optional: PR number or branch name — defaults to current worktree"
---

# Request Peer Review

## Where this fits

This is **step 3** of the review sequence:

1. **`preflight`** — commits & pushes, opens a *draft* PR, runs the local review gate and the
   bot gauntlet (Devin, Greptile, CI, …), resolves or replies to bot feedback, and lands the
   work for the developer's own review. It never un-drafts the PR.
2. **The developer personally reviews the work.**
3. **This skill** — the developer invoking it *is* the explicit command to hand the work to a
   teammate for peer review. When the card has YouTrack's "Approved Plan" tag, peer review is
   optional, and the developer may run `merge-without-peer-review` instead.

## Stages 1–3 — Verify, squash, make the card accurate

Follow `before-merge-or-peer-review.md` at the root of the bloom-team-skills clone (reached via
this file's real path, not a `../` hop): Step 1 (verify the PR is clean, or bounce to
preflight), Step 2 (squash), and Step 3 (make the card accurate).

## Stage 4 — Hand off

1. **Mark the PR ready for review**: `gh pr ready <n>`. Do **not** request a reviewer.
   The team usually doesn't assign one, so un-drafting is the whole handoff: don't list "choose a
   reviewer" as something left to do. If Stage 1
   already found `isDraft: false` (the author un-drafted it by hand), skip the call and say so —
   but still do the steps below, which is precisely the case that leaves a stale report behind.
2. **Wait for the review bots that leaving draft wakes**, as "Taking the PR out of draft wakes
   the review bots" in `before-merge-or-peer-review.md` describes. Findings put the PR back in
   draft and bounce to preflight; the card has not moved yet, so nothing else needs undoing.
3. **Move the card to the project's "ready for peer review" state**, through the tracker skill,
   and confirm the tracker echoes the new state back. Ask for it *semantically* — the tracker skill
   owns the concrete vocabulary (in Bloom's YouTrack, `Ready For Code Review`). Never move it
   backwards (that file's Step 3).
4. **Correct the published preflight report's PR-state chip** to `ready`, as
   `before-merge-or-peer-review.md` describes.
5. **Personal board**: if a `personal-board` skill is available, invoke it to record that the
   developer has explicitly handed this to peer review (the user running this skill is the
   explicit command that skill requires). Skip silently if unavailable.
6. **Report**: "PR #<n> is now marked ready for review; the tracker card is in its
   ready-for-peer-review state (name it). PR: <URL>" plus whether the published preflight report's
   PR-state chip was updated (with its URL), which stacked PRs Stage 2 reconnected, and anything
   skipped (e.g. the tracker was unreachable).

## Rules

- Never hand off with failing CI, unanswered bot comments, without Devin having run, or without
  the test decision —
  bounce to preflight instead. No exceptions except an explicit user override ("skip the
  checks, hand it off anyway"), which must be noted in the report.
- Never request a teammate's review; un-drafting the PR is the handoff.
- **Whenever the PR's draft state changes — or you find a human already changed it — the published
  preflight report has to agree.** A report that still shows "Draft PR" is read by the reviewer and
  by whoever picks the card up later.
- Anything posted under the user's account (the tracker or GitHub) starts with an identifier of
  which model you are.
- Always check for duplicate comments on the card before posting.
