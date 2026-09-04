# Preflight report artifact — design & behavior spec

Read this when building the Phase 5 report artifact. It defines the page's design, content
blocks, decision-item controls, and copy-back behavior. Load the `artifact-design` skill first,
then write the page content to a file, **check how it renders**, and publish it.

Note on the file itself: when publishing to the public repo the page is served as-is (by GitHub
Pages or githack), so write a **complete HTML document** — `<!doctype html>`, `<head>` with a `<title>`, and
your own CSS reset. (The wrapping-skeleton behaviour, where you write body content only, applies
to the Anthropic Artifact tool, not here.)

## Check the render before you publish

You are writing a page you never look at, which is how a report with the decisions column pushed
off-screen gets published and linked on a card. **Open the local file and check it before
publishing** — the whole check is five assertions and takes one round-trip:

```bash
chrome-devtools new_page "file:///<path>/preflight-report.html"
chrome-devtools resize_page 1440 1000
chrome-devtools evaluate_script "() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, prLink: !!document.querySelector('a[href=\"https://github.com/<owner>/<repo>/pull/<n>\"]') })"
chrome-devtools take_screenshot --format png --filePath "<scratch>/shot.png"   # then Read it
```

1. **The PR link is there** — `prLink` must be `true`: an `<a>` whose `href` is exactly the PR's
   own GitHub page (not `/files`, not `/commits`, not a comment anchor — and not Devin's review
   page, whose URL also ends in `/pull/<n>`, which is why the selector matches the whole URL).
   `false` means the header links row is missing or the PR number is sitting there as plain text.
   This is the most-used link on the page and the one most often shipped missing; fix it before
   looking at anything else. No browser available? The grep in Publishing is the fallback.
2. **No horizontal overflow** — `scrollWidth > clientWidth` must be `false`, at a wide width
   (~1440) *and* a narrow one (~620, where it collapses to one column). Sideways scroll almost
   always means a grid item that cannot shrink; see the Visual style rules.
3. **Look at the screenshot.** The "what this PR is about" card is the first thing on the page,
   the header links row (PR first) is visible, both columns are present, the decisions are
   visible, no prose set in monospace, no text running under or past a neighbour.
4. **The copy-back actually serializes.** Read `#payload`, then flip a couple of controls and read
   it again — confirm a selection changes the text, a `Leave comment` tick adds its line, an
   untouched `Leave comment` adds nothing, and `Other:` picks up its typed value.
5. **Only then publish.** If you find a defect after publishing, fix and republish to the *same*
   path so the card's link stays valid.

## Publishing

- **Before the file leaves the machine, grep for the PR link** — whichever target you publish to,
  and whether or not the browser check above ran:

  ```bash
  grep -c 'href="https://github.com/<owner>/<repo>/pull/<n>"' preflight-report.html   # must be ≥ 1
  ```

  `0` means the report cannot take its reader to the PR. Add the header links row (block 0) and
  re-check; do not publish a report that fails this.
- **Publish once, to exactly one target.** Do not publish the same report through both the
  public repo and the Anthropic Artifact tool — that produces two links and opens two browser
  tabs.
- **Picking the target: does the link leave the session?** When a ticket id was found, it does —
  Phase 5 posts the report URL to the YouTrack card so decisions can be picked up later by
  someone other than the in-session developer — so publish to the **public
  `dev-process-artifacts` repo (GitHub Pages URL)**; see **`dev-process-artifacts.md` at the root of the
  bloom-team-skills clone** — do *not* resolve that as a path relative to this file. Skills are
  symlinked individually into `~/.claude/skills`, so a `../../` hop lands in the skills directory,
  not in the clone, and the file appears to be missing when it is not. Reach it via this file's
  real path (`readlink -f`), or read it from
  https://github.com/BloomBooks/bloom-team-skills/blob/main/dev-process-artifacts.md. The same
  applies whenever the link otherwise has to leave the session (handed to a teammate or another
  agent, the user asks for a public link) or the Artifact tool is unavailable. Name it
  `deciders/<sourceRepo>-<branch>.html` — the URL is stable per branch, so a re-run overwrites
  the same page and the card's report-link comment stays valid (post that stable URL to the
  card, not a commit-pinned one). The Pages deploy takes ~1 min, so on a re-run the previous
  version can serve briefly — confirm the URL returns 200 (and shows the new report) before you
  post or open it.
- **Otherwise (no tracker card, link stays in-session): the Anthropic Artifact tool.** That
  report is transient — the in-session developer reads it, answers the decisions, and it's
  spent — so a private link is enough. It's one tool call: no clone/push, no third-party CDN,
  and no cache staleness when a fix loop re-runs preflight minutes later. Say in the chat
  summary that the link is **subscriber-only** (private, no public toggle) and that the user can
  share it to fellow subscribers from the artifact's own share menu.
- Either way the report augments, never replaces, the chat summary.
- **After publishing, open the report in the user's default browser exactly once** — the one
  canonical URL, and only if this report hasn't already been opened this run. Windows:
  `Start-Process '<url>'` from PowerShell or `start "" "<url>"`; macOS: `open <url>`; Linux:
  `xdg-open <url>`. When you published to the public repo, the Pages URL is a written-down
  fallback: print it, never open it.
- **In the chat summary, print the artifact URL as a bare, plain-text URL — never a markdown
  link** (`[label](url)`). In the terminal a markdown link renders as styled label text with the
  URL hidden, so the user cannot open or copy it. The same applies to any other link the user
  should follow from chat (PR, files-changed, etc.). Inside the HTML artifact, normal `<a href>`
  links are correct and expected.

## Visual style

- **Clean, light visual style — no dark mode.** Warm off-white ground, white bordered cards
  (avoid heavy shadows), one restrained accent, system serif headings + system sans body (do NOT
  link webfonts — the artifact CSP blocks them). If the project has its own design system,
  follow it.
- **Two columns on wide screens:** the report (the PR narrative, gate table, what-changed,
  reviewer outcomes, worth-knowing) on the left and the interactive decisions on the right;
  collapse to one column when narrow.
- **Put `min-width: 0` on the two grid children.** A grid item's automatic minimum size is its
  *content's* size, so one wide table cell expands its column until the whole page scrolls
  sideways — which pushes the entire decisions column off-screen, i.e. the user never sees the
  questions. `overflow-x: auto` on the table wrapper does **not** save you here: the wrapper
  cannot shrink below its content until the grid item is allowed to. This has actually shipped a
  broken report; treat it as required, not as a tip.
- **Monospace and `tabular-nums` are for figures, not sentences.** Wrap the numbers
  (`<span class="numeral">3024 passed · 12 skipped</span>`) and leave the surrounding prose in the
  body face. Never put `white-space: nowrap` on a cell that contains prose — an unbreakable
  sentence is the usual cause of the sideways-scroll above.
- **Plain headings — no decorative eyebrows/kickers or numbered section labels** ("Section 1",
  "Over to you", etc.). Just the heading text.
- **No instructional preamble** telling the user how the controls work — the questions and
  buttons speak for themselves.

## Content blocks

The page has, in this order down the left column: **what this PR is about**, the quality gate,
what changed this run, reviewer outcomes, and (only if it earns a place) worth-knowing. The
right column is the decision items and the copy-back.

(The numbers below are this spec's ordering, not heading text — the page's headings stay plain,
per Visual style.)

### 0. Header — the run summary, the status chips, and the links row

A one-line summary of the run, a row of status chips — **PR state**, mergeability, bots quiet,
and how many items are waiting on the user — and then a **links row**.

**The links row is required, and the PR link leads it.** Going from the report straight to the
PR is the single most common thing a reader does with this page, and it has shipped missing more
than once: a report with `#8305` as plain text in the state chip, links to the files view and to a
commit, and no way to reach the PR itself. So the PR link has a fixed home, not a mention in
passing: the **first chip of the links row**, labeled `PR #<n>`, whose `href` is the PR's own page
— `https://github.com/<owner>/<repo>/pull/<n>`, not `/files`, not `/commits`, not a comment
anchor. After it, in this order: `Files changed` (`/pull/<n>/files`), `Commits`
(`/pull/<n>/commits`), the tracker card when there is one (label `BL-<id>`, linked to its YouTrack
page), and each remote reviewer's page (Devin: `https://devinreview.com/<owner>/<repo>/pull/<n>`).
Every entry is an `<a>` with a visible label. A PR number or card id in plain text is not a link
and does not satisfy this; neither does a link to the files view or a commit "because the PR is
one click from there". The sample screenshot (`preflight-report-sample.png`) shows the row — the
chips after "Board". The render check and the pre-publish grep both look for this link.

The state chip may additionally wrap its label in an `<a>` to the same PR URL (an anchor inside
the span keeps the markers' shape and survives `pr-ready-for-human`'s patch, which only swaps the
attribute and the label text) — but that is optional; the links row is what is checked.

**The PR-state chip is read live, never assumed.** This report outlives the run: it sits at a
stable URL linked on the tracker card, and afterwards `pr-ready-for-human` — or the human author
by hand — un-drafts the PR. A chip that still says "Draft PR" then misleads everyone who opens
that link. Two rules keep it honest:

- **Read the state at the moment you write the page** (`gh pr view <n> --json isDraft,state`) and
  render from that. Never hard-code "Draft PR" on the grounds that preflight just made it one.
- **Make it patchable in place**, so a later skill can correct the one chip without re-rendering
  the whole report. Wrap it in marker comments and stamp the state as a data attribute:

  ```html
  <!-- pr-state:begin --><span class="chip" data-pr-state="draft">Draft PR</span><!-- pr-state:end -->
  ```

  `data-pr-state` is `draft` or `ready`; the label is `Draft PR` or `Ready for review`. Keep the
  markers and the chip on **one line**, in exactly this shape (your own class names are fine) —
  `pr-ready-for-human` rewrites what sits between the markers, and drifting from this shape is
  what leaves a stale "draft" chip on a promoted PR. Emit the markers on every run, including the
  ordinary one where the PR really is a draft.

### 1. What this PR is about — the first thing on the page, on every run

**Required, always, from the very first run.** The report's opening card is the **PR narrative**:
what problem the PR set out to solve, the cause that was diagnosed where that isn't already
obvious from the problem, and what the **whole PR** changes to fix it. SKILL.md's "The PR
narrative" section defines it — its content, its length budget (~150–250 words), and how it is
maintained across runs. Follow that; this file only says where it goes: first, above the quality
gate, in the left column, as its own card.

Give the card sub-headings so it can be skimmed — **Problem**, **Cause** (omit the heading
entirely when there is no separate cause to state), **What the PR does**. Prose and short
bullets, in behavior terms, not a commit log and not a file list.

This card is the reason someone can open the report cold — a reviewer, or the developer's
colleague picking up the card next week — and answer the decisions sensibly. It is **never**
dropped on a later run on the grounds that it hasn't changed, and it is never replaced by an
account of what the latest run did.

### 2. Quality gate

A table: typecheck, lint, merge-cleanliness, and **tests broken out one row per
language/test-runner** — e.g. a row for the TypeScript tests (vitest/jest) and a *separate* row
for the C# tests (`dotnet test`), plus any other stack present. Show the count and pass/fail per
row. If a stack has no tests in this repo, still give it its own row marked "N/A — none in this
repo" so it's clear nothing was silently skipped. Likewise a stack whose suite was deliberately
**not run** because the diff can't reach it (SKILL.md Phase 4 step 4) gets a row saying exactly
that — "not run — no C# in the diff" — carrying the same weight as a pass or a fail. The reader
must never have to guess whether a missing suite was a judgment call or a slip.

### 3. What changed this run — short, and that is the point

A **run** is one invocation of preflight, usually several commits (SKILL.md, "What a run is").
This block says, in **at most three sentences or four bullets**, what this run did to the branch
— e.g. "Fixed the two findings Devin raised about command-line entry points, merged master
twice, and committed three test cases that were sitting in the working tree." Then link the PR's
commit list, and the individual commits if there are few.

**Do not write a table with a paragraph per commit.** That is the failure this block is
constrained against: it grows every run, it duplicates what GitHub already shows better, and it
crowds out the narrative that a reader actually needs. Per-commit detail lives in the commit
messages; what the PR *does* lives in block 1. If a run's change is genuinely significant, the
right move is to fold it into block 1 — not to expand this one.

On a re-run where nothing changed but the verification, one sentence: "No code changes — re-ran
the gauntlet against the same HEAD to fold in late reviewer results."

### 4. Reviewer outcomes

One row per reviewer that ran, **one to three sentences each**. The **local review first**,
labeled with the level that ran ("light sub-agent pass" / "thorough /code-review" / "skipped at
user request") plus findings raised / fixed / escalated / dismissed, or "clean — no findings" —
never omit this row. Then one row per remote reviewer and CI. **Every remote-reviewer row shows a
terminal state** — "complete" (with its findings summary) or "timed out after N min" — per the
skill's terminal-state rule; if a row would say "pending", the run converged too early — fix
that, don't paper over it in the report.

**Not a transcript.** A reviewer that ran eight times gets its current state and a one-sentence
summary of what it found across the branch, with links to the threads — not a round-by-round
history, not a re-narration of each finding and how we judged it. Each finding already has a PR
thread carrying its own outcome; that thread is the record, and linking it beats retelling it.

### 5. Worth knowing — only what changes what someone does

Optional, capped at about five bullets, and each bullet must pass the test in SKILL.md's "What
the report is for": **would a reviewer, or the person answering the decisions, do something
differently for having read it?** Legitimate entries look like:

- behavior that has **not** been exercised by hand and could be silently broken;
- something deliberately left out of scope, and why;
- a pre-existing oddity in the touched code that looks alarming and isn't (so a reviewer doesn't
chase it).

What does **not** go here, however interesting: the decisions we already made and acted on, the
reasoning behind each fix, an assessment of ours that a later round corrected, a bot that
errored and was re-triggered, a sub-agent that stalled, a tool that needed a workaround. Those
belong in the code, on the review thread, in the test ideas, or in a papercut — not in the
report. If nothing survives the test, **omit the block**; an absent section is better than a
padded one.

### Links everywhere they exist

PR, Files-changed, Commits (these three have their fixed home in the header links row, block 0 —
repeat them elsewhere freely, but never rely on a deep link somewhere in the body to stand in for
the header's PR link); each commit page; each reviewer's summary/review and every
resolved/open thread (fetch the real comment/thread ids via `gh`) — for Devin, link its review
page `https://devinreview.com/<owner>/<repo>/pull/<n>`; and **precise `file:line` deep links**
into the code — build blob URLs at the HEAD sha (`.../blob/<sha>/<path>#L<line>`) and **verify
the current line numbers first** (grep at HEAD; they shift after edits) so every anchor is
accurate. **Every `<a>` must open in a new tab** (`target="_blank" rel="noopener"`).

Links are how the report stays short: a link to a thread replaces a paragraph retelling it.

## Decision items

Written for a reader with **zero context**. Use complete sentences and spell everything out:
what the situation is, what the user would actually see or experience, why it happens, and why
it may or may not matter. Never assume the reader remembers the code or the conversation. (The
narrative card carries the shared background about the PR, so an item need not restate that —
but it must still stand up on its own for someone who scrolled straight to the questions.)

Only **open** questions belong here. A decision the user already made on an earlier run is
settled: it lives on the review thread, in a code comment, or in the test ideas, and it is not
re-asked or re-summarized (SKILL.md, "Processing the user's decisions"). For each item:

- Render the choices as a radio group (checkboxes only when genuinely non-exclusive), with the
  recommended option pre-selected and tagged.
- **Annotate each concrete fix option with a fix-complexity footnote** — a short parenthetical
  estimating the effort/risk of that choice (e.g. "~10 lines, localized, low risk", "moderate —
  changes the hook's public shape", "large / architectural", "no code — just a doc note"). This
  lets the user weigh benefit against cost at a glance. **The `Leave as is` option gets NO
  footnote** (don't editorialize it with "no work" / "leaves it undocumented", etc.).
- **Put the rationale for the recommendation *inside* the recommended option itself** (as part
  of its text or footnote — "…, recommended because …"). Do **not** add a separate "Why the
  recommended option" callout above the choices. Exception: if the recommended option is
  `Leave as is` (which carries no footnote), weave the rationale into the item's description
  paragraph instead.
- **Standard option order, identical on every decision/FYI item:** first the concrete fix
  option(s); then — **always second-to-last** — an option labeled **exactly `Leave as is`**
  (this exact wording every time; never "Accept as is" or a longer variant), even when it is
  the recommended choice (in which case it is the pre-selected/tagged one); then — **always
  last** — an option labeled **exactly `Other:`** with an inline text box for a custom answer.
  Do not assume `Leave as is` means the behavior is intentional — it may simply not be worth
  the added complexity.
- **On the far right of the `Leave as is` row, a checkbox labeled `Leave comment`.** When
  ticked it signals the user wants the decision recorded as a **code comment in the repo**,
  near the relevant code. It does NOT gate the PR-thread reply — for items that came from a
  bot review thread, the reply-and-resolve on the thread happens regardless of this checkbox
  (see the skill's "Processing the user's decisions").
- **Every question must also have a separate notes text box** so the user can pick one of the
  offered options *and still* add caveats or constraints.
- Include the FYIs and a final "next step" (implement vs. discuss first) question. The
  `Leave as is` + `Leave comment` convention applies to every decision and FYI item; all
  questions (including "next step") still end with the `Other:` option and carry a notes box.
- Give every control — radios, the `Leave comment` checkbox, each `Other:` input, and each
  notes box — a `data-q` label so it all serializes into the copy-back text.

## Copy-back button

**Placement:** the copy-back lives as the **final card at the end of the decisions column**
(the bottom of the right column on wide screens, directly after the last decision) — its own
titled card (e.g. "Send your answers back") with a one-line description, the button, and the
readonly textarea beneath it. Do **not** make it a full-width sticky footer or a bar spanning
under both columns — it must read as the last segment of the same column the decisions are in.

**One copy-back button** that serializes every selection, every "Other" text, and every note
into a clean plaintext block the user can paste straight back into the session. **The
`Leave comment` checkbox is serialized only when ticked** (emit something like a
`Leave comment: <the text/where>` line, or a bare `Leave comment` marker under that item);
when it is unticked, omit it entirely — the copy-back text must not mention comments at all
for that item, so an untouched box can't be misread as a request to leave one. Copy via
`navigator.clipboard.writeText` **with a fallback** (write to a visible readonly `<textarea>`,
`select()`, `execCommand('copy')`) so it works even if the async clipboard is blocked — the
visible textarea guarantees a manual Ctrl+C. Show a "copied" confirmation.
