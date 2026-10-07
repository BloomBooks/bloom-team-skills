---
name: reviewable-replies
description: Reply to Reviewable.io PR review discussions, or start new ones, via the official `reviewable` CLI (REST API) — per-thread replies, new file/line comments, correct handling of GitHub-mirrored vs Reviewable-native threads, and publishing. Use whenever review comments on a Reviewable-managed PR need responses, or a comment needs to go on a file or line in Reviewable.
argument-hint: "PR (e.g. BloomBooks/BloomDesktop#7557) and which discussions to answer; or enough context to find them"
---

# Reviewable Replies

Reply to per-line review discussions on Reviewable.io using the **`reviewable` CLI**, which
talks to Reviewable's REST API. Do **not** use browser automation for this (an older skill
did; it was unreliable and has been retired), and do not collapse everything into one big
GitHub PR comment — reviewers expect one reply *in each thread*.

## Setup / authentication

The CLI needs two environment variables:

- `REVIEWABLE_API_TOKEN` — an API token (`rvbl_...`), created from your Reviewable account
  settings. Never print it, and never commit it anywhere.
- `REVIEWABLE_URL` — `https://reviewable.io`

**Windows gotcha:** these are typically set at the **User** environment scope. A shell tool
session usually inherits them (check without printing the secret:
`[ -n "$REVIEWABLE_API_TOKEN" ] && echo set` in Bash), but a session started before the vars
were set won't see them. If they're missing, PowerShell can read them from the User scope
without displaying the secret — and since shell state doesn't persist between tool calls,
re-set both vars in every PowerShell call:

```powershell
$env:REVIEWABLE_API_TOKEN = [Environment]::GetEnvironmentVariable('REVIEWABLE_API_TOKEN','User')
$env:REVIEWABLE_URL = [Environment]::GetEnvironmentVariable('REVIEWABLE_URL','User')
reviewable review state --pr=BloomBooks/BloomDesktop/<number>
```

Don't ask the user to paste the token — read it from the User scope as above. If neither the
env vars nor the CLI (`reviewable` — typically installed globally via npm/Volta) is available,
stop and tell the user what's missing.

## Command map

All subcommands live under `reviewable review ...` (not `reviewable ...` directly):

```
reviewable review state        --pr=<owner>/<repo>/<number>
reviewable review discussions  list [--query="+needs:me"] --pr=...
reviewable review discussions  view --key=<key> --pr=...
reviewable review discussions  reply --key=<key> --pr=...      # JSON body on stdin
reviewable review discussions  acknowledge --key=<key> --pr=...
reviewable review discussions  create --pr=...                 # JSON body on stdin; CLI 1.3.1+
reviewable review files        list --pr=...                   # file keys, for create
reviewable review revisions    list --pr=...                   # rN key + head commit SHA
reviewable review publish      --pr=...
```

`discussions create` does not exist in CLI 1.0.x. If it is missing, update the CLI
(`volta install reviewable@latest`).

## Starting a new thread

To put a new comment on a file or line (e.g. an explanation for a reviewer), create a draft
discussion and then publish. Get the file's `key` from `files list` and the head commit SHA of the
revision to anchor on from `revisions list`. If you just pushed, wait until `revisions list`
shows that SHA. The body, on stdin:

```json
{
  "markdownBody": "[<attribution tag>] <the comment>",
  "disposition": "informing",
  "location": {
    "file": { "key": "<file key>", "path": "src/path/File.cs" },
    "line": 42,
    "revision": { "commitSha": "<head SHA>" }
  }
}
```

`disposition` is one of `informing`, `discussing` (the default), `blocking`, `working`; use
`informing` for an explanation that asks nothing of the reviewer. Leave out `line` for a
file-level comment, and leave out `location` for a review-level one. Post it with
`cat body.json | reviewable review discussions create --pr=...`, then `publish`. Verify that
`discussions view --key=<new key>` shows `"draft": null`.

If a flag doesn't behave as documented here, check `reviewable review --help` — this file
describes the workflow, the CLI is the source of truth for its own syntax.

## Thread key types — decide where to reply

Discussion keys tell you how a thread is wired:

- **`-O...`** — Reviewable-native inline thread. Has **no GitHub mirror**; the ONLY way to
  reply is via this CLI. Read the code the thread is anchored to before composing the reply.
- **`gh-...`** — a mirrored GitHub review comment. Mirroring is **two-way**: a reply posted on
  GitHub (e.g. via `gh api`) shows up inside the Reviewable thread automatically, and often
  flips it to resolved. If a reply was already posted on GitHub, do **NOT** also reply via the
  CLI — that duplicates. Pick one channel per thread.
- **`-top`** — a PR-level (top of review) thread.

## Workflow

1. **State**: `reviewable review state --pr=...` — confirms auth and shows overall review state.
2. **Find what needs a response**: `reviewable review discussions list --query="+needs:me" --pr=...`
3. **Read each thread**: `reviewable review discussions view --key=<key> --pr=...` — and read
   the relevant code so the reply is accurate, not generic.
4. **Reply** — the body is JSON on **stdin**. Write it to a file and feed that file in from
   **Git Bash**:
   ```bash
   # body.json (write it with the Write tool — one JSON object):
   #   { "markdownBody": "[<model name>] <the reply>", "disposition": "satisfied" }
   cat body.json | reviewable review discussions reply --key=<key> --pr=...
   ```
   ⚠️ **Never pipe the body from Windows PowerShell** (`... | ConvertTo-Json | reviewable ...`).
   The PowerShell pipe prepends a UTF-8 BOM even with `$OutputEncoding` set to BOM-less UTF-8,
   and the CLI rejects it with `Expected valid JSON on stdin: Unexpected token '﻿'`. There is no
   way to make that form work. If you must run it from PowerShell, use a raw stdin redirect
   through cmd, which doesn't touch the bytes: `cmd /c "reviewable review discussions reply
   --key=<key> --pr=... < body.json"`.
5. **Publish**: `reviewable review publish --pr=...` — replies are drafts until published.
6. **Verify**: re-run `discussions list` / `view` and confirm each intended reply is visible.

## Rules

- Every reply body **starts with the team attribution tag** (`TEAM-AGENTS.md`, "Attribution"):
  `[<model name> from <developer-name>'s machine during reviewable-replies]` — it posts under
  the user's account, and text written by an AI must say so. No workflow-label prefixes
  ("Will do, TODO", etc.).
- Exactly **one reply per thread**; don't post broad summary comments when thread replies were
  asked for.
- Set only **your own** disposition (`satisfied` is the normal one after responding). Threads
  stay unresolved until the original reviewer flips *their* disposition — that's theirs to do,
  not yours. Never try to resolve/dismiss on the reviewer's behalf.
- Report at the end: which threads got replies, which were skipped (already answered on the
  GitHub side, already resolved), and any failures.
