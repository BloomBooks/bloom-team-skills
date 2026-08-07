---
name: youtrack-api
description: How to talk to the Bloom YouTrack tracker over REST — authentication, base URL, and common operations (read an issue, find an issue id, list/post comments, set an issue's State, assign an issue, attachments). Bloom's implementation of the "tracker skill" that preflight and pr-ready-for-human ask for, and the shared low-level building block the other youtrack-* skills rely on.
---

# Using the Bloom YouTrack REST API

This is the **shared, low-level** skill for interacting with the Bloom YouTrack tracker
(`https://issues.bloomlibrary.org/youtrack`). Use it whenever a task needs to authenticate to
YouTrack or perform a basic operation (read an issue, comment, look something up).

It is referenced by the higher-level YouTrack skills — use those for their specific jobs:

- **`youtrack-fix`** — fix an existing issue (`BL-xxxxx`): branch, plan, commit.
- **`youtrack-create-issue`** — create a new issue/bug/card.
- **`bloom-youtrack-reporting`** — query/report across issues.

If you only need to *read* one issue, the REST calls below are all you need.

## This skill is Bloom's "tracker skill"

`preflight` (and `add-test-ideas`, which it calls) never name a tracker: they use whichever tracker
skill the project's `AGENTS.md`/`CLAUDE.md` declares, and ask it for four operations. This skill is
that implementation for Bloom repos — the mapping is:

| The operation preflight asks for | Here |
| --- | --- |
| Is the tracker reachable? | the `users/me` check in §1 — a 200 with the Bot's login |
| Read this branch's ticket id | §3 "Find the issue id" — a `BL-XXXXX` prefix on the branch name |
| List a card's comments | §3 "List an issue's comments" |
| Post or update a comment | §3 "Post a comment" |
| Move a card to "ready for peer review" (`pr-ready-for-human` only) | §3 "Set an issue's State" — for Bloom that state is **`Ready For Code Review`** |

Auth is this skill's business alone; callers must not reason about tokens. A team adopting
`preflight` for a different tracker writes their own skill covering those four operations, however
their tracker authenticates, and declares it in their repo's `AGENTS.md`.

## 1. Authentication — `$YOUTRACK_BOT` for everything except one field (never hard-code a token in a committed file)

**Every** call, read or write, authenticates as the shared **Bloom "Bot"** account, using its
YouTrack **permanent token** (`perm-…`) from `$YOUTRACK_BOT`:

```
-H "Authorization: Bearer $YOUTRACK_BOT"
```

Check it's there with `echo "${YOUTRACK_BOT:+set}"`. To get the token: ask the repo owner (it's
distributed out-of-band, like every secret here — never committed).

**Never authenticate as a human** — with the single exception in the next paragraph. Ignore any
personal YouTrack token (`$YOUTRACK`) you find in the environment or in older docs — do not use it
for reads, and not for writes, where it would make an automated change look like it came from the
human at the keyboard, which is exactly what the Bot account exists to avoid. If `$YOUTRACK_BOT` is
unset, do **not** fall back to it; see §4.

### The one exception: setting the Assignee

The Bot lacks permission to read user profiles, so it **cannot set the `Assignee` field** — it
rejects every login with `"Assignee expected: …"` — and it cannot look logins up either.

**So for the Assignee field only, use the personal token `$YOUTRACK`.** Everything else on the same
card — creation, Type, board/sprint, State, comments, attachments — still goes through
`$YOUTRACK_BOT`, as does the attribution rule below.

The trade-off, accepted deliberately: the assignment shows in card history as the human, not the
Bot. It does **not** widen to any other field.

See §3 "Set an issue's Assignee" for the call.

### Attribution — every comment/issue the Bot posts must say who really wrote it

Because the author YouTrack shows is now just *Bot*, the **text** you post is the only provenance
a reader gets. Start the body of every comment, and every issue description you create, with a
bracketed tag:

- Driven by a skill: `[<model name> from <developer-name>'s machine during <skill-name>]`
  — e.g. `[Claude Opus 4.8 from Hatton's machine during preflight]`
- Ad-hoc (no skill running): `[<model name> following a prompt from <developer-name>]`
  — e.g. `[Claude Opus 4.8 following a prompt from Hatton]`

Get `<developer-name>` from `git config user.name`. This is the YouTrack-specific form of the
team-wide attribution rule in `TEAM-AGENTS.md`.

Validate the token before doing real work:
```bash
# should report the BOT's login:
curl -s -H "Authorization: Bearer $YOUTRACK_BOT" \
  "https://issues.bloomlibrary.org/youtrack/api/users/me?fields=login,name"
```
A 200 with the Bot's login confirms the token works.

## 2. Conventions

- **Base URL:** `https://issues.bloomlibrary.org/youtrack/api`
- **Headers:** every call sends `Accept: application/json` and
  `Authorization: Bearer $YOUTRACK_BOT` (see §1). POSTs also send
  `Content-Type: application/json`.
- **Fields:** YouTrack returns nothing unless you ask — always pass a `fields=` query param
  listing what you want (e.g. `fields=idReadable,summary,description`).
- **Web URL is a SPA:** `https://issues.bloomlibrary.org/youtrack/issue/BL-xxxxx` is a
  JavaScript app and returns blank to an anonymous WebFetch. Always use the REST API for data.

## 3. Common operations

### Read an issue
```bash
curl -s -H "Authorization: Bearer $YOUTRACK_BOT" -H "Accept: application/json" \
  "https://issues.bloomlibrary.org/youtrack/api/issues/BL-16467?fields=idReadable,summary,description,customFields(name,value(name))"
```

### Find the issue id for the current work
Read a `BL-XXXXX` id off the **branch name** (`git rev-parse --abbrev-ref HEAD`). That's the whole
check: our branches carry the id, so no id in the branch name means no card for this branch. (The
naming rule this depends on — `<TICKET-ID>-<1–3 words>`, and create the card *before* the branch —
is in `TEAM-AGENTS.md` under "Branch and worktree names start with the ticket id".)

The PR title and recent commit messages (`git log --oneline -20`) are fallbacks for when a **human
asks you to track down** which card some work belongs to. An automated caller like `preflight` must
not escalate to them on its own — one look at the branch name, then report "no ticket id" and move
on.

### List an issue's comments
```bash
curl -s -H "Authorization: Bearer $YOUTRACK_BOT" \
  "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>/comments?fields=text"
```

### Post a comment
Start the text with the attribution tag from §1:
```bash
curl -s -X POST "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>/comments" \
  -H "Authorization: Bearer $YOUTRACK_BOT" \
  -H "Content-Type: application/json" \
  -d '{"text": "[Claude Opus 4.8 from Hatton'\''s machine during preflight] your comment text"}'
```
Before posting, list existing comments and check you are not creating a duplicate (e.g. when
posting a PR link, `grep -i "github.com.*pull"` the existing comment text first). For bodies
with embedded quotes/code, write the JSON to a file and use `curl -d @file.json`.

### Set an issue's State

The value name must match exactly, including capitalization:

```bash
curl -s -X POST "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>?fields=customFields(name,value(name))" \
  -H "Authorization: Bearer $YOUTRACK_BOT" -H "Content-Type: application/json" \
  -d '{"customFields":[{"name":"State","$type":"StateIssueCustomField","value":{"name":"Ready For Code Review"}}]}'
```

The response echoes the new State — read it back rather than assuming the write took. Bloom's
workflow order runs roughly `Ready For Work` → `Ready For Code Review` → `Ready For Testing` →
`Closed`, so a card already at or past the state you're setting should be left alone (callers
treat moving a card backwards as a bug).

### Set an issue's Assignee

**The one call that uses `$YOUTRACK` (the personal token), not `$YOUTRACK_BOT`** — see §1.

Pass the **login**, not the display name. Logins are not derivable from a person's name or email
(an `a_b@…` address can pair with an `a-b` login), so look it up first — `users/me` for yourself,
`users` for anyone else (only the personal token can see other users):

```bash
curl -s -H "Authorization: Bearer $YOUTRACK" \
  "https://issues.bloomlibrary.org/youtrack/api/users?fields=id,login,name,email&\$top=500"
```

Then set it:

```bash
curl -s -X POST "https://issues.bloomlibrary.org/youtrack/api/commands" \
  -H "Authorization: Bearer $YOUTRACK" -H "Content-Type: application/json" \
  -d '{"query":"Assignee <login>","issues":[{"idReadable":"<issue-id>"}]}'
```

Success returns `{}`, so read the field back — with `$YOUTRACK`, since the Bot sees other users
anonymized and cannot tell you who it landed on:

```bash
curl -s -H "Authorization: Bearer $YOUTRACK" \
  "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>?fields=customFields(name,value(name,login))"
```

If `$YOUTRACK` is unset, say so and leave the card unassigned — `$YOUTRACK_BOT` cannot succeed (§1).

### List an issue's attachments
```bash
curl -s -H "Authorization: Bearer $YOUTRACK_BOT" \
  "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>/attachments?fields=name,url,size"
```

### Add an attachment
```bash
curl -s -X POST "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>/attachments?fields=id,name,size" \
  -H "Authorization: Bearer $YOUTRACK_BOT" \
  -F "file=@screenshot.png;type=image/png"
```
Several `-F file=@…` fields in one call work, but the response only echoes one of them — confirm
what actually landed by listing the attachments afterwards, not by reading the POST response.

### Uploading an image or video is only half the job — INLINE it

**An attachment nobody can see in context might as well not be there.** Whenever you add a
screenshot or a video to an issue, also embed it at the point in the **description or comment**
where it is being discussed, so a reader meets the picture where the words explain it instead of
having to hunt through the attachments list. Markdown, referencing the attachment by its file
name:

```markdown
![The title page during the flash: every block is outlined in red](red-state-title-page.png)
```

Give the alt text real content — describe what the reader is meant to notice, not "screenshot".
For a video, embed it the same way if the format renders inline; otherwise name the file in the
prose and say what it shows.

**GIFs are the exception: attach, but do not embed.** An embedded GIF loops forever next to text
someone is trying to read. Reference it by name, note that it's attached, and say what speed it
plays at — e.g. slowed to half speed with the real timing stated, since a bug that flashes past
in 300 ms is unwatchable at true speed.

When you update a description to add media, fetch the current `description`, edit it, and POST it
back whole (`-d @file.json`) — there is no partial-update; anchor your replacement on unique
existing text and assert the anchor was found before writing, so a failed match can't silently
blank a section.

## 4. If `$YOUTRACK_BOT` looks unset

On Windows, first check the User scope
(`[Environment]::GetEnvironmentVariable('YOUTRACK_BOT','User')`); an empty shell variable is
usually a stale inherited env block, not a missing token.

If the User scope *is* empty too, you have no YouTrack access — and you must **not** substitute
some other token, including `$YOUTRACK` (whose only sanctioned use is the Assignee field, §1).
Tell the user plainly: "I need the Bloom Bot token (`$YOUTRACK_BOT`) to reach YouTrack." For a
low-stakes write (a PR-link comment) note that it's skipped and continue with the rest of the task;
otherwise let the user set the token or do the YouTrack step manually.
