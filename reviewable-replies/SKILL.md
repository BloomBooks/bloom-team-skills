---
name: reviewable-replies
description: Reply to Reviewable.io PR review discussions via the official `reviewable` CLI (REST API) — per-thread replies, correct handling of GitHub-mirrored vs Reviewable-native threads, and publishing. Use whenever review comments on a Reviewable-managed PR need responses.
argument-hint: "PR (e.g. BloomBooks/BloomDesktop#7557) and which discussions to answer; or enough context to find them"
user-invocable: true
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

**Windows gotcha:** these are typically set at the **User** environment scope, which a Git
Bash tool session does NOT inherit. PowerShell can read them without displaying the secret —
and since shell state doesn't persist between tool calls, re-set both vars in every call:

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
reviewable review publish      --pr=...
```

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
4. **Reply** — pipe a JSON body into `reply`:
   ```powershell
   @{ markdownBody = "[<model name>] <the reply>"; disposition = 'satisfied' } |
     ConvertTo-Json | reviewable review discussions reply --key=<key> --pr=...
   ```
5. **Publish**: `reviewable review publish --pr=...` — replies are drafts until published.
6. **Verify**: re-run `discussions list` / `view` and confirm each intended reply is visible.

## Rules

- Every reply body **starts with `[<model name>]`** (e.g. `[Claude Fable 5]`) — it posts under
  the user's account, and text written by an AI must say so. No workflow-label prefixes
  ("Will do, TODO", etc.).
- Exactly **one reply per thread**; don't post broad summary comments when thread replies were
  asked for.
- Set only **your own** disposition (`satisfied` is the normal one after responding). Threads
  stay unresolved until the original reviewer flips *their* disposition — that's theirs to do,
  not yours. Never try to resolve/dismiss on the reviewer's behalf.
- Report at the end: which threads got replies, which were skipped (already answered on the
  GitHub side, already resolved), and any failures.
