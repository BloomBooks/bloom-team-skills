---
name: decider
description: Present a batch of decisions to the user as an interactive HTML artifact — radio options with a recommended pick, notes boxes, "Other:" free text, and a copy-back block that pastes the answers straight back into the session. Use whenever ≥2 non-trivial decisions need the user's judgment (instead of posing them as terminal questions or a chat list), when the user says "make a decider", "/decider", "decision form", "decision artifact", or "ask me properly", and as the shared spec other skills (e.g. preflight-style reports) reference for their decision sections.
---

# Decision form

Terminal questions push the user into snap judgments: a few words of context, options
compressed into a label, no room to think or annotate. When several decisions have piled up,
render them as **one interactive artifact** the user can read at leisure, answer with radio
buttons, annotate, and paste back. The artifact augments the chat summary; it never replaces
it — but keep the chat side short and point at the form.

## When to reach for this

- Two or more decisions that each genuinely change what you do next.
- Any decision where the user must weigh trade-offs they haven't seen (cost, risk, blast
  radius) — even a single one, if it's consequential.
- NOT for simple either/ors you could resolve with a sensible default — those don't need the
  user at all. Never pad a form with filler questions to justify it.

## Writing the decision items

Write for a reader with **zero context** — complete sentences, nothing assumed remembered
from the conversation or the code. For each item:

- **Context paragraph(s) first:** what the situation is, what the user would actually see or
  experience, why it happens, and why it may or may not matter.
- **Options as a radio group** (checkboxes only when genuinely non-exclusive), the
  recommended option pre-selected and visibly tagged (e.g. "Recommended").
- **Effort/risk footnote on every concrete option** — a short parenthetical ("~10 lines,
  localized, low risk", "moderate — changes the public API", "no code — just a doc note") so
  benefit can be weighed against cost at a glance.
- **Rationale lives inside the recommended option's own text** ("…, recommended because …").
  No separate "why I recommend" callout above the choices.
- **Standard option order, identical on every item:** the concrete option(s) first; then —
  always second-to-last — an option labeled **exactly `Leave as is`** (this exact wording,
  never a variant; it carries NO footnote and no editorializing), even when it is the
  recommendation (then it's the pre-selected one and the rationale moves into the context
  paragraph); then — always last — **`Other:`** with an inline text box.
- **For code-related items, a `Leave comment` checkbox on the far right of the `Leave as is`
  row** — ticked means the user wants the decision durably recorded as a code comment near
  the relevant code. Omit the checkbox on items with no code to anchor to.
- **Every item also gets a separate notes text box**, so the user can pick an option *and
  still* add caveats or constraints.
- FYI items that could plausibly trigger action get the same controls; purely informational
  notes may stay prose.
- End the form with a **"next step" question** (e.g. "implement my recommendations now" vs
  "discuss first") — same `Leave as is` / `Other:` / notes conventions.

## Building the artifact

Load the `artifact-design` skill first, then write the page to a file. **Where you publish it
depends on who needs to read it** (see `../dev-process-artifacts.md`):
- If the link will leave this session — posted to a YouTrack card, a PR, or handed to a
  teammate/another agent — publish the HTML file to the public **`dev-process-artifacts`**
  GitHub Pages repo so anyone can open it. The Anthropic Artifact tool produces
  **subscriber-only** links, useless to a teammate without a Claude subscription.
- If only the in-session developer needs it and a subscriber-only link is fine, the Artifact
  tool is simpler — publish with it.

- **Clean, light style — no dark mode.** Warm off-white ground, white bordered cards (no
  heavy shadows), one restrained accent, system serif headings + system sans body (never link
  webfonts — the artifact CSP blocks them). Follow the project's design system if one exists.
- **Two columns on wide screens** when there is meaningful report/context material: context
  and status on the left, the interactive decisions on the right; one column when narrow or
  when the form is all there is.
- **Plain headings** — no decorative eyebrows, kickers, or numbered section labels.
- **No instructional preamble** about how the controls work; the questions and buttons speak
  for themselves.
- Give every control — each radio, each `Leave comment` checkbox, each `Other:` input, each
  notes box — a `data-q` attribute so the whole form serializes mechanically.

## Copy-back block

**One copy-back button** that serializes every selection, every `Other:` text, and every
non-empty note into a clean plaintext block the user pastes straight back into the session.

**The block must stand alone in a brand-new session.** The user may paste it to a fresh agent
with zero conversation history, days later — a few label words that only made sense inside
the report ("Own small branch", "Enable on both") would be useless there. Therefore:

- **Serialize full instructions, not labels.** Give every radio option a
  `data-instruction` attribute holding a complete, self-contained imperative sentence —
  naming the repo, branch, file paths, and the concrete action — and emit *that* instead of
  the visible label. Example: not "Move to its own small branch", but "In
  D:\repo (branch X), move the uncommitted 4-line SAMPLE_TARGET fix in
  packages/sync-tool/src/import-sample.mjs to its own small branch off develop and open a
  PR." `Leave as is` serializes as "Leave as is — take no action on: <one-line restatement
  of the situation>."
- **Header block** at the top: what this is ("Decisions from a decider form"), the
  project/repos and branches concerned, the date, and **the artifact's URL** so a
  zero-context agent can read the full report if anything is still unclear.
- Per question: the full question title, then the chosen instruction, `Other: <text>` when
  chosen, `Notes: <text>` when non-empty.
- **`Leave comment` is serialized only when ticked** (a line spelling out what to do: record
  the decision as a code comment near the named code); when unticked the copy-back text must
  not mention comments at all for that item.
- Copy via `navigator.clipboard.writeText` **with a fallback**: also write the block into a
  visible readonly `<textarea>` and `select()` it, so a blocked async clipboard still leaves
  the user one Ctrl+C away. Show a "copied" confirmation on success.
- The URL must appear in the block. On the public `dev-process-artifacts` repo the Pages URL
  is **deterministic** (you choose the path), so bake it in before pushing — no round-trip
  needed. With the Anthropic Artifact tool, publish first, then patch the URL into the file and
  republish to the same path (same URL both times), or inject it via `location.href` at runtime.

## Publishing & chat etiquette

- After publishing, **open the artifact in the user's default browser** (Windows:
  `Start-Process '<url>'`; macOS: `open <url>`; Linux: `xdg-open <url>`).
- In the chat summary, print the artifact URL as a **bare plain-text URL, never a markdown
  link** — terminals render `[label](url)` with the URL hidden and uncopyable.
- A `dev-process-artifacts` Pages URL is public — anyone can open it (a just-pushed file may
  404 for ~1 min while Pages rebuilds). An Anthropic Artifact is private with no public toggle;
  the user can share it from the artifact's own share menu, but only to fellow subscribers.

## Processing the answers

When the user pastes the copy-back block (or answers informally), that answer carries the
same authorization as the request that produced the form — execute the chosen options without
re-asking. `Leave comment` ticked → also add the code comment near the relevant code, in the
repo's normal commit flow. `Other:` text and notes are instructions — follow them; where they
amount to a chosen fix, treat them as one. If an answer contradicts something discovered
since the form was built, surface the contradiction instead of silently proceeding.
