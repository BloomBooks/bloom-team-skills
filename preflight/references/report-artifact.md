# Preflight report artifact — design & behavior spec

Read this when building the Phase 5 report artifact. It defines the page's design, content
blocks, decision-item controls, and copy-back behavior. Load the `artifact-design` skill first,
then write the page content to a file, **check how it renders**, and publish it.

Note on the file itself: when publishing to the public repo the page is served directly by
githack, so write a **complete HTML document** — `<!doctype html>`, `<head>` with a `<title>`, and
your own CSS reset. (The wrapping-skeleton behaviour, where you write body content only, applies
to the Anthropic Artifact tool, not here.)

## Check the render before you publish

You are writing a page you never look at, which is how a report with the decisions column pushed
off-screen gets published and linked on a card. **Open the local file and check it before
publishing** — the whole check is four assertions and takes one round-trip:

```bash
chrome-devtools new_page "file:///<path>/preflight-report.html"
chrome-devtools resize_page 1440 1000
chrome-devtools evaluate_script "() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })"
chrome-devtools take_screenshot --format png --filePath "<scratch>/shot.png"   # then Read it
```

1. **No horizontal overflow** — `scrollWidth > clientWidth` must be `false`, at a wide width
   (~1440) *and* a narrow one (~620, where it collapses to one column). Sideways scroll almost
   always means a grid item that cannot shrink; see the Visual style rules.
2. **Look at the screenshot.** Both columns present, the decisions visible, no prose set in
   monospace, no text running under or past a neighbour.
3. **The copy-back actually serializes.** Read `#payload`, then flip a couple of controls and read
   it again — confirm a selection changes the text, a `Leave comment` tick adds its line, an
   untouched `Leave comment` adds nothing, and `Other:` picks up its typed value.
4. **Only then publish.** If you find a defect after publishing, fix and republish to the *same*
   path so the card's link stays valid.

## Publishing

- **Publish once, to exactly one target.** Do not publish the same report through both the
  public repo and the Anthropic Artifact tool — that produces two links and opens two browser
  tabs.
- **Picking the target: does the link leave the session?** When a ticket id was found, it does —
  Phase 5 posts the report URL to the YouTrack card so decisions can be picked up later by
  someone other than the in-session developer — so publish to the **public
  `dev-process-artifacts` repo (githack URL)**; see **`dev-process-artifacts.md` at the root of the
  bloom-team-skills clone** — do *not* resolve that as a path relative to this file. Skills are
  symlinked individually into `~/.claude/skills`, so a `../../` hop lands in the skills directory,
  not in the clone, and the file appears to be missing when it is not. Reach it via this file's
  real path (`readlink -f`), or read it from
  https://github.com/BloomBooks/bloom-team-skills/blob/main/dev-process-artifacts.md. The same
  applies whenever the link otherwise has to leave the session (handed to a teammate or another
  agent, the user asks for a public link) or the Artifact tool is unavailable. Name it
  `deciders/<sourceRepo>-<branch>.html` — the URL is stable per branch, so a re-run overwrites
  the same page and the card's report-link comment stays valid (post that stable URL to the
  card, not a commit-pinned one). Re-pushing the same path can serve the previous version for up
  to ~60s (githack cache), so on a re-run either wait or *open* the commit-pinned `rawcdn` URL
  yourself while still posting the stable one.
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
- **Two columns on wide screens:** the report (gate table, what-changed, reviewer outcomes,
  session notes) on the left and the interactive decisions on the right; collapse to one column
  when narrow.
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

**The whole run at a glance:** quality-gate table, what changed this run (each commit),
reviewer outcomes, and the decision items.

- **Quality-gate table:** typecheck, lint, merge-cleanliness, and **tests broken out one row per
  language/test-runner** — e.g. a row for the TypeScript tests (vitest/jest) and a *separate*
  row for the C# tests (`dotnet test`), plus any other stack present. Show the count and
  pass/fail per row. If a stack has no tests in this repo, still give it its own row marked
  "N/A — none in this repo" so it's clear nothing was silently skipped.
- **Reviewer-outcomes block:** one row per reviewer that ran. The **local review first**,
  labeled with the level that ran ("light sub-agent pass" / "thorough /code-review" / "skipped
  at user request") plus findings raised / fixed / escalated / dismissed, or "clean — no
  findings" — never omit this row. Then one row per remote reviewer and CI. **Every
  remote-reviewer row shows a terminal state** — "complete" (with its findings summary) or
  "timed out after N min" — per the skill's terminal-state rule; if a row would say "pending",
  the run converged too early — fix that, don't paper over it in the report.
- **Links everywhere they exist.** PR, Files-changed, Commits; each commit page; each
  reviewer's summary/review and every resolved/open thread (fetch the real comment/thread ids
  via `gh`) — for Devin, link its review page `https://devinreview.com/<owner>/<repo>/pull/<n>`;
  and **precise `file:line` deep links** into the code — build blob URLs at the HEAD sha
  (`.../blob/<sha>/<path>#L<line>`) and **verify the current line numbers first** (grep at HEAD;
  they shift after edits) so every anchor is accurate. **Every `<a>` must open in a new tab**
  (`target="_blank" rel="noopener"`).

## Decision items

Written for a reader with **zero context**. Use complete sentences and spell everything out:
what the situation is, what the user would actually see or experience, why it happens, and why
it may or may not matter. Never assume the reader remembers the code or the conversation. For
each item:

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
