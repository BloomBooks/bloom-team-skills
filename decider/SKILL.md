---
name: decider
description: Present a batch of decisions to the user as an interactive HTML artifact — radio options with a recommended pick, notes boxes, "Other:" free text, and a copy-back block whose Copy and Send to Claude buttons return the answers to the session. Use whenever ≥2 non-trivial decisions need the user's judgment (instead of posing them as terminal questions or a chat list), when the user says "make a decider", "/decider", "decision form", "decision artifact", or "ask me properly", and as the shared spec other skills (e.g. preflight-style reports) reference for their decision sections.
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
  recommended option tagged "Recommended" and on the `--accent-tint` ground, but **not
  selected**: every radio starts empty, so a question the user has not got to yet stays
  undecided, and choosing the recommendation takes a click like any other choice. A long form
  can then be answered a few questions at a time.
- **Effort/risk footnote on every concrete option** — a short parenthetical ("~10 lines,
  localized, low risk", "moderate — changes the public API", "no code — just a doc note") so
  benefit can be weighed against cost at a glance.
- **Rationale lives inside the recommended option's own text** ("…, recommended because …").
  No separate "why I recommend" callout above the choices.
- **Standard option order, identical on every item:** the concrete option(s) first; then —
  always second-to-last — an option labeled **exactly `Leave as is`** (this exact wording,
  never a variant; it carries NO footnote and no editorializing), even when it is the
  recommendation (then it carries the Recommended tag and the rationale moves into the context
  paragraph); then — always last, on the same row as `Leave as is` — a radio labeled
  **`Other:`** with no text box of its own. Choosing it puts the cursor in the item's notes box
  and changes that box's placeholder to "What should happen instead?"; what the user writes
  there is the Other answer.
- **For code-related items, a `Leave comment` checkbox on the far right of the `Leave as is`
  row** — ticked means the user wants the decision durably recorded as a code comment near
  the relevant code. Omit the checkbox on items with no code to anchor to.
- **Every item also gets a separate notes text box**, so the user can pick an option *and
  still* add caveats or constraints, or describe their `Other:` answer.
- FYI items that could plausibly trigger action get the same controls; purely informational
  notes may stay prose.
- End the form with a **"next step" question** (e.g. "implement my recommendations now" vs
  "discuss first") — same `Leave as is` / `Other:` / notes conventions.

**Only open questions belong in a form.** A decision the user already made — on an earlier form,
or in conversation — is settled, and its record belongs where the next person will be looking: a
code comment, a reply on the thread that raised it, updated test notes. Re-listing it "for
completeness" makes the form longer and the real questions harder to find. Likewise, keep the
standing background that several items share in a single context block at the top, rather than
repeating it inside each one.

## Building the artifact

Load the `artifact-design` skill first, then write the page to a file. **Where you publish it
depends on who needs to read it** (see `../dev-process-artifacts.md`):
- If the link will leave this session — posted to a YouTrack card, a PR, or handed to a
  teammate/another agent — publish the HTML file to the public **`dev-process-artifacts`**
  repo and use its **GitHub Pages** URL (githack when you need the link live instantly) so
  anyone can open it — and verify it returns 200 before posting it. The
  Anthropic Artifact tool produces **subscriber-only** links, useless to a teammate without a
  Claude subscription.
- If only the in-session developer needs it and a subscriber-only link is fine, the Artifact
  tool is simpler — publish with it, with `capabilities: {"comments": {}}` so the Send to Claude
  button works (see Copy-back block). Declaring `comments` makes the page ask the user once for
  permission to comment.
- Or serve it on this machine: start `node <this folder>/claude-decider.mjs --name <form-name>
  <page.html>` in the background from the session's worktree. It opens the page, prints the
  answers when the user sends them, and exits, so the session wakes as soon as they do. Its bar
  shows the worktree's branch (e.g. `BL-16822-Inline-Fixes`) to say what the session is working
  on; pass `--topic "<a few words>"` for a form that is about something else.

- **Start with the first question.** No page title, no introduction, nothing about what the
  form is: the served bar names the work, and the questions explain themselves. The one thing
  that may come before the first question is the context block that several items share.

- **Clean, light style — no dark mode.** Warm off-white ground, white bordered cards (no
  heavy shadows), system serif headings + system sans body (never link webfonts — the artifact
  CSP blocks them). Follow the project's design system if one exists; otherwise use the
  decider's palette, which matches its icon and the bar the server puts above a served form:

  ```css
  :root {
    --ground: #FAF9F5;        /* page */
    --card: #FFFFFF;          /* cards */
    --line: #E8E4DA;          /* card borders, dividers */
    --ink: #2F2F2F;           /* text */
    --muted: #6B6760;         /* secondary text, option detail */
    --accent: #D97757;        /* Claude orange: borders, focus rings, marks; never text */
    --accent-strong: #B4532F; /* orange text, links, and filled buttons with white text */
    --accent-tint: #FBEEE8;   /* the ground of the recommended option and of its tag */
  }
  ```

  The orange is the one accent; green, blue and other hues have no place, a "Recommended"
  badge included. `--accent` is too light for text (white on it is 3.1:1), so anything read in
  orange uses `--accent-strong`. The option the user chose gets a 1px `--accent` outline as well
  as its filled radio, so a chosen option and the recommended one stay distinct, the
  recommended one chosen included. Theme the parts the browser draws as well:
  `accent-color: var(--accent-strong)` on radios and checkboxes, `::selection` in
  `--accent-tint`, and a 2px `--accent` focus ring offset from the control.
- **Two columns on wide screens** when there is meaningful report/context material: context
  and status on the left, the interactive decisions on the right; one column when narrow or
  when the form is all there is.
- **Plain headings** — no decorative eyebrows, kickers, or numbered section labels.
- **No instructional preamble** about how the controls work; the questions and buttons speak
  for themselves.
- Give every control — each radio, `Other:` included, each `Leave comment` checkbox, each notes
  box — a `data-q` attribute so the whole form serializes mechanically.

## Copy-back block

**Placement:** the copy-back lives at the **end of the decisions column** (the bottom of the
right column on wide screens, directly after the last question): a row on the page itself, in
no card or box of its own, holding only the buttons and the status line, with a readonly
textarea beneath them that stays hidden until the user presses Copy answers. The buttons sit at the right, Copy answers and then
Send to Claude last at the far right; the status line sits at the left of the same row, so
its changing text never moves them. Give it no heading and no description: the buttons
name the action, and a "Send your answers back" title over a "Send to Claude" button says the
same thing twice. Do **not** make it a full-width sticky footer or a bar spanning under both
columns — it must read as the last segment of the same column the questions are in.

**Two buttons, Send to Claude and Copy answers**, that both serialize every selection and every
non-empty note (an `Other:` answer's text included) into the same clean plaintext block. Copy puts it on the
clipboard for the user to paste into any session; Send to Claude posts it as an artifact comment
that reaches the session that published the page.

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
- Per question: the full question title, then the chosen instruction, or `Other: <the notes
  text>` when Other is chosen; otherwise `Notes: <text>` when non-empty. Other with empty notes
  is not an answer yet: it counts as unanswered and serializes as below. A question with nothing chosen serializes as "No
  decision yet — ask again later about: <one-line restatement of the question>", and its notes
  still follow when non-empty. Both buttons work with any number of questions still undecided,
  except that Send to Claude stays disabled until at least one question has a choice, since
  there is nothing to send before then. Just above the buttons, right-aligned in `--muted`, a
  line counts the questions with no choice yet ("2 unanswered"), so it is read before the user
  sends; it updates on every change, and is empty (keeping its height, so the buttons don't
  jump) once every question has one. A note alone does not answer a question.
- **`Leave comment` is serialized only when ticked** (a line spelling out what to do: record
  the decision as a code comment near the named code); when unticked the copy-back text must
  not mention comments at all for that item.
- **Copy robustly, and report honestly.** The Artifact iframe's Permissions-Policy omits
  `clipboard-write`, so `navigator.clipboard.writeText` **rejects** ("The Clipboard API has
  been blocked because of a permissions policy") — you cannot rely on it, and you must never
  show "Copied" on a path that didn't verify a real copy. Wire the button as this ladder,
  driving the status text from what actually happened:
  1. Always fill the readonly `<textarea>`, unhide it, and `select()` it **first**, so a
     manual copy is one keystroke away no matter what follows.
  2. `try { await navigator.clipboard.writeText(text) }` → on resolve, status = "Copied ✓".
  3. On reject (the normal case in the sandbox), fall back to `document.execCommand('copy')`
     on the still-selected textarea; if it returns `true`, status = "Copied ✓".
  4. If both fail, leave the textarea selected and show a **neutral, non-success** message —
     e.g. "Couldn't copy automatically — the text is selected below; press Ctrl+C (⌘C on
     Mac)." Do not style this green or say "Copied".
  Guard the whole handler in `try/catch` so a throw can't fall through to a success message.
- **Send to Claude goes through the artifact's comments capability**, which exists only on an
  Anthropic Artifact published with `comments`. On load, `const comments = await
  window.claude?.use?.("comments")`; when that is null or undefined (a GitHub Pages copy, or a
  view without the capability), hide the button and leave Copy as the only way back. On click:
  1. Serialize the answers without filling or showing the textarea. Then, before any `await`,
     change the button to "Sending…" and the status to "Sending your answers to Claude…":
     `sendToClaude` takes several seconds, and a button that shows nothing for that long
     looks broken.
  2. A comment holds at most 4096 bytes of UTF-8 (`new TextEncoder().encode(text).length`).
     Over that, say so with the byte count, suggest shorter notes or Copy, and stop.
  3. `await comments.canSendToClaude()` returns `available`, `writers_only` (the viewer is not
     an editor), `no_session` (no session is watching) or `off`. Anything but `available` →
     say which in plain words, point at Copy, and stop. Check on every click: the answer
     changes after load.
  4. `const anchor = await comments.anchorFor(<the copy-back card element>)`, then
     `await comments.sendToClaude({anchor, text})` → status = "Sent to Claude ✓" plus one line
     saying Claude's reply will appear in the comment on this card.
  5. On a rejection, branch on `e.code`: `consent_required` (the viewer hasn't allowed the
     page to comment yet), `forbidden` (hide the button), `claude_unavailable` (nothing was
     posted), else show the code. Every one of these points at Copy, in the same neutral
     styling as the copy failure.
  Disable the button while a send is in flight, so a double click sends one comment. The full
  contract is `comments.d.ts` in the `artifact-capabilities` skill.
- The URL must appear in the block. On the public `dev-process-artifacts` repo the Pages URL
  is **deterministic** (you choose the path), so bake it in before pushing — no round-trip
  needed. With the Anthropic Artifact tool, publish first, then patch the `claude.ai/artifact/…`
  URL into the file and republish to the same path (same URL both times). `location.href`
  inside an Artifact is the sandbox frame's `frame.claudeusercontent.com` address, which no
  agent can open, so never use it for this line.

## Publishing & chat etiquette

- After publishing an Anthropic Artifact, confirm with `ArtifactComments` `watch` that it lists
  the page as connected with auto-replies armed; without that, Send to Claude posts a comment
  that never wakes this session.
- After publishing, **open the artifact in the user's default browser** (Windows:
  `Start-Process '<url>'`; macOS: `open <url>`; Linux: `xdg-open <url>`).
- In the chat summary, print the artifact URL as a **bare plain-text URL, never a markdown
  link** — terminals render `[label](url)` with the URL hidden and uncopyable.
- A `dev-process-artifacts` Pages URL is public and first-party, live ~1 min after the push; the
  githack URL (same path) is live instantly but is a third-party proxy that has served 403s for
  hours at a stretch. Check the one you post returns 200. An Anthropic Artifact is private with no
  public toggle; the user can share it from its share menu, but only to fellow subscribers.

## Processing the answers

A Send to Claude press posts the block as a comment, the platform posts an automatic reply in
that thread (it answers but changes nothing), and this session gets a notification naming the
thread. Read the thread with `ArtifactComments` and treat the user's comment as the pasted
block. Act on it, then `resolve` the thread without posting another reply. End your turn after
publishing the form, so the session is idle when the notification comes.

When the user pastes the copy-back block, sends it, or answers informally, that answer carries the
same authorization as the request that produced the form — execute the chosen options without
re-asking. `Leave comment` ticked → also add the code comment near the relevant code, in the
repo's normal commit flow. `Other:` text and notes are instructions — follow them; where they
amount to a chosen fix, treat them as one. If an answer contradicts something discovered
since the form was built, surface the contradiction instead of silently proceeding.
