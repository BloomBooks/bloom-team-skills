# Publishing dev-process artifacts to a public URL

Some of the HTML/asset artifacts our skills produce — decider forms, preflight report pages,
screenshots destined for a PR — need a **publicly readable URL** so anyone can open them: a
teammate without a Claude subscription, a reviewer on a PR, or a zero-context agent resuming
work days later from a link on a YouTrack card.

The Anthropic **Artifact** tool does not give us that: those pages are private and readable
only by the developer who created them (SIL Global subscribers). There is no public toggle.
So for anything that must leave the session, publish it to a public GitHub Pages repo instead.

There is nothing special about these artifacts — a decider is just self-contained HTML plus a
little clipboard JS. Hosting it is "commit a file, push, use the deterministic Pages URL."

## The repo

**`BloomBooks/dev-process-artifacts`** — a public repo whose only job is to host these
throwaway-but-linkable files. GitHub Pages serves the root of `main`, so every file is
reachable at a predictable URL:

```
https://bloombooks.github.io/dev-process-artifacts/<path>
```

Layout (create subfolders as needed):

```
dev-process-artifacts/
  .nojekyll            # serve files as-is; we do NOT use Jekyll
  README.md            # purpose + the "squash history periodically" policy
  deciders/            # decider / preflight report pages, e.g. BL-1234.html
  pr-screenshots/      # images to embed in a PR, e.g. bloomdesktop-8123-before.png
  reports/             # any other one-off report pages
```

`.nojekyll` (an empty file at the root) is required: without it Pages runs a Jekyll build
that can drop files whose names start with `_` and adds needless latency. We don't use Jekyll.

## Naming

Make names collision-proof and self-describing — include the source repo and the branch/PR/id
so files from different products never clash:

- Decider / preflight report: `deciders/<sourceRepo>-<branch>.html` (a stable name per branch
  means re-running preflight republishes to the **same URL** — good, one link per branch), or
  `deciders/BL-<id>-<yyyymmdd-hhmm>.html` when you want a distinct URL per run.
- PR screenshot: `pr-screenshots/<sourceRepo>-<pr#>-<slug>.png`.

## Publishing (the agent already has `git` + `gh`)

The Pages URL is **deterministic** — you pick the path — so unlike the Anthropic Artifact flow
there is no publish-then-patch chicken-and-egg: bake the final URL into the page (and into a
copy-back header) *before* you push.

```bash
DPA="$(dirname "$SCRATCH")/dev-process-artifacts"   # any working dir; a persistent clone is fine
git clone --depth 1 https://github.com/BloomBooks/dev-process-artifacts "$DPA" 2>/dev/null \
  || git -C "$DPA" pull --ff-only
mkdir -p "$DPA/deciders"
cp "<local-report>.html" "$DPA/deciders/<name>.html"
git -C "$DPA" add "deciders/<name>.html"
git -C "$DPA" commit -m "Add <name> report for <sourceRepo> <branch/PR>"
git -C "$DPA" push
# Public URL (knowable before the push finishes):
#   https://bloombooks.github.io/dev-process-artifacts/deciders/<name>.html
```

Notes:
- **Propagation:** a just-pushed file can 404 for up to ~1 minute while Pages rebuilds. The URL
  is still correct — mention it may take a moment. If you need it live *instantly* (rare),
  `https://raw.githack.com/BloomBooks/dev-process-artifacts/main/<path>` renders the same file
  through a proxy with no build wait (githack works on **public** repos only — it fetches
  anonymously and can't read a private one).
- **Degrade gracefully:** if the push fails (no `gh`/git auth, network), fall back to the
  Anthropic Artifact tool and say in the report that the link is subscriber-only.

## When to use which target

- **`dev-process-artifacts` Pages** — whenever the link will be read by anyone outside this
  session: posted to a YouTrack card, dropped in a PR, or handed to a teammate/another agent.
  This includes every `process-sentry-issues` escalation.
- **Anthropic Artifact tool** — fine when only the in-session developer needs to see it and a
  subscriber-only link is acceptable (a quick interactive decider you'll act on immediately).

## Privacy — this repo is public

Everything here is world-readable and search-indexable. BloomDesktop, BloomPlayer, and their
PRs are already public, so a decider's root-cause analysis or a PR screenshot exposes nothing
new. But **never** publish genuine secrets (tokens, keys, customer data). If a specific
artifact must stay private, attach it to the YouTrack card instead (access-controlled) and
accept that a human opens the downloaded file locally — the copy-back button still works from
`file://`.

## Housekeeping

Committed screenshots and report pages accumulate as binary/HTML history forever. Periodically
**squash the repo's history** (e.g. yearly, or when it gets heavy) — old links break, but these
artifacts are ephemeral by design. The repo's own README should state this so no one treats a
link as permanent.
