---
name: merge-without-peer-review
description: Merge a preflighted, self-reviewed PR without peer review, for a card whose plan was approved (YouTrack tag "Approved Plan"). The alternative to request-peer-review at step 3 of the review sequence — (1) run preflight, (2) the developer reviews the work themselves, (3) the developer runs this. Runs the same checks, squash and card cleanup as request-peer-review, then marks the PR ready, merges it, and moves the card to Ready For Testing. Refuses when the card lacks the tag or the PR is stacked on another PR, and bounces to preflight when anything is not clean.
argument-hint: "optional: PR number or branch name — defaults to current worktree"
---

# Merge Without Peer Review

## Where this fits

This is the other **step 3** of the review sequence, beside `request-peer-review`:

1. **`preflight`** lands the work in a draft PR for the developer's own review.
2. **The developer personally reviews the work.**
3. **This skill**, when the card's plan was approved in advance: a card with YouTrack's
   "Approved Plan" tag needs no peer review, so the developer's own review is the last one. The
   developer invoking this skill *is* the explicit command to merge.

## Stage 0 — May this PR be merged without peer review?

Check both before touching anything. Either failing → stop, say why, and point the developer at
`request-peer-review`.

- **The card has the "Approved Plan" tag.** Read the card's `tags(name)` through the tracker skill
  (`youtrack-api`). The tag is the team's record that peer review is optional; never infer it from
  comments or from what the developer seems to want.
- **The PR targets a real base branch, not another PR's branch.** If `baseRefName` is the head
  branch of another open PR, this PR is stacked, and merging it would land it on that branch
  instead of master. Say which PR lies beneath and stop.

## Stages 1–3 — Verify, squash, make the card accurate

Follow `before-merge-or-peer-review.md` at the root of the bloom-team-skills clone (reached via
this file's real path, not a `../` hop): Step 1 (verify the PR is clean, or bounce to
preflight), Step 2 (squash), and Step 3 (make the card accurate).

## Stage 4 — Merge

1. **Mark the PR ready**: `gh pr ready <n>`, unless it already is.
2. **Merge it**: `gh pr merge <n> --merge`. The team lands PRs with a merge commit. Do not pass
   `--delete-branch`: the worktree still has the branch checked out. Then confirm
   `gh pr view <n> --json state,mergeCommit` reports `MERGED`. If GitHub refuses, report its
   message and stop; never use `--admin` to get past a branch rule.
   Then retarget each PR stacked on this branch (`gh pr list --base <branch> --state open`) to
   the merged PR's base: `gh pr edit <m> --base <base>`. GitHub does that by itself only when the
   branch is deleted, and this skill keeps the branch.
3. **Say on the PR why nobody reviewed it**: a PR comment, starting with the attribution tag,
   saying it was merged without peer review because `<TICKET>` has the "Approved Plan" tag. A
   later reader of the PR otherwise sees a merge that nobody approved.
4. **Move the card to the project's "ready for testing" state**, through the tracker skill, and
   confirm the tracker echoes the new state back. Ask for it *semantically* — in Bloom's
   YouTrack it is `Ready For Testing`. Never move it backwards (`before-merge-or-peer-review.md`,
   Step 3). No ticket id → skip and note it.
5. **Correct the published preflight report's PR-state chip** to `merged`, as
   `before-merge-or-peer-review.md` describes.
6. **Personal board**: if a `personal-board` skill is available, invoke it to record that the work
   is merged. Skip silently if unavailable.
7. **Report**: "PR #<n> is merged into <base>; the card is in Ready For Testing. PR: <URL>",
   plus whether the report's chip was updated (with its URL), which stacked PRs were
   reconnected and retargeted, and anything skipped.

## Rules

- Never merge without the "Approved Plan" tag on the card, and never merge a stacked PR into
  the PR beneath it.
- Never merge with failing CI, unanswered bot comments, without Devin having run, or without the
  test decision — bounce to preflight instead. No exceptions except an explicit user override
  ("skip the checks, merge anyway"), which must be noted in the report and in the PR comment.
- Anything posted under the user's account (the tracker or GitHub) starts with an identifier of
  which model you are.
- Always check for duplicate comments on the card before posting.
