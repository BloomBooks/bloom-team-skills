---
name: preflight
description: Run the pre-review preflight on whatever is on the current branch — the automated checklist before the "flight" of human review. Runs typecheck/lint/tests (cycling on changes), commits & pushes, opens a DRAFT PR if none exists, then runs the bot gauntlet (triggers Devin, gathers Devin/Greptile/CI + other bot feedback), auto-fixes and auto-replies to bots, ensures the branch merges cleanly with the base, and finishes by landing the work for the user's own final review with a ranked decision report for anything that needs a human. The local review defaults to a LIGHT single-sub-agent pass (high-confidence bugs only); say "/preflight with code-review" for the full (token-hungry) /code-review + fix loop, or "/preflight without review" to skip local review entirely. Does everything reasonable autonomously; the only things left when the user returns are the ones truly waiting on them. Never marks the PR ready-for-review and never requests a teammate's review.
argument-hint: "optional: PR number or branch name — defaults to the current branch/worktree. Local review level: light sub-agent pass by default; 'with code-review' = full /code-review + fix loop; 'without review' = none."
user-invocable: true
---

# Preflight

Goal: run the pre-review preflight on whatever is on the current branch — make it the best,
ready-to-go version of itself, doing everything reasonable without the user, then hand back a
decision report for anything that needs a human. This is the checklist *before* the flight of
human review/merge; it does not ship or promote anything itself.

## Core principle
Front-load all autonomous work. Batch every human decision into the final report. When the
user's attention returns, the only things left should be ones that genuinely need them. Do
**not** stop mid-run to ask.

## Autonomy line — when to REPORT instead of act
Do it yourself when it's safe and clear. Put it in the decision report (and keep going on
everything else) when it is any of:
- a change to **user-facing behavior or a public API/interface/contract**;
- a **large or architecturally-significant** change, or one touching **many files**;
- a **semantic** merge conflict (resolve only trivial ones — lockfile, imports, formatting);
- **disagreeing with a human comment** (always report; never auto-dismiss a human).

Disagreeing with a **bot** does *not* need the user — post a reply and move on.

## Phase 0 — Preflight & discover
- Identify branch, base (default `master`/`main` — confirm via remote HEAD), and `owner/repo`
  from `git remote get-url origin`.
- Extract a ticket id from the branch name if present (e.g. a `PROJ-1234` prefix).
- Detect the toolchain: package manager from the lockfile (`pnpm-lock.yaml`→pnpm,
  `yarn.lock`→yarn, else npm) and the **typecheck / lint / test / build** commands from
  `package.json` `scripts`. Record a **non-watch** test command (prefer a `test:ci`/`run`
  variant; NEVER launch a watch-mode runner — it hangs). Fallbacks: typecheck →
  `<pm> exec tsc --noEmit`; lint → the `lint` script.
- Look for a **private board skill** the user has (a skill whose job is their personal
  work/review board). If found, invoke it to mark this worktree as actively being worked on, and
  use it for all later board moves. If none, skip board steps silently.

## Phase 1 — Local quality gate (loop until clean)

The local review runs at one of three levels — the full `/code-review` + fix loop chews up a
lot of tokens, so it is opt-in:

- **Light (the DEFAULT):** one sub-agent review pass — see below.
- **Full** — only when the user asked (e.g. **"/preflight with code-review"**): the
  `/code-review` + fix loop below.
- **None** — only when the user asked (e.g. **"/preflight without review"**), for
  tiny/mechanical changes: skip straight to typecheck/lint/fast tests.

**At every level:** repeat until **typecheck**, then **lint**, then **fast tests** (only
changed/related tests) all pass. Fix what's safely fixable; report the rest.

**Light review (default):** dispatch ONE general-purpose subagent over the working diff.
Prompt it to: read the diff plus just enough surrounding code to judge it; report only
**clear, high-confidence correctness problems** (bugs, broken edge cases, misused APIs,
unintended behavior changes) — no style points, no nits, no refactor ideas, no "consider…";
and return a short structured list (file:line, what breaks, why it's wrong). One pass, no
verification loop, no re-review after fixes (typecheck/lint/tests are the re-check). Triage
its findings exactly like full-mode findings: safe and clear → fix; crosses the autonomy
line → decision report; wrong → dismiss with a one-line reason.

**Full review ("with code-review")** — each cycle is:
1. Run the `/code-review` skill at `high` effort with `--fix` on the working diff.
2. For any finding that crosses the **autonomy line**, do NOT apply it — add it to the decision
   report and continue with the rest.
3. Run typecheck, lint, and fast tests as above.
4. Re-run `/code-review` to confirm nothing remains that we think should be fixed. Cycle.

**Record the local-review outcome for the report** (whatever the level). The local review is one
of the bots in the gauntlet — the local one — so its results must surface alongside
Devin/Greptile/etc. (see Phase 4 and the report sections). Capture, across all cycles: which
level ran, how many findings it raised, how many were auto-fixed, how many were escalated to the
decision report (autonomy-line crossers), and how many were dismissed as wrong (with a one-line
reason). If it found nothing, record that explicitly so the report shows the review ran and came
back clean. If the user skipped it, its row says "skipped at user request ('without review')" —
never silently omit the row.

Cap the loop (e.g. 4 cycles) to avoid churn; note if capped.

**Before any push, run the FULL non-watch test suite.** Failures → try to fix; if not
autonomously fixable → decision report + (via the board skill) a "needs response" state.

## Phase 2 — Publish (commit, push, draft PR)
- Stage & commit everything on the branch (including pre-existing uncommitted work — that's
  "what's on the branch"). Message: `<concise summary> (<TICKET>)` plus the repo/user's required
  commit trailer, identifying which model you are. Let pre-commit hooks run.
- Push, setting upstream if needed.
- Ensure a **draft** PR exists: `gh pr list --head <branch> --json number,url,state,isDraft`. If
  none: `gh pr create --draft --base <base> --title "<summary> (<TICKET>)" --body "<summary>\n\nRef: <tracker-url-if-known>"`.
  (Do NOT do the promote-to-human ceremony — that's the other skill.)
- Record PR number & URL.

## Phase 3 — Mergeability with the base
- `git fetch origin`. Determine whether the branch merges cleanly into `origin/<base>`.
- No conflicts → continue.
- **Trivial** conflicts (lockfile, imports, formatting) → merge base in, resolve, re-run the
  Phase 1 gate, push.
- **Semantic** conflicts → decision report; (via the board skill) a "needs response" state.

## Phase 4 — Bot gauntlet
The local review from Phase 1 (light sub-agent pass by default, or the full `/code-review` when
requested) is the first bot through the gauntlet; its captured outcome (level ran, findings
raised / fixed / escalated / dismissed) is part of this section's results even though it ran
earlier. The remote bots below join it.

1. **Trigger Devin.** Use the **`devin-review`** skill — it is the single source for Devin
   mechanics (its CI-based re-trigger is more reliable than the browser, and Devin also
   auto-triggers on push). Record that it was triggered for this commit.
2. **Gather all currently-available bot feedback** (don't wait for Devin yet):
   - CI: `gh pr checks <n>`.
   - Bot comments/reviews — Devin (`devin-ai-integration`), Greptile, CodeRabbit, etc. — via
     `gh api repos/<owner>/<repo>/pulls/<n>/comments`, `.../issues/<n>/comments`,
     `.../pulls/<n>/reviews`. Consider items newer than our last commit / not yet resolved.
3. **Evaluate each item:**
   - Clear, correct, within the autonomy line → **fix it**.
   - Bot is mistaken → **post a reply on GitHub** explaining why (prefix the body with an
     identifier of which model you are). No need to ask the user.
   - Crosses the autonomy line, **or is a disagreement with a human** → **decision report**
     (never auto-dismiss a human).
4. If any fixes were made → re-run Phase 1 (fast), commit, push, and **re-trigger the bots**
   (cap the overall cycle count; note if capped).
5. **Devin polling:** after the other work, poll every ~5 min, **non-blocking**, up to a cap
   (~20–25 min); never block-sleep. Fold any Devin findings into step 3's logic. **On timeout,
   re-trigger Devin once**, and record in the report how long we waited before giving up (its
   results may post later — re-running `preflight` will fold them in).

## Phase 5 — Converge, land, report
Enter when: quality gate clean, CI passing, all **bot** comments resolved (fixed or replied),
branch mergeable, and only human-decision items (if any) remain.
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
Branch/PR link & draft status; typecheck/lint/test results; what changed this run; bot outcomes
(fixed / replied / pending) — **including the local review as its own bot line** (which level ran
— light sub-agent pass or full `/code-review` — findings raised / fixed / escalated / dismissed,
or "clean", or "skipped at user request"); Devin status (incl. how long we waited if it timed
out); mergeability; final board state; and the count of items now waiting on the user.

### Report artifact (always) — publish as a Claude Artifact
In addition to the chat summary, **always** render this report as a **Claude Artifact**: load the
`artifact-design` skill first, write the page content to a file, and publish with the Artifact tool.
Artifacts are **private by default and there is no public toggle** — tell the user they can share it
or make it public from the artifact's own share menu. It augments, does not replace, the chat
summary.

**After publishing, open the report in the user's default browser** (Windows:
`Start-Process '<url>'` from PowerShell or `start "" "<url>"`; macOS: `open <url>`; Linux:
`xdg-open <url>`) — in addition to, not instead of, printing the bare URL in the chat summary.

**Surface the artifact URL as a bare, plain-text URL in the chat summary — never as a markdown
link** (`[label](url)`). In the terminal a markdown link renders as styled label text with the URL
hidden, so the user cannot open or copy it; it reads as "a nice underlined blue thing that isn't
actually a URL." Print the raw `https://…` on its own so it is copyable. (The same applies to any
other link you want the user to actually follow from the chat — PR, files-changed, etc.: give the
bare URL, not link-text. Inside the HTML artifact, normal `<a href>` links are correct and expected.)

The artifact must follow all of this:

- **Clean, light visual style — no dark mode.** Warm off-white ground, white bordered cards (avoid
  heavy shadows), one restrained accent, system serif headings + system sans body (do NOT link
  webfonts — the artifact CSP blocks them). If the project has its own design system, follow it.
- **Two columns on wide screens:** the report (gate table, what-changed, bot outcomes, session
  notes) on the left and the interactive decisions on the right; collapse to one column when narrow.
- **Plain headings — no decorative eyebrows/kickers or numbered section labels** ("Section 1",
  "Over to you", etc.). Just the heading text.
- **No instructional preamble** telling the user how the controls work (no "each option has a
  footnote… pick then press copy" blurb) — the questions and buttons speak for themselves.
- **The whole run at a glance:** quality-gate table, what changed this run (each commit), bot
  outcomes, and the decision items. The **bot-outcomes** block lists every reviewer that ran,
  **one row per bot** — the local review first, labeled with the level that ran ("light
  sub-agent pass" / "full /code-review" / "skipped at user request") plus findings raised /
  fixed / escalated / dismissed, or "clean — no findings". Then Devin, Greptile, CodeRabbit,
  CI, etc. Never omit the local review row; a run where it found nothing (or where it was
  skipped) still gets a row so that is visible.
- **Links everywhere they exist.** PR, Files-changed, Commits; each commit page; each bot's
  summary/review and every resolved/open thread (fetch the real comment/thread ids via `gh`) — for
  Devin, link its review page `https://devinreview.com/<owner>/<repo>/pull/<n>`; and
  **precise `file:line` deep links** into the code — build blob URLs at the HEAD sha
  (`.../blob/<sha>/<path>#L<line>`) and **verify the current line numbers first** (grep at HEAD;
  they shift after edits) so every anchor is accurate. **Every `<a>` must open in a new tab**
  (`target="_blank" rel="noopener"`).
- **Quality-gate table:** typecheck, lint, merge-cleanliness, and **tests broken out one row per
  language/test-runner** — e.g. a row for the TypeScript tests (vitest/jest) and a *separate* row
  for the C# tests (`dotnet test`), plus any other stack present. Show the count and pass/fail per
  row. If a stack has no tests in this repo, still give it its own row marked "N/A — none in this
  repo" so it's clear nothing was silently skipped.
- **Decision items — written for a reader with zero context.** Use complete sentences and spell
  everything out: what the situation is, what the user would actually see or experience, why it
  happens, and why it may or may not matter. Never assume the reader remembers the code or the
  conversation. For each item:
    - Render the choices as a radio group (checkboxes only when genuinely non-exclusive), with the
      recommended option pre-selected and tagged.
    - **Annotate each concrete fix option with a fix-complexity footnote** — a short parenthetical
      estimating the effort/risk of that choice (e.g. "~10 lines, localized, low risk", "moderate —
      changes the hook's public shape", "large / architectural", "no code — just a doc note"). This
      lets the user weigh benefit against cost at a glance. **The `Leave as is` option gets NO
      footnote** (don't editorialize it with "no work" / "leaves it undocumented", etc.).
    - **Put the rationale for the recommendation *inside* the recommended option itself** (as part of
      its text or footnote — "…, recommended because …"). Do **not** add a separate "Why the
      recommended option" callout above the choices. Exception: if the recommended option is
      `Leave as is` (which carries no footnote), weave the rationale into the item's description
      paragraph instead.
    - **Standard option order, identical on every decision/FYI item:** first the concrete fix
      option(s); then — **always second-to-last** — an option labeled **exactly `Leave as is`**
      (this exact wording every time; never "Accept as is" or a longer variant), even when it is
      the recommended choice (in which case it is the pre-selected/tagged one); then — **always
      last** — an option labeled **exactly `Other:`** with an inline text box for a custom answer.
      Do not assume `Leave as is` means the behavior is intentional — it may simply not be worth the
      added complexity.
    - **On the far right of the `Leave as is` row, a checkbox labeled `Leave comment`.** When ticked
      it signals the user wants a comment left (in the code and/or on the PR) documenting the
      decision to leave the item as-is.
    - **Every question must also have a separate notes text box** so the user can pick one of the
      offered options *and still* add caveats or constraints.
    - Include the FYIs and a final "next step" (implement vs. discuss first) question. The
      `Leave as is` + `Leave comment` convention applies to every decision and FYI item; all
      questions (including "next step") still end with the `Other:` option and carry a notes box.
    - Give every control — radios, the `Leave comment` checkbox, each `Other:` input, and each notes
      box — a `data-q` label so it all serializes into the copy-back text.
- **One copy-back button** that serializes every selection, every "Other" text, and every note into
  a clean plaintext block the user can paste straight back into the session. Copy via
  `navigator.clipboard.writeText` **with a fallback** (write to a visible readonly `<textarea>`,
  `select()`, `execCommand('copy')`) so it works even if the async clipboard is blocked — the visible
  textarea guarantees a manual Ctrl+C. Show a "copied" confirmation.

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
