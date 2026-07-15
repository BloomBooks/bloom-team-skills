---
name: preflight
description: Run the automated pre-review checklist on the current branch — the work before the "flight" of human review. Local quality gate, commit & push, draft PR, then trigger and WAIT for every async reviewer (Devin, other review bots, CI) to actually finish — auto-fixing and auto-replying to bots — refresh the QA test-ideas comment on the YouTrack card, and finish with a decision report of anything that genuinely needs the user. Local review level -- light single-sub-agent pass by default; "thorough review"/"expensive review" = full /code-review + fix loop; "without review" = skip it. Never marks the PR ready-for-review and never requests a teammate's review (that's pr-ready-for-human).
argument-hint: "optional: PR number or branch name — defaults to the current branch/worktree. Review level: 'thorough review' or 'without review'."
user-invocable: true
---

# Preflight

Goal: run the pre-review preflight on whatever is on the current branch — make it the best,
ready-to-go version of itself, doing everything reasonable without the user, then hand back a
decision report for anything that needs a human. This is the checklist *before* the flight of
human review/merge; it does not ship or promote anything itself.

**Core principle:** front-load all autonomous work. Batch every human decision into the final
report. When the user's attention returns, the only things left should be ones that genuinely
need them. Do **not** stop mid-run to ask.

If the branch turns out to have nothing new (no uncommitted work, no commits beyond the base,
or a PR already clean), still run the gauntlet against the current HEAD — preflight is
re-entrant and "verify everything is still green" is a valid run.

## Authorization — invoking this skill IS your permission to write to GitHub

Running `/preflight` is the user's **explicit, durable authorization** to perform every
outward-facing GitHub write this skill defines, autonomously and **without stopping to
re-confirm**. The general "outward-facing actions need confirmation first" guard does **not**
apply to these — the skill invocation already granted them:
- commit and push the branch;
- create a **draft** PR, or convert an existing PR back to draft;
- post replies to **bot** comments/reviews (including telling a bot it's mistaken);
- trigger Devin and, via `devin-review`, mirror its findings as inline review threads, resolve
  the threads for findings Devin now considers fixed, and add the "Consulted Devin … up to
  `<SHA>`" log comment;
- resolve/close the review threads this workflow owns.

Do not pause to ask "should I publish this?" for any of the above — publishing bot feedback and
the Devin record to the PR is the point of the run. The authorization is **scoped to that list**.
It does **not** extend to: marking the PR ready-for-review, requesting a teammate's review, or
**replying to / dismissing a *human* comment you disagree with** — those still cross the autonomy
line and go to the decision report.

This is *intent* authorization for the agent; it is **not** harness permission. In **auto mode**
the classifier can still **deny** these `gh` writes ("denied by the Claude Code auto mode
classifier") — the skill can't grant itself that permission. If a GitHub write is blocked, don't
work around it: surface the item in the decision report and note that the write is pending on a
one-time settings change. See the repo README's **"Making the review skills actually autonomous"**
for the `autoMode.allow` / `permissions.allow` setup that unblocks it.

## Autonomy line — when to REPORT instead of act

Do it yourself when it's safe and clear. Put it in the decision report (and keep going on
everything else) when it is any of:
- a change to **user-facing behavior or a public API/interface/contract**;
- a **large or architecturally-significant** change, or one touching **many files**;
- a **semantic** merge conflict (resolve only trivial ones — lockfile, imports, formatting);
- **disagreeing with a human comment** (always report; never auto-dismiss a human).

Disagreeing with a **bot** does *not* need the user — post a reply and move on.

## The reviewers

Every preflight run answers to the same panel of reviewers. Define it once here; every later
phase says "each reviewer" and means this list:

1. **The local review** (Phase 1) — runs in-session at the user's chosen level. Its outcome
   (level ran, findings raised / fixed / escalated / dismissed, or "clean", or "skipped at
   user request") is captured and reported as a reviewer row like any other — never silently
   omitted.
2. **Devin** — available for **every** GitHub PR via its review page
   (`https://devinreview.com/<owner>/<repo>/pull/<n>`, alias of `app.devin.ai/review/…` —
   literally the PR's `github.com` URL with the host swapped). It needs **no GitHub app, no CI
   workflow, and no prior comment** to be usable; the absence of a `devin-ai-integration`
   comment or a `pr-automation`/`Devin Review` check proves **nothing** and must never be read
   as "Devin isn't configured here." The only per-repo difference is the *trigger*:
   BloomDesktop auto-triggers Devin on push via `pr-automation.yml`; on any other repo you
   trigger it yourself by loading the review URL. **Always run Devin.** All Devin mechanics —
   triggering, waiting, gathering, mirroring findings — go through the **`devin-review`** skill.
3. **Comment-posting review bots detected on this repo** (e.g. Greptile, CodeRabbit). Detect
   via a prior review/comment from the bot, a check context in `gh pr checks <n>`, or a config
   file (`.greptile*` / `.coderabbit*`). They trigger themselves on push.
4. **CI** — the PR's checks (`gh pr checks <n>`).

**Terminal-state rule (the rule this skill exists to enforce):** the run is not done until
every reviewer is in exactly one of two states for the **current HEAD sha**:
- **complete** — its review finished and its findings were folded into the fix/reply loop; or
- **timed out** — we waited the cap and it hadn't finished, recorded verbatim as **"timed out
  after N min"** (with a note that re-running `preflight` folds in late results).

A reviewer still analyzing has not "passed" — it just hasn't spoken yet. **"Pending" / "still
running" is never an acceptable terminal outcome.** If you are about to write "pending" as a
reviewer's final status, you have exited too early — go back and wait it out or record the
timeout.

## Phase 0 — Discover

- Identify branch, base (default `master`/`main` — confirm via remote HEAD), and `owner/repo`
  from `git remote get-url origin`.
- Extract a YouTrack ticket id from the branch name if present (a `BL-1234`-style prefix).
- Detect the toolchain — **every stack present, not just Node**: package manager from the
  lockfile (`pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, else npm) and the **typecheck / lint /
  test / build** commands from `package.json` `scripts`; a .NET solution (`*.sln` /
  `*.csproj`) → `dotnet build` / `dotnet test`; likewise any other stack in the repo. Record a
  **non-watch** test command per stack (prefer a `test:ci`/`run` variant; NEVER launch a
  watch-mode runner — it hangs). Fallbacks: typecheck → `<pm> exec tsc --noEmit`; lint → the
  `lint` script.
- Look for a **private board skill** the user has (a skill whose job is their personal
  work/review board). If found, invoke it to mark this worktree as actively being worked on, and
  use it for all later board moves. If none, skip board steps silently.

## Phase 1 — Local quality gate (loop until clean)

**The fast gate — run at every level, and before every push:** repeat until **typecheck**,
then **lint**, then **fast tests** (only changed/related tests, non-watch) all pass. Fix
what's safely fixable; report the rest. (The FULL test suite deliberately runs later, once,
overlapped with the bot wait — see Phase 4.)

The local review runs at one of three levels — the full `/code-review` + fix loop chews up a
lot of tokens, so it is opt-in:

- **Light (the DEFAULT):** dispatch ONE general-purpose subagent over the working diff.
  Prompt it to: read the diff plus just enough surrounding code to judge it; report only
  **clear, high-confidence correctness problems** (bugs, broken edge cases, misused APIs,
  unintended behavior changes) — no style points, no nits, no refactor ideas, no "consider…";
  and return a short structured list (file:line, what breaks, why it's wrong). One pass, no
  verification loop, no re-review after fixes (typecheck/lint/tests are the re-check).
- **Thorough** — only when the user asked for a **"thorough review"** or **"expensive
  review"** (both phrasings mean the same thing — since preflight always includes *a* review,
  "with code-review" would be ambiguous). Each cycle: run the `/code-review` skill at `high`
  effort with `--fix` on the working diff; findings that cross the autonomy line are NOT
  applied — decision report; run the fast gate; re-run `/code-review` to confirm nothing
  remains. Cycle.
- **None** — only when the user asked (e.g. **"/preflight without review"**), for
  tiny/mechanical changes: skip straight to the fast gate.

Triage findings the same way at every level: safe and clear → fix; crosses the autonomy line →
decision report; wrong → dismiss with a one-line reason. **Capture the outcome for the
reviewer row** (see "The reviewers"): level ran, findings raised / fixed / escalated /
dismissed. If it found nothing, record "clean" explicitly; if skipped, record "skipped at user
request ('without review')".

Cap the loop at **4 cycles** to avoid churn; note in the report if capped.

## Phase 2 — Publish (commit, push, draft PR)

- Stage & commit everything on the branch (including pre-existing uncommitted work — that's
  "what's on the branch"). Message: `<concise summary> (<TICKET>)` plus the repo/user's required
  commit trailer, identifying which model you are. Let pre-commit hooks run.
- Push, setting upstream if needed.
- Ensure a **draft** PR exists: `gh pr list --head <branch> --json number,url,state,isDraft`.
  - None → create one: write the body (`<summary>` + `Ref: <tracker-url-if-known>`) to a temp
    file and `gh pr create --draft --base <base> --title "<summary> (<TICKET>)" --body-file
    <file>` (a literal `--body "...\n..."` won't expand `\n` in PowerShell — always use
    `--body-file`).
  - Exists but is **ready-for-review** → convert it back to draft (`gh pr ready <n> --undo`):
    preflight means the work is pre-review again. Note the conversion in the report.
  - (Do NOT do the promote-to-human ceremony — that's `pr-ready-for-human`.)
- Record PR number & URL.
- **Link the PR on the tracker card (once).** If a ticket id was found in Phase 0, use the
  **`youtrack-api`** skill for the mechanics: list the issue's comments, check a PR link isn't
  already there (`grep -i "github.com.*pull"`), and only if none post a comment `PR: <PR URL>`
  (prefixed with an identifier of which model you are). This is idempotent — never post a second
  PR link. If no YouTrack token is available or no ticket id was found, skip silently and note it
  in the report. (`pr-ready-for-human` performs the same dedup-checked step later, so a link
  posted here means that step finds it already present and does nothing.)

## Phase 3 — Mergeability with the base

- `git fetch origin`. Determine whether the branch merges cleanly into `origin/<base>`.
- No conflicts → continue.
- **Trivial** conflicts (lockfile, imports, formatting) → merge base in, resolve, re-run the
  fast gate, push.
- **Semantic** conflicts → decision report; (via the board skill) a "needs response" state.

## Phase 4 — Bot gauntlet

The gauntlet runs every reviewer (see "The reviewers") to a terminal state. The local review
already ran in Phase 1; its captured outcome joins the results here.

1. **Trigger Devin** for the current HEAD via the `devin-review` skill (on BloomDesktop the
   push already triggered it via CI; elsewhere the skill loads the review URL — either way it
   runs, never skip it as "not set up"). Record that it was triggered for this commit. Detect
   which comment-posting bots are active (see "The reviewers"). The other reviewers trigger
   themselves on push.
2. **First pass — gather whatever feedback is already available and act on it** (don't idle
   waiting for the slow ones yet):
   - CI: `gh pr checks <n>`.
   - Bot comments/reviews via `gh api repos/<owner>/<repo>/pulls/<n>/comments`,
     `.../issues/<n>/comments`, `.../pulls/<n>/reviews`. Consider items newer than our last
     commit / not yet resolved.
   Evaluate each item:
   - Clear, correct, within the autonomy line → **fix it**.
   - Bot is mistaken → **post a reply on GitHub** explaining why (prefix the body with an
     identifier of which model you are) **and resolve the thread** — a documented, resolved
     thread is the record that we considered it. No need to ask the user. Only clear-cut
     calls get closed this way; judgment calls go to the decision report with their thread
     left **open** (it gets closed when the decision comes back — see "Processing the user's
     decisions").
   - Crosses the autonomy line, **or is a disagreement with a human** → **decision report**
     (never auto-dismiss a human).
3. If any fixes were made → re-run the fast gate, commit, push. A new commit **restarts** every
   async reviewer, so re-trigger Devin and **reset the wait clock**. Cap the overall
   fix-push-rewait cycle at **4**; note in the report if capped.
4. **Run the FULL test suite — once, here, overlapped with the wait.** While waiting in step 5,
   run every stack's full non-watch suite against the settled code. If it already passed on an
   identical tree this run, don't re-run it. Failures → fix if safely fixable (that's a new
   commit → back to step 3), else decision report + (via the board skill) a "needs response"
   state. Phase 5 requires the full suite green at the final HEAD.
5. **Wait for every async reviewer to reach a terminal state** (the terminal-state rule).
   Skipping this wait is exactly what produces "pending" rows. Keep it **non-blocking**: do
   remaining work between polls (step 4's full suite, report drafting) and never block-sleep
   the whole interval; poll roughly every 2–3 min. Shared cap: **~30 min from the latest push**
   (a re-triggering push resets it, bounded by step 3's cycle cap). Per reviewer:
   - **Devin:** run the `devin-review` skill through to its terminal result — it waits
     internally (both the `Generating` summary panel **and** the `PR analysis in progress`
     findings pass must clear for the current HEAD sha; ~30-min internal cap) and then
     gathers/mirrors findings. Use **its** returned outcome ("findings posted …" / "re-review
     clean — bots quiet" / timed out) as Devin's state. Do **NOT** infer Devin's state from
     `gh` signals alone: "finished clean" and "still running" look identical over the API, so
     reporting off a missing comment is exactly the bug to avoid.
   - **Comment-posting bots:** complete when the bot has posted its review/summary for the
     **current HEAD sha** (a review/comment dated after the latest commit, **or** its check
     context in a terminal `completed` conclusion). A "reviewing…" placeholder or in-progress
     check means keep waiting. Once complete, fold its findings into step 2's
     evaluate/fix/reply logic.
   - **CI:** complete when every required check is terminal (success/failure), not
     queued/in-progress. Failures → treat like any finding (fix if safe; else decision report).
   - **On timeout:** record "timed out after N min" (for Devin, re-trigger once as you give
     up). Late results get folded in on a re-run.
6. New findings fixed → re-cycle from step 3 (bounded; note if capped). Otherwise, with every
   reviewer terminal and the full suite green, proceed to Phase 5.

## Phase 5 — Converge, land, report

Enter when: fast gate clean, **full test suite green at HEAD**, every reviewer terminal
(complete or recorded timeout — the terminal-state rule), all **bot** comments resolved (fixed
or replied), branch mergeable, and only human-decision items (if any) remain.

- **Refresh the QA test-ideas comment (idempotent).** If a ticket id was found in Phase 0 and a
  YouTrack token is available, invoke the **`add-test-ideas`** skill against this branch's change
  and post the result to the card. This runs on **every** preflight, so rely on that skill's
  **update-in-place** default (it finds its own marked comment via `bloom-test-ideas` and rewrites
  it) — do **not** let it stack a fresh comment each run just because preflight ran again. (The
  skill may still *choose* to add a new "round 2" comment when history matters — e.g. testers
  already worked the old notes and only part needs retesting; that deliberate case is fine, blind
  duplication is not.) The write is authorized by this skill invocation like the other tracker
  writes. Base the write-up on the final diff for the current HEAD (this is why it lives here,
  after the code has settled). Post it **even when the change has nothing user-testable** (a pure
  refactor, tooling, docs) — in that case the comment is `add-test-ideas`'s short "nothing for a
  tester to do, because …" note; never skip the comment just because there's nothing to test. The
  **only** reason to skip is a genuinely missing prerequisite — no ticket id or no YouTrack
  token — and then note it in the report. This is independent of whether decision items remain —
  do it either way.
- **If decision items remain** → (via the board skill) a "needs response / ball in the user's
  court" state, and deliver the **decision report**.
- **If nothing remains** → (via the board skill) the user's **"ready for my own final review
  before handing to a colleague"** state; leave the PR **draft**; deliver the summary. Never
  request a teammate's review and never mark the PR ready.

### Decision report format (one block per item)

- **Source:** which bot/human + a link to the exact comment.
- **Comment (verbatim):** the full text.
- **Assessment:** preflight's read of it.
- **Recommendations (ranked):** option 1 = recommended (with why), then alternatives.
- **Already done:** anything preflight changed related to it, if applicable.

### Final summary (always)

Branch/PR link & draft status; fast-gate and full-suite results; what changed this run;
reviewer outcomes — one line per reviewer per "The reviewers" (the local review included, each
remote one terminal: complete or "timed out after N min", how long we waited); mergeability;
whether the QA test-ideas comment was posted/updated (or skipped, with why); final board state;
and the count of items now waiting on the user.

### Report artifact (always)

In addition to the chat summary, **always** render the report as a **Claude Artifact**.
**Read `references/report-artifact.md` (in this skill's folder) now and follow it exactly** —
it defines the publishing steps (including opening it in the browser and printing a bare URL),
the visual style, the content blocks, the decision-item controls (`Leave as is` /
`Leave comment` / `Other:` conventions), and the copy-back button.

## Processing the user's decisions (after the run)

When the user answers the decision report — usually by pasting the artifact's copy-back block,
sometimes informally in chat — that answer carries the same authorization as the original
`/preflight` invocation for the writes below. For each decided item:

- **A fix option was chosen** → implement it (then re-run preflight's gauntlet as usual — it's
  a new commit).
- **`Leave as is` on an item that originated as a bot review thread** (Devin or any other
  bot) → close the loop on the PR, **unconditionally**: reply on the thread recording the
  decision and the reasoning (in plain English, using the user's notes where given), then
  resolve it — per `devin-review`'s "Recording a developer decision" section, which has the
  mechanics. Every mirrored Devin Bug/Investigate flag must end with a documented outcome on
  the PR; "we chose not to act, because …" is a valid outcome, silence is not.
- **`Leave comment` was ticked** → additionally record the decision as a **code comment in the
  repo** near the relevant code (this is what that checkbox means — a durable record in the
  source, not a PR comment; the PR-thread reply above happens regardless of the checkbox).
  Commit it with the normal conventions.
- **`Other:` text or notes** → follow them; if they amount to a fix, treat as a chosen fix.

## Rules

- Never mark the PR ready-for-review (leave it draft). Never request a teammate's review. Clean &
  quiet → the user's own final-review state (via their board skill).
- Never run a watch-mode test command.
- Any text posted to GitHub under the user's account is prefixed with an identifier of which
  model you are (per the user's identity conventions) — do not hardcode a model name.
- Disagree with a **human** → report, never auto-reply/auto-dismiss. Disagree with a **bot** →
  auto-reply is fine.
- Include the repo/user's required commit trailer on commits.
- Defer local board moves to the user's private board skill; Devin mechanics to the
  `devin-review` skill; and the tracker link, shared project board, and "ready for human"
  promotion to the `pr-ready-for-human` skill (which the developer runs after their own review).
- Idempotent & re-entrant: safe to re-run; it re-cycles from wherever the branch currently is
  (new commits restart the bot gauntlet).
- Degrade gracefully: if a board skill / `gh` / a bot / the Devin trigger is unavailable, note it
  and continue with everything else.
