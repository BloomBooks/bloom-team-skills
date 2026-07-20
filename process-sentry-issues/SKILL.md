---
name: process-sentry-issues
description: '"ProcessSentryIssues N" — pick off the top N unprocessed Sentry issues for the
  project of the repo you are running in: triage each, create an attributed YouTrack card on
  the current Kanban board, fix fixable ones on their own branch and run preflight, then land
  every card in Ready For Work — with a clean draft PR, or a self-contained decider artifact
  for whatever still needs a human. Use when asked to "process sentry issues",
  "ProcessSentryIssues", or "pick off N sentry bugs".'
argument-hint: "N — how many of the top Sentry issues to pick off (default 5)"
---

# ProcessSentryIssues

Work down the top-frequency unresolved Sentry issues for the project you are fixing, end to
end: for each issue produce either a fixed branch with a draft PR, or a well-documented card a
human can pick up — always landing the YouTrack card in **Ready For Work** — and leave markers
so re-running this skill never re-processes the same issues.

**This skill is repo-agnostic.** Always run it from the repo whose crashes you want to fix
(e.g. BloomDesktop, BloomPlayer). The repo determines the Sentry project, the GitHub
owner/name, and the base branch — resolve all of these at the start of the run rather than
assuming any particular product.

**Constants** (resolve at the start of the run; verify, don't assume, when they matter):
- **Repo / GitHub**: the repo you're running in. Get `owner/name` and the default base branch
  from `gh repo view --json nameWithOwner,defaultBranchRef` (fall back to `git remote` +
  `git symbolic-ref refs/remotes/origin/HEAD`). Use these everywhere below in place of any
  hard-coded repo name or `master`.
- **Sentry**: org `bloom-app`. The **project matches the repo you're fixing** — e.g.
  `bloom-desktop` for BloomDesktop, `bloom-player` for BloomPlayer. At run start, resolve the
  project slug and its numeric id for this repo (`sentry projects list`, or
  `sentry api "/api/0/organizations/bloom-app/projects/"`); if it's ambiguous, ask the user
  once. The CLI `sentry` is installed; check `sentry auth status` first and ask the user to run
  `! sentry auth login` if unauthenticated.
- **YouTrack**: project **Bloom** (`BL`), tracker `https://issues.bloomlibrary.org/youtrack`
  (bugs for the various Bloom products all live here). Mechanics live in the `youtrack-api` and
  `youtrack-create-issue` skills.
- **Kanban Board sprint**: the **current release board** (as of 2026-07: `Bloom 6.5`). If
  unsure which is current, ask the user once at the start of the run.

## Authorization

Invoking this skill is the user's standing authorization (given 2026-07-18) for the whole
pipeline, without stopping to re-confirm each write:
- create YouTrack issues and set their Type/board/State (up to and including **Ready For
  Work** — never further; this skill does not promote cards into code review);
- post notes on Sentry issues and **archive** issues judged pure noise (never mark anything
  "resolved" — that happens when a fix actually ships);
- everything `preflight` itself authorizes (commit, push, draft PR, bot replies, Devin, …).

Still forbidden: promoting any card past **Ready For Work** (e.g. to `Ready For Code Review`)
or marking any PR ready-for-review — a human picks the work up from Ready For Work; moving
anything to the personal board's **Peer Review** column (see `personal-board` — finished work
lands in *Personal Review*); dismissing human PR comments; and any Sentry status change other
than archiving pure noise.

## Attribution — every word you post is signed

The Sentry/YouTrack/GitHub tokens belong to a human developer. Every issue description,
comment, note, and PR body you post must begin with `[Claude <your model name>]` and, where
it's a YouTrack issue description, a first line like:

> [Claude Opus 4.8] This issue was created by an AI agent working through the Sentry error
> logs on behalf of John Hatton — analysis and text are the agent's, not John's.

## Step 1 — Inventory and de-duplication

1. Fetch the top unresolved issues by 90-day frequency for **this repo's project** — use the
   API (the CLI's default fields omit counts), asking for ~4×N so there's room to skip
   processed ones:
   ```bash
   MSYS_NO_PATHCONV=1 sentry api "/api/0/organizations/bloom-app/issues/?project=<numericProjectId>&query=is%3Aunresolved&sort=freq&statsPeriod=90d&limit=<4N>"
   ```
   (In Git Bash, `MSYS_NO_PATHCONV=1` is required or the leading `/api/...` gets mangled into
   a `C:/Program Files/Git/...` path and every call 404s.)
2. An issue is **already processed** — skip it — if any of:
   - YouTrack has a card whose summary contains its short id (search
     `query=summary: <SHORT-ID>` via `youtrack-api`);
   - the Sentry issue has a note starting `[claude-sentry-triage]`
     (`MSYS_NO_PATHCONV=1 sentry api "/api/0/organizations/bloom-app/issues/<numericId>/notes/"` —
     numeric id from the issue JSON `id` field);
   - it is archived/ignored (archived issues don't appear in `is:unresolved` anyway).
3. **Cluster** unprocessed issues that share one root cause (same title pattern, same culprit,
   locale variants of the same message). A cluster is ONE work item — one card, one branch,
   one PR — but each member issue counts toward N and gets its own Sentry note.
4. Take the top N issues (as clustered work items) and process each work item per Step 2 —
   in parallel, one sub-agent per work item, each in its own worktree (they must not share a
   checkout; review bots run in parallel so there's no serialization benefit).

## Step 2 — Per work item

### 2a. Investigate and classify

Triage from the real data, not the title: `sentry issue view <SHORT-ID>` (stack, mechanism,
tags, releases, breadcrumbs; `sentry event list` for more events), then read the actual code
in the repo. Classify:
- **fixable** — a targeted fix (roughly ≤ a day) addresses the root cause. This *includes*
  environmental noise that should be screened out in code (e.g. a `BeforeSend` filter, a
  disposal guard, a retry): screening out noise is a fix.
- **too-hard** — real bug, but needs investigation/redesign beyond an autonomous fix.
- **pure-noise** — nothing in code worth changing at all (rare; prefer screening).

### 2b. Create the YouTrack card (always, except pure-noise)

Follow `youtrack-create-issue` mechanics (create → Type → board sprint → State; board before
State or the workflow rule rejects it). Look up ids dynamically.
- **Summary**: `[Sentry] <SHORT-ID(s)>: <concise description>` — the short id(s) in the
  summary are the primary dedup key; never omit them.
- **Description** (Markdown): attribution first line (see above); links to the Sentry
  issue(s); a stats table — events + users for 90d, first/last seen, affected releases;
  root-cause analysis; for fixable items the planned fix, for too-hard items everything a
  human needs to pick it up.
- **Type**: `Bug`. **Kanban Board**: current release sprint.
- **State**: `Ready For Work` (verify the exact state-value spelling via the project's
  custom-field values). Every card this skill creates lands here — the fix branch/PR is a
  head start for whoever picks it up, not a promotion past this state.

### 2c. Mark the Sentry side (always)

Post a note on **every** Sentry issue covered (this is the re-run guard):
```bash
MSYS_NO_PATHCONV=1 sentry api "/api/0/organizations/bloom-app/issues/<numericId>/notes/" \
  --method POST --data '{"text":"[claude-sentry-triage] <verdict> — <BL-XXXX link or reason> (<date>)"}'
```
For **pure-noise** issues additionally `sentry issue archive <SHORT-ID>` (note first, then
archive; say in the note that it should be un-archived if it recurs).

### 2d. Fix (fixable items only)

1. Create a dedicated worktree and branch off the base branch (never work on a shared
   checkout; use the base branch you resolved in Step 1's Constants):
   ```bash
   git fetch origin
   git worktree add D:/orca-worktrees/bloom/<branch> -b BL-<n>-sentry-<slug> origin/<baseBranch>
   ```
2. Read that worktree's `AGENTS.md` (and any repo-specific skills) and honor them — build/test
   quirks, package-manager rules, forbidden commands, and dependency-bootstrap steps vary by
   repo. (For example, in BloomDesktop: build/test C# through `build/agent-dotnet.sh` rather
   than bare `dotnet` because a running Bloom may lock the shared output, use pnpm only, never
   `pnpm build`, and `./init.sh` if dependencies are missing.)
3. Implement the smallest fix that genuinely addresses the root cause — repo code style,
   comments on public methods, tests where they'd catch a regression. If the "fix" is a
   Sentry filter, scope it tightly (specific exception type + mechanism + message), and put a
   comment in the code naming the Sentry short id(s) so future readers know why it exists.
4. Run the **`preflight`** skill on the branch (default light review level). This produces a
   tested, pushed draft PR and its report — it does **not** promote the PR or the card.

### 2e. After preflight — land the card in Ready For Work

Whether or not preflight came back clean, the card stays in **Ready For Work** and the PR
stays a **draft**. This skill never un-drafts a PR or promotes a card — a human takes it from
here. What differs is what you attach for that human:

**Clean** (preflight's decision report has zero items needing a human):
- YouTrack: add a PR-link comment (dedup-checked, attributed) noting the draft PR is green and
  ready for a human to review and un-draft.
- Leave the PR as a draft. (No `gh pr ready`, no board promotion.)

**Needs a human** (decision items remain, a reviewer timed out, or the fix stalled):
1. Preflight already produced its report artifact with decision controls and a copy-back
   block (per the `decider` spec). Because this link goes on a YouTrack card for a human or
   another agent to open, it **must be publicly readable** — publish the report to the
   **`dev-process-artifacts`** repo and use its githack URL (see `../dev-process-artifacts.md`),
   not a subscriber-only Anthropic Artifact. Verify the copy-back block is **fully self-contained for
   a zero-context agent in a fresh session** — its header must name: the repo (`owner/name`),
   the branch, the PR URL, the YouTrack id, the public artifact URL, and explicit resume
   instructions, e.g. "In a clone of `<owner/name>`, create a worktree for branch `<branch>`
   (`git fetch origin && git worktree add D:/orca-worktrees/bloom/<branch> <branch>`), read
   PR #<n> and BL-<n>, then apply the decisions below." If the artifact's block lacks any of
   that, regenerate/patch it.
2. YouTrack: comment (attributed) with the public artifact URL and a one-line "what's blocked
   on a human decision".
3. Leave the PR draft. Personal board (if available): the "needs response" state.

## Step 3 — Report

One table row per work item: Sentry id(s) + 90d events/users, verdict, YouTrack id (all in
Ready For Work), branch/PR (all draft), artifact link (if any), and anything skipped or timed
out. Also list the issues skipped as already-processed. Total events/90d addressed is the
headline number.

## Rules

- Dedup is sacred: no card without the short id(s) in the summary; no processed Sentry issue
  without its `[claude-sentry-triage]` note. These two markers are what make re-runs safe.
- Never re-process an issue that has a marker — even to "improve" it — unless the user
  explicitly asks.
- Attribution prefix on every posted body (YouTrack, Sentry, GitHub).
- Every card lands in Ready For Work; never promote past it and never mark a PR
  ready-for-review — that's a human's call.
- Localizable strings touched → follow the repo's XLF-strings skill/guidance if it has one.
- Sentry API rate limit is modest (~40 req/min): with parallel work items, don't poll Sentry
  in tight loops.
- Degrade gracefully: a missing token (YouTrack/Sentry/gh) stops that write, not the run —
  record it in the report.
