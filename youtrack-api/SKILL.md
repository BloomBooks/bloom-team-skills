---
name: youtrack-api
description: How to talk to the Bloom YouTrack tracker over REST — authentication, base URL, and common operations (read an issue, find an issue id, list/post comments, attachments). The shared low-level building block that the other youtrack-* skills and any PR/review workflow rely on.
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

## 1. Authentication — two tokens (never hard-code a token in a committed file)

YouTrack **permanent tokens** (they start with `perm-`) are per-user. We use **two**, and which
one you send decides who the action is attributed to:

- **`$YOUTRACK`** — *your personal* token. Use it for all **reads** (GET): reading an issue,
  listing comments, querying/reporting. Check with `echo "${YOUTRACK:+set}"`. (Some older skills
  referred to `$YOUTRACK_TOKEN`; the personal variable that is actually set is `$YOUTRACK`.)
- **`$YOUTRACK_BOT`** — the token of the shared **Bloom "Bot"** account. Use it for every
  **write/mutation**: posting a comment, creating an issue, changing State or any custom field,
  adding an attachment. This makes automated changes show up in YouTrack as authored by *Bot*
  rather than masquerading as the human at the keyboard. Check with `echo "${YOUTRACK_BOT:+set}"`.

**Writes require `$YOUTRACK_BOT`.** If it isn't set, do **not** fall back to posting under your
personal `$YOUTRACK` — posting as the human is exactly what the Bot account exists to avoid.
Tell the user the Bot token is missing so they can set it; for a low-stakes write (e.g. a PR-link
comment) skip it and note that instead. To get the token: ask the repo owner (it's distributed
out-of-band, like every secret here — never committed). A personal `$YOUTRACK` is created in
YouTrack via avatar → **Profile** → **Account Security** → **New token…**, scope **YouTrack**.

So: `-H "Authorization: Bearer $YOUTRACK"` on reads, `-H "Authorization: Bearer $YOUTRACK_BOT"`
on writes.

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

Validate your tokens before doing real work:
```bash
# reads — should report YOUR login:
curl -s -H "Authorization: Bearer $YOUTRACK" \
  "https://issues.bloomlibrary.org/youtrack/api/users/me?fields=login,name"
# writes — should report the BOT's login:
curl -s -H "Authorization: Bearer $YOUTRACK_BOT" \
  "https://issues.bloomlibrary.org/youtrack/api/users/me?fields=login,name"
```
A 200 with the expected login confirms each token works.

## 2. Conventions

- **Base URL:** `https://issues.bloomlibrary.org/youtrack/api`
- **Headers:** every call sends `Accept: application/json` and an `Authorization: Bearer …`
  header — `$YOUTRACK` for reads, `$YOUTRACK_BOT` for writes (see §1). POSTs also send
  `Content-Type: application/json`.
- **Fields:** YouTrack returns nothing unless you ask — always pass a `fields=` query param
  listing what you want (e.g. `fields=idReadable,summary,description`).
- **Web URL is a SPA:** `https://issues.bloomlibrary.org/youtrack/issue/BL-xxxxx` is a
  JavaScript app and returns blank to an anonymous WebFetch. Always use the REST API for data.

## 3. Common operations

### Read an issue
```bash
curl -s -H "Authorization: Bearer $YOUTRACK" -H "Accept: application/json" \
  "https://issues.bloomlibrary.org/youtrack/api/issues/BL-16467?fields=idReadable,summary,description,customFields(name,value(name))"
```

### Find the issue id for the current work
Look for a `BL-XXXXX` token, in this order:
1. the branch name (`git rev-parse --abbrev-ref HEAD`),
2. the PR title,
3. recent commit messages (`git log --oneline -20`).

### List an issue's comments
```bash
curl -s -H "Authorization: Bearer $YOUTRACK" \
  "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>/comments?fields=text"
```

### Post a comment
A write — authenticate as the **Bot** (`$YOUTRACK_BOT`) and start the text with the attribution
tag from §1:
```bash
curl -s -X POST "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>/comments" \
  -H "Authorization: Bearer $YOUTRACK_BOT" \
  -H "Content-Type: application/json" \
  -d '{"text": "[Claude Opus 4.8 from Hatton'\''s machine during preflight] your comment text"}'
```
Before posting, list existing comments and check you are not creating a duplicate (e.g. when
posting a PR link, `grep -i "github.com.*pull"` the existing comment text first). For bodies
with embedded quotes/code, write the JSON to a file and use `curl -d @file.json`.

### List an issue's attachments
```bash
curl -s -H "Authorization: Bearer $YOUTRACK" \
  "https://issues.bloomlibrary.org/youtrack/api/issues/<issue-id>/attachments?fields=name,url,size"
```

## 4. If a token is unavailable

Tell the user plainly which one is missing:

- **`$YOUTRACK` (personal) missing** → you cannot read; say so and stop the read.
- **`$YOUTRACK_BOT` missing** → you cannot write *as the Bot*. Do **not** post under `$YOUTRACK`
  instead. For a low-stakes write (a PR-link comment) note that it's skipped and continue;
  otherwise say "I need the Bloom Bot token (`$YOUTRACK_BOT`) to post this" and let the user set
  it or do the step manually.

## 5. Alternative: the YouTrack MCP server

For tools that speak MCP, YouTrack also exposes an MCP endpoint that can be configured
instead of raw REST (e.g. in VS Code's `AppData\Roaming\Code\User\mcp.json`):

```json
"youtrack": {
    "url": "https://silbloom.youtrack.cloud/mcp",
    "type": "http",
    "headers": {
        "Authorization": "Bearer your-token-from-youtrack"
    }
}
```

The REST calls above remain the reliable baseline; this is optional convenience.
