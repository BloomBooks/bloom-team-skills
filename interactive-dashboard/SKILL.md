---
name: interactive-dashboard
description: Build and run a live steering board for a long, multi-agent operation — one page the developer keeps open that shows every work item's state, lets them reorder priority by dragging, pause items, answer the workers' questions with a click, and send free-text notes, with every answer flowing back to the controlling agent. Use when an agent is about to supervise several workers for more than half an hour ("make me a dashboard", "keep me posted while this runs", "I want to answer questions as they come up"), or when a skill such as improve-test-automation-coverage needs a human in the loop without a terminal.
---

# Interactive dashboard

A controller agent that runs a fleet of workers needs two things from the developer: attention
at the right moments, and answers. A terminal gives neither: the developer is elsewhere, the
questions scroll past, and `AskUserQuestion` blocks the whole operation. This skill builds the
alternative: a private web page (an Artifact with the `db` capability) that the developer keeps
open, and a polling loop in the controller that turns what they do on the page into actions.

The page is the developer's side of a protocol. The controller writes state and questions into
the page's database; the developer's clicks land in the same database; the controller reads them
back and acts. Database writes alone never wake a session, so the page also posts a comment "sent
to Claude" on every Send: that reaches an idle controller as a notification within about a minute.
A slow poll remains as the fallback for answers that arrive while the controller is busy.

What the developer gets, from one link:

- every work item with its state, current phase, last update, an expandable log, and links;
- a **Needs you** section of open questions, each with radio options (one marked recommended), a
  free-text box, and a Send button; answered questions move to an **Answered** list that says
  whether the controller has picked the answer up yet;
- **drag a row to reorder** the queue (the controller reads the order when it starts work);
- **Pause / Resume** per item (the controller stops a running worker at its next checkpoint, or
  refuses to start a queued one);
- a **free-text note box** for anything the controller did not ask.

## Files beside this skill

- `dashboard-template.html` — the page, with `{{TITLE}}`, `{{SUBTITLE}}`, `{{ITEMS_HEADING}}`,
  `{{ITEM_COLUMN}}` and `{{RUN_LABEL}}` placeholders. Fill them with a script that does literal
  replacement (no sed: it eats backslashes); write the result to your scratchpad and publish it
  from there.

## 1. Build the page

1. Load the `artifact-design` and `artifact-capabilities` skills; both are required before the
   first publish, and `artifact-capabilities` explains `db`.
2. Fill the template's placeholders. Title is a two-to-four-word name ("UI Test Run Board"),
   subtitle one line saying what is running and which session steers it, `{{RUN_LABEL}}` the
   phrase shown on questions about the whole run rather than one item ("the whole run").
3. Publish with the Artifact tool, `capabilities: {"db": {}, "comments": {}}`, an `icon` such as
   `board`, and a one-sentence description. `comments` is the wake-up channel (§3); declaring it
   makes the page ask the developer once for permission to comment, and rules out public sharing,
   which a private steering board never needs. Open the link for the developer and print it as a
   bare URL.
4. Seed the database with `ArtifactData` **before** the developer opens it: one document per work
   item, and any run-level questions you already know you need (see the data model). An empty
   board reads as broken.
5. Verify once: `ArtifactData list` on `questions` with `as_level: interact` returns the seeded
   rows. Then stop polishing; the live page is the review surface.

Keep the page a UI, not a report: summary pills at the top, state encoded in colour and a pill,
the questions above the table because they are what the developer came for.

## 2. The data model (four collections)

All documents are shared and durable; anyone who can open the page sees them.

**`cards/<itemId>`** — one per work item. The template reads these fields:

| field | meaning |
| --- | --- |
| `summary` | the item's title in plain words; shown next to the id and on every question about it |
| `order` | integer; the queue position the developer controls by dragging |
| `state` | `queued`, `running`, `review`, `blocked`, `done`, `failed` |
| `phase` | one line: what is happening right now ("Writing the Notion card") |
| `lastUpdate` | two to five sentences a reader with no context understands |
| `updatedAt` | ISO timestamp |
| `links` | `[{label, url}]`; tracker card, Notion page, PR |
| `paused`, `pauseChangedAt`, `pauseSeenAt` | set by the page; `pauseSeenAt` is the controller's acknowledgement (see §3) |
| `outcome` | set when the item finishes: `{card: {label, url}, tests, fixes: [..], where, links: [{label, url}]}`; the page's **Results** table is built from it, so the wrap-up lives on the board, not only in chat |

Write `outcome` the moment an item is done, not at the end of the run. The developer reads the
Results table the way they would read a closing report: which test card, how many tests, which
product bugs were fixed, and where the commits or PR are.

Do not put queue positions into `phase` text; the developer reorders and the text goes stale.

**`questions/<id>`** — one per question. `cardId` (an item id, or `run`), `from` (who asks),
`text`, `options` (array of strings; the whole option text is the answer), `recommended` (one of
the options), `askedAt`, `answer` (null until the developer sends; may be an option, free text, or
`option — free text`), `answeredAt`, `relayedAt` (null until the controller has acted), `ping`
(written by the page: whether the wake-up comment went out, or why not; shown in the Answered
list so both sides can see it).

Every timestamp the controller writes comes from the clock (`date -u +%FT%TZ` in Bash), never
typed from memory: hand-typed stamps drifted an hour ahead in the first run, so questions showed
as asked after they were answered.

Write questions so a reader with zero context can answer: what happened, what it means for them,
what each option costs. **Every question about a bug offers "Fix it now" as the first, recommended
option**, before "file a card" and "leave it": the worker that found the bug has half the diagnosis
already, and the developer's usual answer is to fix it. Name the file and the likely change.

**`notes/<autoId>`** — free text from the developer: `text`, `createdAt`, `relayedAt`.

**`log/<id>`** — one per event: `ts`, `cardId`, `text`. The page shows them under the item.

## 3. Run the controller loop

The page wakes the controller through comments. When the developer presses Send, the page calls
`comments.sendToClaude` (see the template's `pingController`) before it writes the answer, and the
platform delivers that as a notification to the session that published the board, as long as the
session's watch on the artifact says "auto-replies armed" (the publish result and
`ArtifactComments` `watch` both show this). Two facts about that delivery, both observed:

- It reaches the controller only when the controller is **idle**. If the controller is mid-turn,
  the platform posts an automatic acknowledgement in the comment thread instead and the controller
  never sees a notification; it finds the answer at its next read. So keep controller turns short:
  one action, one board update, stop.
- The notification names the thread. Read the thread with `ArtifactComments`, act on the answer
  from the database as usual, then `resolve` the thread. Do not post another reply; the automatic
  one is already there.

Keep a poll as the fallback for answers that land while the controller is busy: `CronCreate` with
a period of ten to fifteen minutes and a self-contained prompt that spells out the loop. Every
worker checkpoint message is another chance to update the board. Each poll:

1. `ArtifactData query questions where relayedAt == null and answer != null`. For each: act on
   the answer (relay to the worker that asked, or do it yourself for run-level questions), then
   `update` the document with `relayedAt`. The page shows "relayed" once that lands, which is how
   the developer knows they were heard.
2. `list notes`; act on any with `relayedAt == null`; mark them.
3. `query cards where paused == true and pauseSeenAt == null`: for a running item tell its worker
   to stop at its next checkpoint and idle; for a queued one nothing; set `pauseSeenAt` either
   way. An item unpaused later (`paused false`, `pauseSeenAt null`) means resume.
4. Start work for every item that is `queued` and not paused and has no worker, lowest `order`
   first, honouring whatever load rule the developer gave (for Bloom e2e work: many workers, one
   Playwright run at a time, serialized by the e2e lock).
5. If nothing changed, say so in one line and stop.

On every worker checkpoint (setup done, evaluation done, tests green, review, blocked, done),
update the item's `state`, `phase`, `lastUpdate`, `updatedAt`, add a `log` row, and add a
`questions` row for anything the worker needs the developer for. Then tell the developer in chat
in a few sentences; the board is for detail, the chat for what changed.

### Writing safely

- Pin every write to a document you have read with `if_version`; a batch with a stale pin writes
  nothing and names the stale entry. The developer edits `cards` from the page (order, pause), so
  those versions move under you: re-read before a batch that touches them, and keep card writes
  in a separate batch from question and log writes so one stale pin does not lose the rest.
- Prefer `batch` for more than two writes; it is one approval.
- Put long `data` in a JSON file and use `file_path`; the batch entry form takes it.

### What the workers must know

Workers report to the controller, never to the developer directly, and never open a local
question prompt: nobody is watching their terminal. The brief tells them to send a message at each
checkpoint and to phrase a question with the options they see and the one they recommend, so it
can go onto the board almost verbatim. The controller answers small judgment calls itself and puts
only real forks on the board.

Quote the developer's own words in the brief for anything a worker's rules gate on the developer
asking: commits, pushes, product-code edits. A worker will not act on "the controller says John
approved"; it will act on `John said: "commit and push"`. Decide up front whether finished work is
to be pushed and say so in the brief. A live worker does its own push; the controller pushes only
when the worker's session is already gone.

Product-code changes made along the way (a bug the developer chose "Fix it now" for, a test hook)
still need the team's normal review pipeline (`preflight`). Record that on the PR when one exists,
as a comment listing the commits, and in the item's `outcome.where` on the board; for a branch with
no PR, running `preflight` is what creates it, so that is a question for the developer.

### Orca workers: terminals and follow-ups

- When a worker finishes, `worker-retain` its terminal instead of releasing it if the developer
  may still answer something about that item. A follow-up goes to the same session with
  `task-create` plus `worker-start --task <id> --terminal <handle> --worktree <selector>`; without
  `--worktree` the start is refused with `terminal_worktree_mismatch`.
- Git Bash on Windows allows 32 consoles. Past that, every new Orca terminal dies at once and a
  `worker-start` fails at `agent_readiness` with `terminal_exited` and no output, while the same
  command works in another worktree. Close the terminals of finished items (`orca terminal close`)
  before starting new workers; ten idle shells per worktree accumulate quickly.
- An instruction delivered through Orca's own messaging (the dispatch spec, or a follow-up
  dispatch) was accepted by the worker and its permission classifier in every case tried; a
  go-ahead relayed through Claude's `SendMessage` was refused as not the developer's own words.
  The classifier's verdict on an identical `git commit` still varies between sessions, so a
  refusal is not proof that the instruction path is wrong.

### Everything the developer owes goes on the board

If a chat message would say "still yours" or "waiting on you", that item is a `questions` row,
with the concrete action as its options ("Done: I pressed Escape and it closed", "Escape did not
close it"). A manual check, a Notion property to add, a commit to authorise, a run to continue or
stop: each is a question. The chat may mention them; the board is where they are answered and
where the developer sees the list is empty.

## 4. Chat etiquette

- Print the board's URL as a bare URL, never a markdown link.
- When a question goes on the board, also say so in chat with the gist and what the developer's
  answer changes. The board is where they answer; the chat is how they learn there is something
  to answer.
- The Artifact link is subscriber-only. If someone without a Claude subscription must read the
  board, this skill does not fit; use `dev-process-artifacts.md` for a public page and accept that
  it cannot take answers.

## Pitfalls met the first time

- A relayed instruction is not the developer's own instruction to a worker session. Workers
  following the team's "commit only when I ask in my own words" rule will not commit on a
  dashboard answer relayed by the controller through `SendMessage`; quote the developer's words in
  the brief or a follow-up dispatch instead (see "What the workers must know").
- A worker's auto-mode classifier refused product-code edits and `pnpm build` until the developer
  added an `autoMode.allow` sentence; output redirection on the command broke the match. The
  controller must not do the refused thing on the worker's behalf. Surface it, with the exact
  command or edit quoted, and let the developer approve in that terminal or add the allow rule.
- The page's status line under a Send button is destroyed the moment the answer saves, because the
  question re-renders into the Answered list. Anything the developer must see after Send goes into
  the question document (`ping`), not into the DOM.
- "One at a time" from the developer meant one expensive test run at a time, not one worker. Ask
  which they mean before serializing a whole queue; an idle fleet waiting on one question wasted
  an hour.
- Show the item's title on every question, not just its id; the developer cannot map ids to
  features from memory.
