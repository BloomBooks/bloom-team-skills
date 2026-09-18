# Why devin-review's rules are shaped the way they are

The incidents behind the rules in SKILL.md, and two worked examples. Read this when a rule looks
like overcaution.

## Never read findings from the rendered page

The unauthenticated review page stopped rendering findings sections in July 2026. A DOM/text grep
therefore reads "0 findings" even when findings exist: on bloom-player #438 (2026-07-17) it
missed all four informational flags, and the consultation log had to be corrected afterwards.
Only the job-result JSON is trustworthy. The git history of SKILL.md has the old DOM-scraping
procedure, which worked on the pre-2026-07 layout.

## Parse JSON with a real parser, never regex, and never `py -c` in a heredoc

The job objects contain nested objects (`versions:[{...}]`), so a brace-matching regex can never
match the job that carries your sha — a PR #8231 poll loop matched nothing for the entire wait
while the review had been `completed` for minutes.

A `py -c "..."` snippet inside a Bash heredoc is the other trap: a path fix-up that turned forward
slashes into backslashes lost one of them to Bash, Python then saw an unterminated string literal,
and every one of 55 iterations died over 23 minutes while the review had long since finished. A
Windows path built inside a heredoc and handed to a second language is two layers of escaping and
is not worth attempting.

## The poll loop, learned the hard way

- `chrome-devtools evaluate_script` prints an update-nag banner and a fenced ```` ```json ````
  block around the value, so `[ "$(chrome-devtools …)" = "true" ]` can never match and the loop
  spins forever (it stalled a bloom-player #430 run). Extract the value with a pattern match.
- The `devin-noauth` isolated context is shared by every session on the machine, and
  `evaluate_script` runs against whichever tab is currently selected, which silently drifts to the
  newest page — a bloom-player #433 run briefly read a different PR's review this way. Pin the
  tab every iteration.
- The tab can vanish mid-run (closed by another session), after which `evaluate_script` runs
  against the leftover `about:blank`, where the same-origin fetch returns an empty string —
  indistinguishable from "no job yet". A PR #8107 run burned six minutes on 14 such iterations.
- Small-delta re-reviews can finish inside one poll interval, so never gate on ever *observing* a
  `running` state; an over-wait bug hit bloom-harvester #234 twice.

## The large-PR failure

On BloomDesktop PR #8229 (74 files, ~15,000 insertions, a 2.5 MB job-result) the job reached
`status: "completed"` while `lifeguard_status` stayed `"pending"` forever — six times over six
days, across four head shas and 23 jobs, with not one review produced; sometimes no job appeared
for the head sha at all. Size is the suspected cause and it is not transient, so waiting longer
does not help. That is the `devin-unavailable (large PR)` outcome.

## Re-review findings are not self-certifying

On one BL-16799 re-review six of the findings were already fixed in the very commit Devin
reviewed, and on one PR Devin contradicted itself inside a single result (flagging a missing
approval while its own analysis said the approval satisfied the rule). Hence step 3b's screening.

## `@devin review` is not a trigger

This repo has no Devin GitHub app to respond to a mention; PR #613 ended up with a `@devin review`
comment, no findings, no consultation log, and no idea whether Devin was satisfied.

## Worked example: a first review (PR #7949)

**Bugs (3 total, 1 unresolved):**

- ✅ Post: "Legacy ebook layout name normalization fails for mixed-case input" — `SizeAndOrientation.cs:80`
- ⏭ Skip: "buildSavePageContentString calls removeEditingDebris..." — `bloomEditing.ts:1322` — Resolved
- ⏭ Skip: "Overlay can get permanently stuck if exception occurs..." — `ExternalApi.cs:240` — Resolved

**Flags (6 Investigate, several Informational):**

- ✅ Post: "Scale inconsistency in computeImageFitTopPercent..." — `autoFitImageOverTextSplits.ts:284`
- ✅ Post: "BringBookUpToDate may write to disk before per-page processing..." — `BookProcessor.cs:36`
- ⏭ Skip: All Informational items

Each posted finding went in as an inline review thread on its `file:line`; any whose line fell
outside the diff fell back to a file-level (still resolvable) comment, and only truly
un-anchorable ones to a top-level comment.

## Worked example: a re-review after a fix commit

After the developer pushed fixes, re-navigating started a new job; the jobs API showed it
`running`, then `completed` for the new head sha, and its job-result had empty `bugs` and no
`needs_investigation` analyses — while the *previous* commit's job still listed the old findings.
Correct outcome: post nothing, resolve any threads whose bugs the new result marks fixed (step 6),
log the consultation (step 7), and report "re-review clean — bots quiet." Reading the old commit's
job here would have wrongly re-posted the superseded bug.
