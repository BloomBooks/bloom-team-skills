---
name: pr-ready-for-human
description: Promote a preflighted, self-reviewed PR to human (peer) review. Step 3 of the review sequence — (1) run preflight, (2) the developer reviews the work themselves, (3) the developer runs this. Verifies the PR is genuinely clean (CI green, bots quiet, nothing newer than the last preflight), squashes the branch to a single commit (unless the commit split genuinely helps the reviewer), links the PR on the tracker card and moves it to the project's ready-for-peer-review state, marks the PR ready-for-review, and moves the personal board to its human-review column. If anything is not clean, it bounces back to preflight instead of fixing things itself.
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
re-run `preflight`, re-review, then run this again. (The squash this skill itself performs
in Stage 2 does not count as new work — it changes no content.)

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

## Stage 2 — Squash to a single commit

Human review should normally see **one commit**. Once Stage 1 passes, squash the branch's
commits into a single commit — unless the commit split genuinely helps the reviewer, e.g. a
mechanical refactor or a rename kept separate from the actual fix so each can be reviewed on
its own terms. "Address bot feedback", "fix typo", "wip" commits never justify keeping the
history; when in doubt, squash. If you keep multiple commits, say why in the final report.

Mechanics (interactive rebase is not available here):

1. `base=$(gh pr view <n> --json baseRefName -q .baseRefName)`; `old=$(git rev-parse HEAD)`.
2. `git reset --soft $(git merge-base HEAD origin/$base)`, then commit with a message written
   for the reviewer — describe the change as a whole (the PR title is usually the right
   summary line), not the commit-by-commit history. Keep any `Co-Authored-By:` trailers.
3. Verify nothing changed: `git diff $old HEAD` must be empty. If it isn't,
   `git reset --hard $old` and bounce to preflight.
4. `git push --force-with-lease`. The user invoking this skill is the explicit authorization
   for this push.

Consequences of the new SHA:

- **CI re-runs.** The tree is byte-identical, so don't wait for it.
- **Devin's pre-squash run still counts** — the diff is unchanged — so do not re-run the
  gauntlet or treat the squash as "a new commit after preflight".

If the branch is already a single commit, skip this stage silently.

## Stage 3 — The tracker: PR link + card state

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

## Stage 4 — Promote

1. **Mark the PR ready for review**: `gh pr ready <n>`. Do **not** request a specific
   reviewer — choosing a reviewer is the developer's call, made outside this skill. If Stage 1
   already found `isDraft: false` (the author un-drafted it by hand), skip the call and say so —
   but still do step 2, which is precisely the case that leaves a stale report behind.
2. **Correct the published preflight report's PR-state chip.** Preflight's report page lives at a
   stable public URL (`deciders/<sourceRepo>-<branch>.html` in `BloomBooks/dev-process-artifacts`)
   and is linked on the tracker card, so people keep opening it after the promotion — and its
   header chip still says "Draft PR". Patch that one chip in place; do not re-render the report
   (its decisions, gate results, and reviewer outcomes must stay exactly as preflight left them).

   ```bash
   DPA=<any working dir>/dev-process-artifacts
   git clone --depth 1 https://github.com/BloomBooks/dev-process-artifacts "$DPA" 2>/dev/null \
     || git -C "$DPA" pull --ff-only
   F="$DPA/deciders/<sourceRepo>-<branch>.html"
   node -e '
     const fs=require("fs"), f=process.argv[1], s=fs.readFileSync(f,"utf8");
     const out=s.replace(/<!-- pr-state:begin -->[\s\S]*?<!-- pr-state:end -->/g, m =>
       m.replace(/data-pr-state="draft"/g,"data-pr-state=\"ready\"").replace(/>Draft PR</g,">Ready for review<"));
     fs.writeFileSync(f,out); console.log(out===s?"NO CHANGE":"patched");
   ' "$F"
   git -C "$DPA" commit -am "PR <n> (<sourceRepo> <branch>) is ready for review" && git -C "$DPA" push
   ```

   Rewriting only what sits between the `pr-state` markers keeps the report's own class names and
   styling intact. Then confirm the live URL returns 200 and serves the new text (the Pages deploy
   takes ~1 min — see `dev-process-artifacts.md` at the root of the bloom-team-skills clone, reached
   via this file's real path, not a `../` hop).

   Cases where there is nothing to patch — note each in the report and move on, never guess at
   unmarked HTML:
   - **No such file** (no ticket id, so preflight published a private Anthropic Artifact instead,
     or no report was ever published) → nothing to do. The one exception: if that private artifact
     came from *this* session and you still have its local file, correct the chip there and
     redeploy to the same `url`.
   - **The file has no `pr-state` markers** (published before this convention) → say in the report
     that the published report still shows "Draft PR" and that re-running `preflight` would
     refresh it. Do not attempt a blind text substitution on the page.
   - **`NO CHANGE`** printed with markers present → it already says ready; leave it.

   If `data-pr-state` flipped but the visible label did not (a report that worded its chip
   differently), fix the label by hand in the same edit — the text is what people actually read.
3. **Personal board**: if a `personal-board` skill is available, invoke it to record that the
   developer has explicitly handed this to peer review (the user running this skill is the
   explicit command that skill requires). Skip silently if unavailable.
4. **Report**: "PR #<n> is now marked ready for review; the tracker card is in its
   ready-for-peer-review state (name it). PR: <URL>" plus whether the published preflight report's
   PR-state chip was updated (with its URL), and anything skipped (e.g. the tracker was
   unreachable).

## Rules

- Never promote with failing CI, unanswered bot comments, or without Devin having run —
  bounce to preflight instead. No exceptions except an explicit user override ("skip the
  checks, promote anyway"), which must be noted in the report.
- Never request a teammate's review; un-drafting the PR is the handoff.
- **Whenever the PR's draft state changes — or you find a human already changed it — the published
  preflight report has to agree.** A report that still shows "Draft PR" is read by the reviewer and
  by whoever picks the card up later. Invoking this skill authorizes the one-chip patch-and-push to
  the public `dev-process-artifacts` repo that Stage 3 step 2 describes; it authorizes nothing else
  in that repo.
- Anything posted under the user's account (the tracker or GitHub) starts with an identifier of
  which model you are.
- Always check for duplicate comments on the card before posting.
