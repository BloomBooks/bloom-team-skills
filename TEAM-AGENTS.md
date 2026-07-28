# Team-wide agent guidance (always loaded)

This file holds the Bloom team's agent rules that should be active in **every** repo and
session — things no single repo's AGENTS.md can reach. Each dev imports it once from their
personal global `~/.claude/CLAUDE.md` with a line like `@D:/bloom-team-skills/TEAM-AGENTS.md`
(pointing at their own clone; see the README's Installation section). Keep it short: only
rules that genuinely apply everywhere belong here.

## Links in chat replies must be bare URLs

Your replies are rendered as Markdown **in a terminal**. Markdown link syntax —
`[BL-16618](https://issues.bloomlibrary.org/youtrack/issue/BL-16618)` — styles the label but
leaves nothing clickable unless the terminal supports OSC 8 hyperlink escapes, which many
don't. The result is the worst case: the label *looks* like a link (coloured, underlined), and
the URL is hidden inside the markup, so the reader can neither click it nor copy it. Bare URLs,
by contrast, are auto-detected and linkified by essentially every terminal.

So, in chat replies:

- **Write the URL itself**, not a Markdown link around it:
  `https://issues.bloomlibrary.org/youtrack/issue/BL-16618`. If you want a label, put it
  outside the link: `BL-16618 — https://issues.bloomlibrary.org/youtrack/issue/BL-16618`.
- **Never cite a PR or issue by number alone.** `PR #8118` and `BL-16618` are not links
  anywhere outside GitHub's or YouTrack's own web UI, so in a terminal they are dead text the
  reader has to go look up by hand. Give the URL.
- The same applies to file paths you want opened — a plain `src/foo/Bar.tsx:42` is clickable in
  Claude Code; wrapping it in Markdown is not.

Even where hyperlinks *do* work, a bare URL is still the better choice: it survives copy-paste
into a browser, a ticket, or a chat message, and it doesn't depend on the reader's terminal.
(Claude Code only emits the OSC 8 escapes when it recognises the terminal — an unrecognised one,
such as Orca's, needs `FORCE_HYPERLINK=1` in the `env` block of `~/.claude/settings.json`.)

This rule is about **terminal chat output only**. In content you *write into files or post to a
web service* — PR titles/bodies, YouTrack comments, GitHub review replies, Markdown docs —
ordinary `[text](url)` Markdown is correct and preferred, because GitHub and YouTrack render it
as a real link.

## Attribution — tag anything you post under a developer's identity

Whenever you post or send something that appears under a developer's identity — a GitHub PR
comment or review reply, a YouTrack card or comment, an email, a chat message — **start the body
with a bracketed attribution tag** so a reader can see the text came from an AI agent, not from
the human whose account (or bot) it was posted through. Two forms:

- Driven by a skill: `[<model name> from <developer-name>'s machine during <skill-name>]`
  — e.g. `[Claude Opus 4.8 from Hatton's machine during preflight]`
- Ad-hoc (no skill running): `[<model name> following a prompt from <developer-name>]`
  — e.g. `[Claude Opus 4.8 following a prompt from Hatton]`

Use the friendly model name (e.g. `Claude Opus 4.8`), and get `<developer-name>` from
`git config user.name`. Don't omit the tag; writing under someone's identity without it is
misleading.

**YouTrack is a special case:** all of its traffic — reads and writes alike — goes through a
shared **"Bot"** account (never the developer's own login), so the tag is the *only* provenance a
reader gets. The `youtrack-api` skill carries the mechanics (`$YOUTRACK_BOT`, and only that token)
and repeats this tag format.

## Papercuts

When you hit tooling/process friction, have to work around something, or learn something the
docs or skills should have told you — and now isn't the time to fix it — log a papercut:
append a short entry to `PAPERCUTS.md` at the current repo's root if the cut is about that
repo, or to `PAPERCUTS.md` in bloom-team-skills if it's about the environment, machine, or
team workflow. Follow the `papercut` skill for the format and git handling (in your working
repo: just edit, don't commit separately; in bloom-team-skills: commit and push). Don't derail
your current task — capture takes under a minute — and mention the logged cut in your final
report. Users can also ask directly: "add a papercut about ...".
