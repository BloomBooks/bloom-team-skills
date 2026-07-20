# Publishing dev-process artifacts to a public URL

Some of the HTML/asset artifacts our skills produce — decider forms, preflight report pages,
screenshots destined for a PR — need a **publicly readable URL** so anyone can open them: a
teammate without a Claude subscription, a reviewer on a PR, or a zero-context agent resuming
work days later from a link on a YouTrack card.

The Anthropic **Artifact** tool does not give us that: those pages are private and readable
only by the developer who created them (SIL Global subscribers). There is no public toggle.
So for anything that must leave the session, commit it to a public repo and serve it publicly.

There is nothing special about these artifacts — a decider is just self-contained HTML plus a
little clipboard JS. Hosting it is "commit a file, push, use the URL."

## The repo

**`BloomBooks/dev-process-artifacts`** — a public repo whose only job is to host these
throwaway-but-linkable files. Once a file is pushed, there are **two** ways to serve it as a
rendered page; **prefer githack** (default) and keep Pages as a fallback:

- **githack (default)** — a CDN proxy that fetches the raw file and serves it with the right
  `Content-Type` so it renders (plain `raw.githubusercontent.com` sends `text/plain`, which
  won't render). No build/deploy step — the file is **live the instant `git push` finishes**.
  ```
  https://raw.githack.com/BloomBooks/dev-process-artifacts/main/<path>
  ```
- **GitHub Pages (durable fallback)** — first-party GitHub hosting, enabled on the root of
  `main`. There is a deploy step (~1 min on each push; a couple of minutes the very first
  time), so it's not instant, but it has no third-party dependency and no cache staleness.
  ```
  https://bloombooks.github.io/dev-process-artifacts/<path>
  ```

Both are public and both take the same `<path>` (e.g. `deciders/BL-1234.html`). githack works
on **public** repos only — it fetches anonymously and cannot read a private one.

Layout (create subfolders as needed):

```
dev-process-artifacts/
  .nojekyll            # Pages: serve files as-is; we do NOT use Jekyll
  README.md            # purpose + the "squash history periodically" policy
  deciders/            # decider / preflight report pages, e.g. BL-1234.html
  pr-screenshots/      # images to embed in a PR, e.g. bloomdesktop-8123-before.png
  reports/             # any other one-off report pages
```

`.nojekyll` (an empty file at the root) only matters for the Pages fallback: without it Pages
runs a Jekyll build that can drop files whose names start with `_` and adds latency. githack
ignores it.

## Naming

Make names collision-proof and self-describing — include the source repo and the branch/PR/id
so files from different products never clash:

- Decider / preflight report: `deciders/<sourceRepo>-<branch>.html` (a stable name per branch
  means re-running preflight republishes to the **same URL** — good, one link per branch), or
  `deciders/BL-<id>-<yyyymmdd-hhmm>.html` when you want a distinct URL per run.
- PR screenshot: `pr-screenshots/<sourceRepo>-<pr#>-<slug>.png`.

## Publishing (the agent already has `git` + `gh`)

The githack URL is **deterministic** — you pick the path — so unlike the Anthropic Artifact
flow there is no publish-then-patch chicken-and-egg: bake the final URL into the page (and into
a copy-back header) *before* you push, then it's live the moment the push completes.

```bash
DPA="$(dirname "$SCRATCH")/dev-process-artifacts"   # any working dir; a persistent clone is fine
git clone --depth 1 https://github.com/BloomBooks/dev-process-artifacts "$DPA" 2>/dev/null \
  || git -C "$DPA" pull --ff-only
mkdir -p "$DPA/deciders"
cp "<local-report>.html" "$DPA/deciders/<name>.html"
git -C "$DPA" add "deciders/<name>.html"
git -C "$DPA" commit -m "Add <name> report for <sourceRepo> <branch/PR>"
git -C "$DPA" push
# Live immediately (default — bake this into the page/copy-back before pushing):
#   https://raw.githack.com/BloomBooks/dev-process-artifacts/main/deciders/<name>.html
# Durable fallback (same path, ~1 min deploy delay):
#   https://bloombooks.github.io/dev-process-artifacts/deciders/<name>.html
```

Notes:
- **githack cache / re-push staleness:** the `raw.githack.com/main/...` URL caches for **~60
  seconds** (`cache-control: max-age=60`). If you re-push the **same** path (e.g. preflight
  re-runs), the old version can serve for up to a minute. If that matters, either wait a minute
  or use the commit-pinned production URL, which is immutable and never stale:
  `https://rawcdn.githack.com/BloomBooks/dev-process-artifacts/<commit-sha>/<path>` — commit
  locally, read the sha (`git -C "$DPA" rev-parse HEAD`), bake *that* URL in, then push. The
  cost is a new URL per run, so re-post it if it's already on a card.
- **githack is a free third-party proxy** (no SLA). For a link that must survive for weeks or
  an outage, the Pages URL (same path) is the first-party fallback — worth including alongside
  the githack link on long-lived cards.
- **Degrade gracefully:** if the push fails (no `gh`/git auth, network), fall back to the
  Anthropic Artifact tool and say in the report that the link is subscriber-only.

## When to use which target

- **githack URL on `dev-process-artifacts` (default)** — whenever the link will be read by
  anyone outside this session: posted to a YouTrack card, dropped in a PR, or handed to a
  teammate/another agent. This includes every `process-sentry-issues` escalation. Add the Pages
  URL too when the link needs to outlive githack's cache or a githack outage.
- **Anthropic Artifact tool** — fine when only the in-session developer needs to see it and a
  subscriber-only link is acceptable (a quick interactive decider you'll act on immediately).

## Privacy — this repo is public

Everything here is world-readable. BloomDesktop, BloomPlayer, and their PRs are already public,
so a decider's root-cause analysis or a PR screenshot exposes nothing new. (githack sends
`x-robots-tag: none` so its URLs aren't search-indexed, but the underlying GitHub repo still
is — don't rely on obscurity.) **Never** publish genuine secrets (tokens, keys, customer
data). If a specific artifact must stay private, attach it to the YouTrack card instead
(access-controlled) and accept that a human opens the downloaded file locally — the copy-back
button still works from `file://`.

## Housekeeping

Committed screenshots and report pages accumulate as binary/HTML history forever. Periodically
**squash the repo's history** (e.g. yearly, or when it gets heavy) — old links break, but these
artifacts are ephemeral by design. The repo's own README should state this so no one treats a
link as permanent.
