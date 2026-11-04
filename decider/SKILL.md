---
name: decider
description: Present a batch of decisions to the user as an interactive HTML artifact — radio options with a recommended pick, notes boxes, "Other:" free text, and a copy-back block whose Copy and Send to Claude buttons return the answers to the session. Use whenever ≥2 non-trivial decisions need the user's judgment (instead of posing them as terminal questions or a chat list), when the user says "make a decider", "/decider", "decision form", "decision artifact", or "ask me properly", and as the shared spec other skills (e.g. preflight-style reports) reference for their decision sections.
---

# Decision form

Terminal questions push the user into snap judgments: a few words of context, options
compressed into a label, no room to think or annotate. When several decisions have piled up,
render them as **one interactive page** the user can read at leisure, answer with radio
buttons, annotate, and send back. You write only the questions, as JSON; the page is ready-made
(see "Making the page"). The page augments the chat summary; it never replaces
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
- **The concrete options**, one per real course of action. The page adds `Leave as is`,
  `Other:` and a notes box to every item itself; don't write options for those.
- **At most one recommendation**, marked on the option, with the reason in that option's own
  `why` ("Recommended because …"), not in a separate callout. The page leaves every radio empty,
  so a long form can be answered a few questions at a time. When leaving things as they are is
  the recommendation, say why in `leaveAsIsRecommended`.
- **Effort and risk on every concrete option**: a short phrase ("~10 lines, localized, low
  risk", "moderate — changes the public API", "no code — just a doc note") so benefit can be
  weighed against cost at a glance.
- **`codeComment`** for items with code to anchor to: it offers a `Leave comment` checkbox,
  which, ticked, asks for the decision to be recorded as a code comment near that code.
- FYI items that could plausibly trigger action get the same treatment; purely informational
  notes belong in the shared context or in chat.
- End the form with a **"next step" question** (e.g. "implement my recommendations now" vs
  "discuss first").

**Only open questions belong in a form.** A decision the user already made — on an earlier form,
or in conversation — is settled, and its record belongs where the next person will be looking: a
code comment, a reply on the thread that raised it, updated test notes. Re-listing it "for
completeness" makes the form longer and the real questions harder to find. Likewise, keep the
standing background that several items share in a single context block at the top, rather than
repeating it inside each one.

## Making the page

Don't write the page. `form.html` in this folder already is the page: the palette, the layout,
the radios with `Leave as is` and `Other:`, the notes boxes, the unanswered count, Copy answers
with its fallbacks, and Send to Claude by either route below. You write the questions as JSON,
and `build-form.mjs` or `claude-decider.mjs` puts them into it. Change `form.html` itself only
to change every form.

### The form's JSON

```json
{
  "about": "the projects, repos and branches the form is about, in one line",
  "url": "where the form is published, if anywhere (an Artifact or Pages URL)",
  "context": ["<p>-level HTML: background that several questions share"],
  "questions": [
    {
      "title": "Should the bot use the web?",
      "context": ["<p>-level HTML: the situation, what the user would see, why it matters"],
      "options": [
        {
          "label": "Allow search, and fetch only from listed sites",
          "recommended": true,
          "why": "Recommended because it covers docs while closing the way out for card text.",
          "effort": "~10 lines in bot-runtime.mjs, low risk",
          "instruction": "In D:\\bloom-team-skills\\bloom-bot\\bot-runtime.mjs, stop disallowing WebSearch ..."
        }
      ],
      "leaveAsIs": "the bot has no web access.",
      "codeComment": true
    }
  ]
}
```

- `context` paragraphs are HTML (`<code>`, `<a>`, `<b>`); every other field is plain text.
- `instruction` is what the answers carry instead of the label, so it must stand alone for an
  agent that has never seen this conversation: name the repo, branch and files, and the action.
  Not "Move to its own small branch", but "In D:\repo (branch X), move the uncommitted 4-line
  SAMPLE_TARGET fix in packages/sync-tool/src/import-sample.mjs to its own small branch off
  develop and open a PR."
- `leaveAsIs` restates the situation in one line; the answers say "Leave as is — take no action
  on: <leaveAsIs>".
- When `Leave as is` is the recommendation, set `leaveAsIsRecommended` to the paragraph that
  says why, and mark no option `recommended`.
- `codeComment: true` adds the `Leave comment` checkbox, for items that have code to anchor to.
- `date` defaults to the day the page is built.
- The last question is the next step, written like any other.

The answers start with "Decisions from a decider form" and the about, date and url lines. Each
question follows with its chosen instruction, or `Other: <notes>`, or "No decision yet — ask again
later about: <title>"; notes follow as `Notes: <text>`.

### Where it goes

**Who needs to read it** decides (see `../dev-process-artifacts.md`):

- **Only the developer in this session (the usual case):** serve it on this machine. In the
  background, from the session's worktree, start
  `node <this folder>/claude-decider.mjs --name <form-name> <form.json>`. It opens the page,
  prints the answers when the user presses Send to Claude, and exits, so the session wakes as soon
  as they do. The bar across the top shows the worktree's branch; pass
  `--topic "<a few words>"` when the form is about something else. The page posts its answers as
  plain text to `window.DECIDER_ENDPOINT`, which the server sets.
- **A subscriber-only link the developer can open anywhere:** run
  `node <this folder>/build-form.mjs <form.json> <page.html>` and publish the page with the
  Artifact tool, with `capabilities: {"comments": {}}` so that Send to Claude posts a comment that
  reaches this session. Publish once, put the `claude.ai/artifact/…` URL in the JSON's `url`,
  rebuild, and publish again to the same path. Never use `location.href` for it: inside an
  Artifact that is a sandbox address no agent can open.
- **A link that leaves this session** (a YouTrack card, a PR, a teammate or another agent):
  build the page the same way and publish it to the public **`dev-process-artifacts`** repo,
  whose GitHub Pages URL you choose, so put it in `url` before building. Check that the URL
  returns 200 before posting it. There, Send to Claude hides itself and Copy answers is the way
  back.

## Publishing & chat etiquette

- After publishing an Anthropic Artifact, confirm with `ArtifactComments` `watch` that it lists
  the page as connected with auto-replies armed; without that, Send to Claude posts a comment
  that never wakes this session.
- After publishing, **open the page in the user's default browser** (Windows:
  `Start-Process '<url>'`; macOS: `open <url>`; Linux: `xdg-open <url>`). A served form opens
  itself.
- In the chat summary, print the artifact URL as a **bare plain-text URL, never a markdown
  link** — terminals render `[label](url)` with the URL hidden and uncopyable.
- A `dev-process-artifacts` Pages URL is public and first-party, live ~1 min after the push; the
  githack URL (same path) is live instantly but is a third-party proxy that has served 403s for
  hours at a stretch. Check the one you post returns 200. An Anthropic Artifact is private with no
  public toggle; the user can share it from its share menu, but only to fellow subscribers.

## Processing the answers

On a served form, `claude-decider.mjs` prints the answers between `=== DECIDER ANSWERS ===`
lines and exits, and the background task's notification wakes this session; read its output.

On an Artifact, a Send to Claude press posts the block as a comment, the platform posts an automatic reply in
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
