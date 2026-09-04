---
name: preflight
description: Run the automated pre-review checklist on the current branch — the work before the "flight" of human review. Local quality gate, commit & push, draft PR, then trigger and WAIT for every async reviewer (Devin, other review bots, CI) to actually finish — auto-fixing and auto-replying to bots — refresh the QA test-ideas comment on the tracker card, and finish with a report that leads with the problem the PR solves and what the whole PR changes to fix it, plus the decisions that genuinely need the user. Local review level -- light single-sub-agent pass by default; "thorough review"/"expensive review" = full /code-review + fix loop; "without review" = skip it. Never marks the PR ready-for-review and never requests a teammate's review (that's pr-ready-for-human).
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

## What a "run" is

A **run** is one invocation of this skill — Phase 0 through the report at the end of Phase 5.
A single run normally contains **several commits**: the work that was already on the branch,
one or more base merges, and each round of fixes made in response to the local review, a bot,
or CI. All of those belong to the same run. A later `/preflight` on the same branch — after the
user answers the decision report, or after they push more work — is a **new** run.

So "this run" is *everything since the previous preflight report on this branch*, not the
latest commit. And a PR is usually several runs' worth of work, which is why the report cannot
be a description of the current run: see the next two sections.

## The PR narrative — problem, cause, fix

**Every** preflight report and chat summary — the first run and the fifth alike — opens with a
short, current answer to the three questions a reviewer or a decision-maker asks first:

1. **Problem** — what is wrong, in terms of what a user hits or what breaks. Two to four
sentences. Where a ticket describes it, this is that, tightened.
2. **Cause** — the root cause that was diagnosed. **Include it only when it is not already
obvious from the problem statement.** "The button does nothing because its handler was never
wired up" needs no separate cause paragraph; "joining a Team Collection silently fails" does.
3. **Fix** — what the **whole PR** changes in order to fix it. Not commit by commit: one short
paragraph, or up to about six bullets, one per coherent *group* of changes — "the path is now
normalized at the single place every caller passes through", not "edited ProjectContext.cs".

**Keep it short, and keep it in behavior terms.** The three together should fit on one screen —
roughly 150–250 words. Someone who knows nothing about the branch should finish it knowing what
the PR is for and what it does. Say "opening a collection whose name ends in a period", not
"`GetRealSettingsPath` now calls `GetPathAsOnDisk`". Name symbols only where a reviewer needs
them to find the code.

**Maintain it across runs; never let a run's notes replace it.** On each run, re-derive the
narrative from the **current full diff** (`git diff origin/<base>...HEAD`) and the problem
statement, and update it to describe the PR **as it now stands**. This run's fixes get folded
into the fix summary where they changed what the PR does; they are not appended as a running
log. If a later commit reversed what an earlier one did, the narrative says only what is true
now. The narrative is the one part of the report that is cumulative — everything else is a
snapshot.

**Where to get it**, cheapest first: the ticket/card (the problem), the PR description an
earlier run wrote (the previous narrative), the full diff (the fix), and — once Devin has run —
**Devin's own Overview**, which the `devin-review` skill returns. Devin writes unusually good PR
summaries; read it against yours and take what is better. If Devin's is clearer, better
organized, or covers a part of the change you left out, adopt that (in your own words, at your
own length). If yours is shorter and leaves nothing essential out, keep yours: **shorter with
nothing essential missing is the better summary.**

**One text, two homes.** Write it once per run and use the same text in both places the humans
look: the **PR description** (Phase 3) and the top of the **report** (Phase 5).

## What the report is for — and what does not belong in it

The report has exactly two jobs:

1. **Context** — enough that a human reviewer, or whoever picks the card up days later, knows
what this PR is and where it stands: the narrative above, the state of the gates and the
reviewers, and the few caveats a reader would act differently without.
2. **Questions** — the decisions that still need a human.

Everything else makes the report worse by making it longer. These in particular do **not**
belong in it:

- **A recital of decisions already made.** A settled decision is recorded where the person who
needs it will actually be standing: a **code comment** next to the code, a **reply on the
review thread** that raised it, an updated **test-ideas** comment on the card (when it changes
what a tester should check or not report), or the narrative itself when it changed what the PR
does. Not a paragraph in the next report.
- **A log of the difficulties we hit.** A bot that errored and was re-triggered, a sub-agent
that stalled, a flaky suite, a tool that needed a workaround, an assessment of ours that a
later round corrected — none of it changes what a reviewer or a decision-maker does. Fix it,
or log it via the `papercut` skill, and leave it out. Where a difficulty changed the *result*
— a reviewer that never finished — it appears as that reviewer's state, which is the whole
record needed.
- **A round-by-round transcript of a reviewer.** One row per reviewer, current state.
- **A paragraph per commit.** See "what changed this run" in the report spec.

The test for anything you are about to add: **would a reviewer, or the person answering the
decisions, do something differently for having read it?** If not, cut it.

## Authorization — invoking this skill IS your permission to write to GitHub

Running `/preflight` is the user's **explicit, durable authorization** to perform every
outward-facing GitHub write this skill defines, autonomously and **without stopping to
re-confirm**. The general "outward-facing actions need confirmation first" guard does **not**
apply to these — the skill invocation already granted them:

- commit and push the branch;
- create a **draft** PR, or convert an existing PR back to draft;
- post replies to **bot** comments/reviews (including telling a bot it's mistaken);
- reply to a **human** comment **to acknowledge a fix you made** at their suggestion — a brief,
polite thanks plus what you changed — and resolve that thread (the *agree-and-act* case;
arguing with or dismissing a human is still excluded, below);
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

Disagreeing with a **bot** does *not* need the user — post a reply and move on. **Agreeing** with
a human is fine to act on too: if their point is a clearly-correct, in-scope fix, make the fix,
post a brief thanks noting what you changed, and resolve the thread. The report is only for
*disagreement* with a human (or anything else that crosses the lines above) — not for the simple
courtesy of thanking someone whose fix you just applied.

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

## The issue tracker — project-declared, never assumed

Preflight posts two things to a work-tracking card: the PR link (Phase 3) and the QA test-ideas
comment (Phase 5). It does not know or care which tracker a project uses.

**How a project declares one.** In its own instructions at the repo root — `AGENTS.md` bridged by a
`@AGENTS.md` line in `CLAUDE.md` (Claude Code reads `CLAUDE.md`, not `AGENTS.md`), or `CLAUDE.md`
directly. Root, not a subdirectory: root is also what gets re-injected after a `/compact`, which a
long preflight run can hit. A declaration is a passage that names **all three** of: the tracker,
what its ticket ids look like, and which skill talks to it.

**Anything less is not a declaration.** A project's instructions mentioning a tracker's name in
passing — in a contributing note, a commit-message convention, a link — does **not** count, however
obvious the answer looks. Treat partial and incidental mentions exactly like none.

**If the project has no declaration, STOP and ask — immediately, on your first turn.** This is the
one question preflight raises up front instead of deferring to the decision report: it arrives in
Phase 0, while the user is still at the keyboard and nothing has been triggered yet, and one answer
settles it for that repo permanently. Offer to write the declaration into the project's `AGENTS.md`
(adding the `@AGENTS.md` import to `CLAUDE.md` if it's missing). **"This project doesn't use a
tracker" is a valid answer and gets written down too** — otherwise preflight re-asks forever in a
repo that will never have cards.

**Do not investigate.** Establishing the tracker and the ticket id costs at most two cheap looks:
the project's instructions (already in context — no tool call) and the branch name. If those don't
answer it, you are done looking. Do **not** consult the PR title, commit messages, open cards, issue
searches, or the codebase to reconstruct what a declaration should have said, and do not reason
from surrounding evidence (`BL-`-shaped strings in the repo, a tracker skill being installed) to a
conclusion the project never stated. Reaching the right answer by investigation is the **failure
mode** here, not a save: it burns the user's tokens, and it leaves the repo undeclared so the next
run investigates again. Asking is one cheap turn and fixes it permanently.

**What preflight needs from a tracker skill.** Five operations. How it authenticates is entirely its
own business — a token, an MCP server, an already-authenticated CLI, anything:

1. **Reachable?** — a cheap check that tracker operations will work at all.
2. **Read this branch's ticket id off the branch name** — one look, using the id format the
declaration gave. No id there means this branch has no card: skip the card steps, note it once in
the report, and move on. That is a normal outcome, not a problem to solve, and **not** a reason to
go hunting through the PR or the commit log.
3. **List a card's comments** — both the PR-link step and `add-test-ideas` dedup against these.
4. **Post or update a comment** on a card.
5. **Read a card's title and description** — the problem statement the PR narrative starts from (Phase 0). A card that says nothing useful is a normal outcome; fall back to the diff.

Never write "token" — or any other auth mechanism — into a preflight instruction. Ask the tracker
skill whether it's reachable and let it decide what that means.

## Phase 0 — Discover

- Identify branch, base (default `master`/`main` — confirm via remote HEAD), and `owner/repo`
from `git remote get-url origin`.
- **Identify the issue tracker and this branch's ticket id**, per "The issue tracker" above — stop
and ask if the project declares none.
- **Pick up the problem statement and the previous narrative** — two cheap reads that the whole
report hangs off (see "The PR narrative"): the card's own summary/description via the tracker
skill, if this branch has a card, and the existing PR description if a PR is already open (an
earlier run wrote the narrative there). Skipping these is how a report ends up describing the
run instead of the PR.
- Detect the toolchain — **every stack present, not just Node**: package manager from the
lockfile (`pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, else npm) and the **typecheck / lint /
test / build** commands from `package.json` `scripts`; a .NET solution (`*.sln` /
`*.csproj`) → `dotnet build` / `dotnet test`; likewise any other stack in the repo. Record a
**non-watch** test command per stack (prefer a `test:ci`/`run` variant; NEVER launch a
watch-mode runner — it hangs). Fallbacks: typecheck → `<pm> exec tsc --noEmit`; lint → the
`lint` script. Detecting a stack here does **not** commit you to running its suite — whether
each one runs is decided from the final diff in Phase 4 step 4.
- Look for a **private board skill** the user has (a skill whose job is their personal
work/review board). If found, invoke it to mark this worktree as actively being worked on, and
use it for all later board moves. If none, skip board steps silently.

## Phase 1 — Local quality gate (loop until clean)

**The fast gate — run at every level, and before every push:** repeat until **typecheck**,
then **lint**, then **fast tests** (only changed/related tests, non-watch) all pass. Fix
what's safely fixable; report the rest. (The FULL test suite deliberately runs later, once,
overlapped with the bot wait — see Phase 4.)

⚠️ **Never read a gate's pass/fail through a pipe.** `tsc --noEmit … | tail -20; echo $?` reports
`tail`'s status, not the tool's — a run with 13 type errors was reported as a clean gate row this
way. Every row in this skill's output is a pass/fail claim, so capture the status directly
(`cmd > out.txt; st=$?`), or `set -o pipefail`, or judge by grepping the output for the tool's own
error format. A backgrounded task's own exit code has the same problem when its command is a
pipeline.

The local review runs at one of three levels — the full `/code-review` + fix loop chews up a
lot of tokens, so it is opt-in:

- **Light (the DEFAULT):** dispatch ONE **read-only** subagent over the working diff — use the
`Explore` agent type, or any agent whose tool set excludes Edit/Write/NotebookEdit. The tree is
live and shared (the gate, and possibly other agents, are working in it), and a reviewer with
write tools *will* eventually edit the code it is reviewing: one did exactly that mid-run,
replacing a `lock (...)` with `if (true) // TEMP-REVIEW-NO-LOCK` while the C# suite was running,
which cost a re-run and a wrong-headed hunt for the cause of the failure. Say so in the prompt
too, in case the tool set can't be constrained: *"the tree is live and shared — do not modify any
file; if you need to know whether something is load-bearing, say so and let the caller check."*
Prompt it to: read the diff plus just enough surrounding code to judge it; report only
**clear, high-confidence correctness problems** (bugs, broken edge cases, misused APIs,
unintended behavior changes) — no style points, no nits, no refactor ideas, no "consider…";
and return a short structured list (file:line, what breaks, why it's wrong). One pass, no
verification loop, no re-review after fixes (typecheck/lint/tests are the re-check).
**Budget it: ~15 minutes.** A sub-agent that stalls is indistinguishable from a slow one —
there is no way to poll its progress, and a stalled one silently blocks the phase (a PR #8117
run lost two agents and ~50 min this way; nudging with `SendMessage` and dispatching a
replacement both stalled too). If the agent hasn't returned by then, **stop waiting and do the
review pass inline yourself** — it is fast and it works — and say so in the reviewer row
("light review, done inline after the sub-agent stalled"). Do not dispatch a second agent.
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

## Phase 2 — Integrate the base (before publishing)

Fold `origin/<base>` in **before the push**, so the PR's first pushed state is already the
integrated, mergeable one — never a snapshot that gets superseded a moment later — and so the
gate has run against the code as it will actually merge. Base may break the branch with **no git
conflict at all** (a renamed function you call, a changed signature, a deleted fixture); merging
before you push is what surfaces that here rather than on the PR. (Integration can't run *before*
the gate: merging needs a clean tree, so the work has to be committed first, and pre-commit hooks
reject un-gated code — hence gate in Phase 1, integrate here.)

- **Commit everything on the branch** (including pre-existing uncommitted work — that's "what's
on the branch"), so the tree is clean enough to merge and the pre-commit hooks run against
already-gated code. Message: `<concise summary> (<TICKET>)` plus the repo/user's required
commit trailer, identifying which model you are. Let the hooks run.
- `git fetch origin`, then merge `origin/<base>` into the branch:
  - **Clean / already up to date** → done; the branch is integrated.
  - **Trivial** conflicts (lockfile, imports, formatting) → resolve them, complete the merge,
  then **re-run the fast gate** on the integrated result (even a conflict-free merge can fold
  base's hunks into files you also touched) and commit any fixes.
  - **Semantic** conflicts → **abort the merge** (`git merge --abort`) to leave the branch
  un-integrated, record a decision item, and set (via the board skill) a "needs response"
  state. Continue the run on the un-integrated branch — publishing the draft PR is still
  worthwhile for review — and leave the base integration to the user.

## Phase 3 — Publish (push, draft PR, link)

Everything is already committed in Phase 2; this phase only pushes and opens the PR.

- Push, setting upstream if needed.
- Ensure a **draft** PR exists: `gh pr list --head <branch> --json number,url,state,isDraft`.
  - None → create one: write the body to a temp file and
  `gh pr create --draft --base <base> --title "<summary> (<TICKET>)" --body-file <file>` (a
  literal `--body "...\n..."` won't expand `\n` in PowerShell — always use `--body-file`). The
  body is **the PR narrative** — problem, cause where it isn't obvious, and what the whole PR
  changes (see "The PR narrative") — wrapped in the marker lines below, followed by
  `Ref: <tracker-url-if-known>`.
  - Exists but is **ready-for-review** → convert it back to draft (`gh pr ready <n> --undo`):
  preflight means the work is pre-review again. Note the conversion in the report.
  - Either way the PR state changed under you, so the report must render its PR-state chip from a
  fresh `gh pr view <n> --json isDraft` at report time rather than from what happened here — see
  `references/report-artifact.md`, "Header — the run summary and the status chips".
  - (Do NOT do the promote-to-human ceremony — that's `pr-ready-for-human`.)
- Record PR number & URL.
- **The PR description is the narrative's other home — keep it current, idempotently.** Preflight
delimits the narrative with two marker lines so a later run can refresh it without touching
anything else:

  ```
  <!-- preflight-narrative:begin -->
  … problem / cause / fix …
  <!-- preflight-narrative:end -->
  ```

  Rules:
  - **Markers present** → replace only what is between them (`gh pr edit <n> --body-file -`).
  Everything outside is other people's: a human's own notes, and `devin-review`'s "Devin review"
  link, which it appends after a horizontal rule.
  - **Markers absent on an existing PR** → the description is **not ours**; a human wrote or
  rewrote it. **Leave it completely alone**, and say so in one line of the report. The report
  still carries the current narrative, and their text is an input to it (see "Where to get it").
  - The narrative you push here must be the **same text** the report shows. The code has settled
  by Phase 4/5 and Devin's Overview arrives in Phase 4, so it is fine to write the best version
  you have now and refresh it once in Phase 5 — but never let the two diverge.
- **Link the PR on the tracker card (once).** If a ticket id was found in Phase 0, use the
project's **tracker skill**: list the card's comments, check a PR link isn't already there
(`grep -i "github.com.*pull"`), and only if none post a comment `PR: <PR URL>`
(prefixed with an identifier of which model you are). This is idempotent — never post a second
PR link. If the branch carries no ticket id, or the tracker isn't reachable, skip the step and
note it in the report. (`pr-ready-for-human` performs the same dedup-checked step later, so a link
posted here means that step finds it already present and does nothing.)

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
   Evaluate each item — **from a bot or a human**; the split is agree-and-act vs. disagree, not
   who wrote it:
  - Clear, correct, within the autonomy line → **fix it, then post a reply documenting the
  outcome and resolve the thread** (prefix the body with an identifier of which model you
  are): "Fixed in `<sha>`: …", and for a **human** a brief thanks for the catch. A
  documented, resolved thread is the record a later human reviewer sees.
  - **Bot** is mistaken → **post a reply** explaining why **and resolve the thread** — refuting
  a bot needs no user sign-off.
  - Crosses the autonomy line, **or you disagree with a human** → **decision report**, with the
  thread left **open** (never auto-dismiss a human; it gets closed when the decision comes
  back — see "Processing the user's decisions"). Only clear-cut, acted-on items get closed
  above.
3. If any fixes were made → re-run the fast gate, commit, push. A new commit **restarts** every
 async reviewer, so re-trigger Devin and **reset the wait clock**. Cap the overall
 fix-push-rewait cycle at **4**; note in the report if capped.
4. **Run the FULL test suite for every stack the change can reach — once, here, overlapped
 with the wait.** While waiting in step 5, run each **in-scope** stack's full non-watch suite
 against the settled code. If it already passed on an identical tree this run, don't re-run it.
 Failures → fix if safely fixable (that's a new commit → back to step 3), else decision report
 + (via the board skill) a "needs response" state. Phase 5 requires every in-scope suite green
 at the final HEAD.

 **In scope = the final diff can plausibly reach it** — decide per stack from the diff, not
 from what the repo happens to contain. A stack is in scope when the diff touches its own
 sources or tests, **or** anything it consumes: a shared schema or API contract its tests
 assert on, generated or content files they read, build/dependency/CI config. A stack is out
 of scope only when you can *say why* nothing in the diff can reach it — "a TypeScript-only
 diff, and the .NET suite neither reads nor builds any of it" is a reason; "it's slow" is not.
 **When in doubt, run it.**

 Running an untouched stack's suite is not free caution. It costs many minutes, and a
 **pre-existing** failure there then arrives as a red row and a decision item that spends the
 user's attention on something this branch did not cause and will not fix.

 **Never skip silently.** An out-of-scope stack still gets its row in the report and the final
 summary, reading e.g. "not run — no C# in the diff", so a reader can tell a deliberate
 exemption from an oversight.
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
   reporting off a missing comment is exactly the bug to avoid. **Devin also returns its own
   Overview** — a plain-English summary of the whole PR. Read it against your narrative and
   adopt whatever is better (see "The PR narrative"); this is the one point in the run where the
   narrative gets a second opinion, and it is usually a good one.
  - **Comment-posting bots:** complete when the bot has posted its review/summary for the
  **current HEAD sha** (a review/comment dated after the latest commit, **or** its check
  context in a terminal `completed` conclusion). A "reviewing…" placeholder or in-progress
  check means keep waiting. Once complete, fold its findings into step 2's
  evaluate/fix/reply logic.
  - **CI:** complete when every required check is terminal (success/failure), not
  queued/in-progress. Failures → treat like any finding (fix if safe; else decision report).
  - **On timeout:** record "timed out after N min" (for Devin, re-trigger once as you give
  up). Late results get folded in on a re-run.
  - **When Devin never produces a review at all** — `devin-review` returns
  `devin-unavailable (large PR)`, or two runs on this PR have now ended without findings —
  **stop re-triggering and substitute a reviewer instead.** Each re-trigger costs another full
  wait, and on a big PR it has never yet produced findings (one PR burned 23 jobs over six days
  and got none). Dispatch a **read-only sub-agent on a different model** (a Fable-model reviewer
  stood in for exactly this and did the job) over the same diff, prompted like the light local
  review in Phase 1. Record it in the reviewer row as "Devin unavailable (PR too large) —
  substituted <model> sub-agent review", never as "bots quiet": a PR that no third-party reviewer
  ever looked at is a fact the human reviewer needs.
6. New findings fixed → re-cycle from step 3 (bounded; note if capped). Otherwise, with every
 reviewer terminal and every in-scope suite green, proceed to Phase 5.

## Phase 5 — Converge, land, report

Enter when: fast gate clean, **every in-scope test suite green at HEAD**, every reviewer terminal
(complete or recorded timeout — the terminal-state rule), all **bot** comments resolved (fixed
or replied), branch mergeable, and only human-decision items (if any) remain.

- **Settle the PR narrative first — everything else in this phase quotes it.** Re-derive
problem / cause / fix from the full diff at HEAD, folding in anything worth taking from Devin's
Overview (see "The PR narrative"). Then write that one text into both homes: the PR description
(Phase 3's marker rules — and leave a human-written description alone) and the top of the
report. Do this before the test-ideas refresh, which is grounded in the same understanding.
- **Refresh the QA test-ideas comment (idempotent).** If a ticket id was found in Phase 0 and the tracker is  
 reachable, invoke the **`add-test-ideas`** skill against this branch's change  
and post the result to the card. This runs on **every** preflight, so rely on that skill's  
**update-in-place** default (it finds its own marked comment via `test-ideas` and rewrites  
it) — do **not** let it stack a fresh comment each run just because preflight ran again. (The  
skill may still *choose* to add a new "round 2" comment when history matters — e.g. testers  
already worked the old notes and only part needs retesting; that deliberate case is fine, blind  
duplication is not.) The write is authorized by this skill invocation like the other tracker  
writes. Base the write-up on the final diff for the current HEAD (this is why it lives here,  
after the code has settled). Post it **even when the change has nothing user-testable** (a pure  
refactor, tooling, docs) — in that case the comment is `add-test-ideas`'s short "nothing for a  
tester to do, because …" note; never skip the comment just because there's nothing to test. The  
**only** reason to skip is a genuinely missing prerequisite — no ticket id or an unreachable  
tracker — and then note it in the report. This is independent of whether decision items remain —  
do it either way.
- **Link the preflight report on the tracker card (once).** If a ticket id was found in Phase 0 and
the tracker is reachable, post the report artifact's URL to the card after publishing it (see
"Report artifact" below — a ticket id means the report publishes to the **public** repo, whose URL
is stable per branch). Same mechanics and idempotence as the Phase 3 PR link: list the card's
comments, and only if that URL isn't already there post `Preflight report: <url>` (prefixed with an
identifier of which model you are). Do this **before ending the run** — decision items may be
deferred to a different human who picks up the card later, and the report is where the decisions
live. No ticket id, or an unreachable tracker → skip and note it in the report.
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

**Open with the narrative, compressed to two or three sentences:** the problem (with the cause
where it isn't obvious) and what the whole PR does about it. That is the first thing the user
reads, on every run.

Then: branch/PR link & its PR state (read it live — `gh pr view <n> --json isDraft` — never assumed
from what this run did to it); fast-gate and full-suite results; **one line** on what this
run changed; reviewer outcomes — one line per reviewer per "The reviewers" (the local review
included, each remote one terminal: complete or "timed out after N min", how long we waited);
mergeability; whether the QA test-ideas comment was posted/updated, whether the PR description's
narrative was refreshed (or left alone as human-written), and whether the report link was posted
to the card (or skipped, with why); final board state; and the count of items now waiting on the
user.

"What the report is for" applies here too: no recital of settled decisions, no log of the
run's difficulties.

### Report artifact (always)

In addition to the chat summary, **always** render the report as a standalone HTML page and
publish it **once** — never through two targets, which yields two links and two browser tabs.
**Read `references/report-artifact.md` (in this skill's folder) now and follow it exactly** — it
defines the publish target and steps (including the single URL to open in the browser and
printing a bare URL), the visual style, the content blocks, the decision-item controls
(`Leave as is` / `Leave comment` / `Other:` conventions), and the copy-back button.

## Processing the user's decisions (after the run)

When the user answers the decision report — usually by pasting the artifact's copy-back block,
sometimes informally in chat — that answer carries the same authorization as the original
`/preflight` invocation for the writes below. For each decided item:

- **A fix option was chosen** → implement it (then re-run preflight's gauntlet as usual — it's
a new commit).
- `**Leave as is` on an item that originated as a bot review thread** (Devin or any other
bot) → close the loop on the PR, **unconditionally**: reply on the thread recording the
decision and the reasoning (in plain English, using the user's notes where given), then
resolve it — per `devin-review`'s "Recording a developer decision" section, which has the
mechanics. Every mirrored Devin Bug/Investigate flag must end with a documented outcome on
the PR; "we chose not to act, because …" is a valid outcome, silence is not.
- `**Leave comment` was ticked** → additionally record the decision as a **code comment in the
repo** near the relevant code (this is what that checkbox means — a durable record in the
source, not a PR comment; the PR-thread reply above happens regardless of the checkbox).
Commit it with the normal conventions.
- `**Other:` text or notes** → follow them; if they amount to a fix, treat as a chosen fix.

**Then park the decision where it belongs, and stop carrying it.** Once an item is settled it
must not reappear as prose in the next report (see "What the report is for"). Its home is one or
more of:

- the **review thread** it came from — replied to and resolved (above);
- a **code comment** next to the code, when `Leave comment` was ticked, or whenever the reason
would otherwise be invisible to the next person reading that code;
- the **PR narrative**, when the decision changed what the PR does — so the next report's
opening reflects it;
- the **test-ideas comment** on the card, when it changed what a tester should do — including a
deliberate non-fix, so the tester doesn't file the known behavior as a new bug. Ask
`add-test-ideas` to refresh it.

The next run's report then says nothing about the decision at all: the record is in those
places, where the person who needs it is already looking.

## Rules

- Every report and chat summary **opens with the current problem / cause / fix narrative for the
whole PR**, maintained across runs — never replaced by notes on the latest run, and never
omitted because "the user knows what this PR is" (someone else may pick up the card).
- What changed *this run* is a **brief** note, not the report's substance. A settled decision or
a difficulty we worked around belongs in the code, on the review thread, or in the test ideas —
not recited in the report ("What the report is for").
- Never mark the PR ready-for-review (leave it draft). Never request a teammate's review. Clean &
quiet → the user's own final-review state (via their board skill).
- Never run a watch-mode test command.
- Run a stack's full suite only when the change can reach it (Phase 4 step 4), and always say
in the report when you didn't, and why.
- Any text posted to GitHub under the user's account is prefixed with an identifier of which
model you are (per the user's identity conventions) — do not hardcode a model name.
- A **human** comment that's clearly right and in scope → fix it, reply with a brief thanks and
what you changed, and resolve. **Disagreeing** with a human → report, never auto-reply/
auto-dismiss. A **bot** → auto-reply is always fine (documenting a fix, or refuting a mistake).
- Include the repo/user's required commit trailer on commits.
- Defer local board moves to the user's private board skill; Devin mechanics to the
`devin-review` skill; and the tracker link and "ready for human" promotion to the
`pr-ready-for-human` skill (which the developer runs after their own review).
- Idempotent & re-entrant: safe to re-run; it re-cycles from wherever the branch currently is
(new commits restart the bot gauntlet).
- Degrade gracefully: if a board skill / `gh` / a bot / the Devin trigger is unavailable, note it
and continue with everything else.

