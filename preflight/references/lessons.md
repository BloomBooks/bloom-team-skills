# Why preflight's rules are shaped the way they are

The incidents behind the rules in SKILL.md. Read this when a rule looks like overcaution; each one
cost a real run.

## The tracker must be declared, not inferred

A declaration is a passage in the project's root instructions that names all three of: the
tracker, what its ticket ids look like, and which skill talks to it. A project's instructions
mentioning a tracker's name in passing — in a contributing note, a commit-message convention, a
link — does not count, however obvious the answer looks. Partial and incidental mentions are
treated exactly like none.

Establishing the tracker and the ticket id costs at most two cheap looks: the project's
instructions (already in context) and the branch name. If those don't answer it, stop looking. Do
not consult the PR title, commit messages, open cards, issue searches, or the codebase to
reconstruct what a declaration should have said, and do not reason from surrounding evidence
(`BL-`-shaped strings in the repo, a tracker skill being installed) to a conclusion the project
never stated. Reaching the right answer by investigation is the failure mode, not a save: it burns
the user's tokens, and it leaves the repo undeclared so the next run investigates again. Asking is
one cheap turn and fixes it permanently — and "this project doesn't use a tracker" is a valid
answer that gets written down too, or preflight re-asks forever.

## Never read a gate's pass/fail through a pipe

`tsc --noEmit … | tail -20; echo $?` reports `tail`'s status, not the tool's. A run with 13 type
errors was reported as a clean gate row this way. Capture the status directly
(`cmd > out.txt; st=$?`), or `set -o pipefail`, or judge by grepping the output for the tool's own
error format. A backgrounded task's own exit code has the same problem when its command is a
pipeline.

## The light review must be read-only, and must be budgeted

A reviewer sub-agent with write tools *will* eventually edit the code it is reviewing: one did
exactly that mid-run, replacing a `lock (...)` with `if (true) // TEMP-REVIEW-NO-LOCK` while the
C# suite was running, which cost a re-run and a wrong-headed hunt for the cause of the failure.

A sub-agent that stalls is indistinguishable from a slow one — there is no way to poll its
progress, and a stalled one silently blocks the phase. A PR #8117 run lost two agents and about
50 minutes this way; nudging with `SendMessage` and dispatching a replacement both stalled too.
Hence the 15-minute budget and "do the pass inline yourself, do not dispatch a second agent".

## Devin on a very large PR never finishes

One PR burned 23 Devin jobs over six days and got no findings; every re-trigger cost the whole
wait. A read-only sub-agent on a different model (a Fable-model reviewer) stood in for it and did
the job. That is why SKILL.md says to stop re-triggering after `devin-unavailable (large PR)` and
substitute a reviewer, recorded as such rather than as "bots quiet".
