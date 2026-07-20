# Preflight report artifact — design & behavior spec

Read this when building the Phase 5 report artifact. It defines the page's design, content
blocks, decision-item controls, and copy-back behavior. Load the `artifact-design` skill first,
then write the page content to a file and publish it.

## Publishing

- **Choose the publish target by audience** (see `../../dev-process-artifacts.md`): if the link
  needs to be read by anyone outside this session — posted to a YouTrack card, a PR, or handed
  to another agent (e.g. every `process-sentry-issues` escalation) — publish the HTML file to
  the public **`dev-process-artifacts`** repo and use its **githack** URL (Pages URL as durable
  fallback). The Anthropic Artifact tool produces **subscriber-only** links (private, no public
  toggle; shareable only
  to fellow subscribers), so use it only when a subscriber-only link is acceptable — then tell
  the user they can share it from the artifact's own share menu. Either way it augments, never
  replaces, the chat summary.
- **After publishing, open the report in the user's default browser** (Windows:
  `Start-Process '<url>'` from PowerShell or `start "" "<url>"`; macOS: `open <url>`; Linux:
  `xdg-open <url>`) — in addition to printing the URL in the chat summary.
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
