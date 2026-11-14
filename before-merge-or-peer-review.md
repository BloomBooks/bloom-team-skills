# Before a PR goes to peer review or is merged

`request-peer-review` and `merge-without-peer-review` both start with the steps in this file.
They differ only in what happens afterwards, which each skill's own SKILL.md describes. Each skill
reaches this file through its own real path (the skill folders are linked into
`~/.claude/skills`), not through a `../` hop.

Nothing here fixes code or waits on bots; if that's still needed, the answer is "go back to
`preflight`", not a built-in repair loop. If a new commit lands after either skill has run, the
sequence restarts: re-run `preflight`, re-review, then run the skill again. (The squash in Step 2
does not count as new work; it changes no content.)

## Step 1 — Verify the PR is actually clean

Check all of the following. **Any failure → go no further** (see "Not clean" below).

- **Everything committed & pushed**: `git status` clean, no unpushed commits
  (`git log --branches --not --remotes --oneline`).
- **An open PR exists** for the branch (`gh pr list --head <branch> --json number,url,state,isDraft`).
  No PR means preflight never ran — bounce; do not create one here, that would skip the gauntlet.
- **CI green**: `gh pr checks <n>`.
- **Bots quiet**: no unresolved bot comments/reviews newer than the last commit
  (`gh api repos/<owner>/<repo>/pulls/<n>/comments`, `.../issues/<n>/comments`, `.../pulls/<n>/reviews`).
- **Devin has run against HEAD**: use the `devin-review` skill's no-browser signals (a
  `devin-ai-integration` post covering HEAD, or the caller's durable marker — see the
  `personal-board` skill's Devin marker if available). Never go on without Devin having run.
- **Mergeable** with the base branch.
- **The test decision was made** (preflight's "The test decision"). Read the `Test of the
  change:` line in the Automated Tests section, or in a PR comment for a human-written
  description. Pass when it names a test, says `test-only change` (and the diff
  touches no product code), or gives a `developer's decision`. Bounce when it says
  `awaiting` or there is no such line. Never supply a reason yourself.
- **The developer has reviewed every file.** Run `node <bloom-team-skills clone>/dashboard/own-review.mjs <PR URL>`.
  It counts a file as reviewed when the developer marked it Viewed on GitHub's Files changed page,
  or reviewed in Reviewable, for the file's current content. When `left` lists files, name them,
  tell the developer to finish their own review, and stop; this is not a bounce to preflight. When
  it prints `null` or `"reviewable": false`, the marks could not all be read: say so and ask the
  developer (with `AskUserQuestion`) whether they have reviewed the rest.
- **The PR description says what the PR is for.** A peer reviewer starts with the description,
  and after a merge it is the record of why the change was made. It should state the problem, the
  cause where that isn't obvious, and what the whole PR changes, followed by the reviewer sections
  (Screenshots when there is UI, Risk Evaluation, Ecosystem Impact, Automated Tests, E2E Coverage,
  Notion Test Suite; for a PR that fixes several separate problems, each problem with its own
  cause, fix, risk and tests under its own heading) — `preflight` writes exactly that (its "PR narrative" and "reviewer sections"), between
  `<!-- preflight-narrative:begin/end -->` markers. This is the one check that does **not**
  bounce: if the description is missing any of that, or the markers are there but the narrative
  plainly predates the current code, say so in the report and offer to refresh it —
  don't hold the PR for it, and never overwrite a description a human wrote.
- **The commit message(s) and the PR description are accurate for the code as it now stands.** Both
  go stale when work continues after they were written, so check them against
  `git diff origin/<base>...HEAD` rather than trusting them — a stale count ("adds 5 tests" when
  there are now 9), or a description of an approach since reworked, misleads a reader more than
  saying nothing would. Like the bullet above, this does not bounce: fix it, or offer to. Keep
  both terse while you're at it: a commit body is what changed and why in a few lines, not a log
  of how it was verified.
- **Nothing in the PR description is still waiting on a decision the developer has made.**
  Search the description for "waiting on", "decision", "open question" and links to review
  threads, and compare each with the thread: a thread that is resolved, or that carries a reply
  recording the developer's decision, means the text has to say what was decided. Fix it in the
  preflight-written part of the description at once; it is not a bounce. A reviewer who reads
  "waiting on a decision" in a PR handed to them has been handed unfinished work (PR #8566).

### Not clean → bounce to preflight

- Report exactly what is dirty (failing checks, the unanswered comments, the unpushed work).
- If a `personal-board` skill is available, invoke it to reflect that the ball is back in the
  developer's court.
- Tell the user to re-run `preflight`, then stop. Do **not** fix, reply, or wait here.

## Step 2 — Squash to a single commit

The PR should normally be **one commit**, for the peer reviewer and for master's history alike.
Once Step 1 passes, squash the branch's commits into a single commit — unless the commit split
genuinely helps a reader, e.g. a mechanical refactor or a rename kept separate from the actual fix
so each can be reviewed on its own terms. "Address bot feedback", "fix typo", "wip" commits never
justify keeping the history; when in doubt, squash. If you keep multiple commits, say why in the
final report.

Mechanics (interactive rebase is not available here):

1. `base=$(gh pr view <n> --json baseRefName -q .baseRefName)`; `old=$(git rev-parse HEAD)`.
2. `git reset --soft $(git merge-base HEAD origin/$base)`, then commit with a message written
   for the reader — describe the change as a whole (the PR title is usually the right
   summary line), not the commit-by-commit history, and accurate for the squashed diff rather
   than inherited from whichever commit came first. Keep any `Co-Authored-By:` trailers.
3. Verify nothing changed: `git diff $old HEAD` must be empty. If it isn't,
   `git reset --hard $old` and bounce to preflight.
4. `git push --force-with-lease`. The user invoking the skill is the explicit authorization
   for this push.
   Then change the commit shas on the live-check lines at the end of the PR description's E2E
   Coverage section to the new squash commit. The tree is identical, so the checks still hold,
   and a later preflight run can no longer find the old shas.
5. **Reconnect every PR stacked on this branch:** `gh pr list --base <branch> --state open`.
   Each one's head was built on the commits the squash just removed, so GitHub now diffs it from
   an older merge base and shows this PR's changes a second time. For each, merge the pushed
   branch into its head and push; the squashed tree is already in that head, so the merge changes
   no content. Work in a worktree you own (a detached `git worktree add` on a short path), never
   one where someone else has the head checked out. Then confirm
   `gh pr view <m> --json files` lists none of this PR's files. Only PRs based directly on this
   branch need it; the ones above them are based on branches the squash did not rewrite. A
   conflict means the stacked branch holds work beyond this PR's: stop and report it. Invoking
   the skill authorizes these merges and pushes.

Consequences of the new SHA:

- **CI re-runs.** The tree is byte-identical, so don't wait for it.
- **Devin's pre-squash run still counts** — the diff is unchanged — so do not re-run the
  gauntlet or treat the squash as "a new commit after preflight".
- **A bot that declined the PR for size may review it now.** Greptile's file limit counts every
  file any commit touched, so squashing a long branch can bring it under the cap, and Greptile
  then reviews the squashed commit on its own, roughly ten minutes after the push. If a bot's
  newest post on the PR is a size refusal ("Too many files changed for review"), ask the user
  whether to wait for that review before going on (in Claude Code, with the `AskUserQuestion`
  tool; elsewhere, ask in chat and stop until they answer). If they choose to wait and the
  review has findings, the PR is not clean: bounce to preflight. If they choose not to wait,
  say in the report that a review from that bot may still arrive.

If the branch is already a single commit, skip this step silently.

## Taking the PR out of draft wakes the review bots

Greptile reviews a PR when it opens and again when it leaves draft, but not on pushes to a draft.
So the skill's own `gh pr ready` starts a review of code that preflight's gauntlet may never have
shown it, and that review lands minutes after the handoff. On PR #8566 it found a real bug three
minutes after `request-peer-review` had reported the PR clean, and the peer reviewer was the one
who pointed at it.

So, whenever the skill marks the PR ready (or finds it already ready while a comment-posting bot
has not yet reviewed HEAD), it waits for that review before it reports done or merges:

1. Note the time, run `gh pr ready <n>`.
2. Wait for each comment-posting bot that has reviewed this PR before (Greptile today) to review
   HEAD. Use a background waiter with a 15-minute cap, not a sleep loop. Greptile has taken
   three to ten minutes. When it has nothing new to say it posts no review at all: it only edits
   its summary comment, whose last line reads `Reviews (N) · Last reviewed commit: [...](…/commit/<sha>)`.
   So wait for that sha to be HEAD, not for a new review or comment.
3. Read what it posted: the summary comment (it is edited in place, so re-read it), and any new
   inline comments.
   - **No findings** → go on.
   - **Findings** → the PR is not clean. Put it back in draft (`gh pr ready <n> --undo`, then
     `node "$HOME/.claude/skills/dashboard/tell.mjs" pr-changed` when that file exists), leave
     the card where it was before this skill ran, and bounce to preflight, naming the findings.
     The developer runs this skill again once preflight has dealt with them.
   - **Nothing by the cap** → go on, and say in the report that a review from that bot may still
     arrive.

Each skill says where in its own stages this wait falls.

## Step 3 — Make the card accurate

Use the project's **tracker skill** — whichever one its `AGENTS.md`/`CLAUDE.md` declares (see
`preflight`'s "The issue tracker" section for how that declaration works and for the five
operations every tracker skill provides). Moving the card afterwards is each skill's own step.

1. Find this branch's ticket id. No id → skip this step and the skill's card move, and note it.
2. List the card's comments and check a PR link isn't already there
   (`grep -i "github.com.*pull"`) — avoid duplicates.
3. If none, post a comment: `PR: <PR URL>`.
4. **Make the whole card accurate about the PR.** A reviewer or tester starts from the card, so
   read its description and every comment, and the PR's own description, against what the PR is
   now. This step is done when all of these hold:
   - **Every PR link leads to this PR or its stack.** List the ticket's PRs
     (`gh pr list --search "<TICKET>" --state all`). A link to a closed or superseded PR gets
     repointed. An open PR for the ticket outside this PR or its stack is a decision for the
     developer, not something to close here; ask with `AskUserQuestion`. (Retiring a PR a stack
     replaced is in the tracker skill's stack guidance.)
   - **Every statement about the PR's scope is true.** "In this PR" and "not in this PR" lines,
     test lists and counts, and work said to have moved to another card all match the diff and
     the specs as they stand. A "moved to" names the card that holds the work now.
   - **No stale state.** Nothing calls the PR a draft, or says a decision is still open when the
     developer has made it.

   Fix text in place, the same way as the testing notes below: current truth, nothing
   historical. A comment posted under a human's account can't be edited; name it in the report.
5. **Make the testing notes accurate and succinct.** Moving the card is when a tester starts
   reading the test-ideas comment (`add-test-ideas`), and by now it has usually been rewritten
   over several preflight runs. Re-read it against `git diff origin/<base>...HEAD` and fix it in
   place:
   - **Accurate:** every "do this → expect that" matches what the code does now, and, where
     someone tried it in a real build, what was actually seen. An expected message is quoted
     only if it is the one the user really gets. When a run has corrected an earlier belief,
     write the corrected behavior, not the old one.
   - **Current truth, nothing historical:** describe the change as it stands. No "earlier this
     did X", no "round 2", no correction notes stacked under the original; replace the text.
   - **Badges kept consistent** (`add-test-ideas`, "Marking what has already been checked"): an
     item you add or reword gets ▫️▫️ unless it earns a badge, and if no badge remains, drop the
     slots and the legend.
   - **Succinct:** scale it to the change. A small change gets two or three sentences and a
     handful of checkboxes. Cut any item this diff has no plausible way of breaking, and any
     setup a tester doesn't need.
6. **Harvester checkboxes (BloomDesktop).** When the PR description's Ecosystem Impact section
   says `Harvester: affected` (or it lacks the line and the diff changes what
   `Bloom.exe createArtifacts` does; see `preflight`, "Ecosystem Impact"), post a new comment on
   the card holding just these two checkboxes, so that nobody forgets to bring the change to the
   harvester:

   ```
   - [ ] Deployed to dev harvester
   - [ ] Deployed to prod harvester
   ```

   Post it through the tracker skill. If a comment containing `Deployed to prod harvester`
   already exists, leave it, ticked or not. Never tick them yourself, and never put them in the
   description. Say in the report that the comment was added.

When the skill then moves the card: **never move a card backwards.** If it's already in the
target state, or further along, leave it and say so in the report rather than downgrading it.
Which states come later is the tracker skill's knowledge; the no-downgrade rule is this policy.

If the tracker isn't reachable, note it in the final report and continue — this is the
lowest-stakes step.

## Correcting the published preflight report's PR-state chip

Both skills end with the PR out of draft, so both correct this chip. Preflight's report page
lives at a stable public URL (`deciders/<sourceRepo>-<branch>.html` in
`BloomBooks/dev-process-artifacts`) and is linked from the PR description, so people keep
opening it later — and its header chip still says "Draft PR". Patch that one chip in place; do
not re-render the report (its decisions, gate results, and reviewer outcomes must stay exactly
as preflight left them). `<state>` is `ready` or `merged`, as the skill says.

```bash
DPA=<any working dir>/dev-process-artifacts
git clone --depth 1 https://github.com/BloomBooks/dev-process-artifacts "$DPA" 2>/dev/null \
  || git -C "$DPA" pull --ff-only
F="$DPA/deciders/<sourceRepo>-<branch>.html"
node <bloom-team-skills clone>/patch-report-chip.mjs "$F" <state>
git -C "$DPA" commit -am "PR <n> (<sourceRepo> <branch>) is <ready for review|merged>" && git -C "$DPA" push
```

`patch-report-chip.mjs` sits beside this file. Then confirm the live URL returns 200 and serves
the new text (the Pages deploy takes ~1 min — see `dev-process-artifacts.md` beside this file).

Cases where there is nothing to patch — note each in the report and move on, never guess at
unmarked HTML:

- **No such file** (the push to `dev-process-artifacts` failed and preflight published a
  private Anthropic Artifact instead, or no report was ever published) → nothing to do. The one
  exception: if that private artifact came from *this* session and you still have its local
  file, correct the chip there and redeploy to the same `url`.
- **`NO MARKERS`** (published before this convention) → say in the report that the published
  report still shows "Draft PR" and that re-running `preflight` would refresh it. Do not
  attempt a blind text substitution on the page.
- **`NO CHANGE`** → it already says that; leave it.

Invoking either skill authorizes this one-chip patch-and-push to the public
`dev-process-artifacts` repo; it authorizes nothing else in that repo.
