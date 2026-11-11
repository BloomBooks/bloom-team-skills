---
name: walkaround
description: Walk around a whole PR asking whether its code is something we would be proud of (well factored, minimal, clear, names that fit), then refactor it without changing behavior and fix the bugs that a test or a run shows. Use when a round of fixes is done (the developer's own, or answers to review comments), when preflight reaches its walkaround, or when asked whether a PR's code is well factored.
argument-hint: "optional base branch; default: the PR's base"
---

# Walkaround

Before a flight, a pilot walks all the way around the aircraft and looks at the whole of it. This
skill does that for a PR. The code works; the question is whether it is code we would be proud of.

Each fix to a PR is made looking at one problem, so a PR that has been through several fixes
collects code that no single fix's review sees: two mechanisms doing one job, names and comments
that describe an earlier version, code that a later commit made dead. Only a look at the whole PR
catches these, so the walkaround always covers the whole PR, never the latest fix.

## Steps

1. **Find the base.** The argument if given; otherwise the PR's base
   (`gh pr view --json baseRefName`); otherwise the repo's default branch. `git fetch origin <base>`.

2. **Stage any uncommitted work** (`git add -A`), so that what the walkaround changes shows on its
   own as `git diff`. Uncommitted work is part of the PR. Note any untracked file that this
   stages, for the report.

3. **Read the whole PR** (`git diff origin/<base>...HEAD` plus the staged changes) as a reviewer
   seeing it for the first time, and fix what you find. A fix leaves behavior the same, unless
   it fixes a bug (step 5). Done when each of these has been checked against the whole diff:
   - two parts of the PR that do one job, or a part that a later part made unnecessary;
   - code that rewrites what an existing function in the repo already does;
   - a name, comment or doc that describes an earlier version of the PR, or no longer says what
     the code does;
   - a comment that tells what the code used to do or how it was fixed; a comment states how the
     code stands now;
   - debug logging, commented-out code, or a TODO that the PR has since done;
   - code that nothing reaches any more, including code outside the diff whose last caller the PR
     removed (search the repo for callers);
   - new code in an existing file that has a purpose of its own: a new feature, or anything else
     that a reader can skip and still understand what the file was already doing. Give it a file
     of its own when that adds no complexity and leaves each file easier to understand alone;
   - a function that grew by patching where restructuring it would read more clearly;
   - an implicit state machine: several flags or nullable fields that are set and tested
     together, where one value naming the state would rule out the combinations that the code
     never means;
   - a flag argument: a boolean parameter that gives one caller different behavior
     (`save(book, true, false)`), where two functions would say what each caller wants;
   - stored derived state: a field that holds what other state could compute (`selectedCount`
     beside `selectedItems`), which every write to that other state must remember to update;
   - temporal coupling: functions that work only when called in a certain order (`init()`
     before `load()`), with nothing in their types or signatures that says so;
   - a redundant defensive check: a null check or `try`/`catch` for a condition that cannot
     occur there, usually left from a bug whose cause was fixed upstream;
   - more code than the problem needs.

   Tests are part of the PR. Give the tests that the PR added the same checks, and when a fix
   renames or moves something that an existing test uses, update that test with it.

   When an earlier walkaround has covered this PR, work from its report and the developer's
   answers to its proposals. Leave alone a proposal that the developer turned down. Reverse a
   change that the earlier walkaround kept only for a reason that you give in the report.

4. **Run Claude Code's built-in `/simplify`** through the Skill tool (its instructions appear when
   it runs), with the target
   `every change on this branch: git diff origin/<base>...HEAD plus the staged changes`. Write the
   diff to a file and point its review agents at it, giving each the read-only rule: the tree is
   live, so only you edit it. On a pass over a PR that an earlier walkaround already covered, run
   it only when the fixes made since then added or restructured code; skip it when they were
   small edits.

5. **Read every change made in steps 3 and 4** (`git diff`). Keep a change that leaves behavior
   the same. A change that alters what a user sees or can do is one of three kinds:
   - a side effect of a refactoring, which nobody intended: undo it;
   - the fix for a bug that a test or a run shows: keep it, and note the behavior before and
     after for the report;
   - the removal of a mechanism that still handles a case nothing else in the PR handles: undo
     it, and keep it as a proposal that names the case it would drop.

   A reviewer's claim that the code misbehaves is a guess until a test or a run shows it: show
   it before it becomes a fix or a proposal, and describe what the test showed.

6. **Run the project's fast checks**: typecheck, lint, and the tests related to the changed files.

7. **Report**, in this order:
   - one line per kept change with its `file:line`, and for a restructured function the reason,
     so that someone who has read that code knows to read it again;
   - each bug fix, with the behavior before and after;
   - the proposals;
   - any untracked file that step 2 staged.

   Inside `preflight`, proposals go to its decision report. Run on its own, ask the developer
   about each proposal with `AskUserQuestion`, and offer to commit; this skill never commits.
