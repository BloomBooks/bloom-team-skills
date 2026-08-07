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

## Branch and worktree names start with the ticket id

Name a branch **`<TICKET-ID>-<1–3 words>`** — the tracker id first, then just enough words to
remember what it's about: `BL-16627-shrink-image-pane`, `BL-15958-edge-to-edge-theme`. Give the
Orca worktree the same name, so the workspace card, the branch, and the card all read the same.

The id-first part is **load-bearing, not cosmetic**: `youtrack-api` ("Find the issue id for the
current work") and `preflight` identify a branch's card by reading a `BL-XXXXX` prefix off
`git rev-parse --abbrev-ref HEAD`, and that is the *whole* check — they are told not to go
hunting through commit messages or PR titles. A branch with no id in its name is a branch with no
card as far as every automated caller is concerned.

So: **create the card before the branch.** If you've already made a branch and the card comes
later, rename it (`git branch -m <old> <new>`) while that's still free — before pushing, and
before a PR or an Orca worktree is pointing at the old name. The 1–3 words are for humans; don't
paste the card's whole summary in.

## Never `cd` in a shell tool — the Bash and PowerShell tools share one cwd

They look like independent shells; they are not. A throwaway `cd <somewhere> && grep …` in a
**Bash** call leaves every later **PowerShell** call in that directory, and vice versa. Both
tools already start in the repo root and absolute paths work everywhere, so a `cd` buys nothing
and the leak surfaces far from its cause, disguised as a broken repo: `vp test run packages/lib`
died with `Projects definition references a non-existing file or a directory: …` purely because
`vite.config.ts` resolves `test.projects` relative to cwd. Nothing in such a message says "you
are in the wrong directory," and Bash only *sometimes* prints `Shell cwd was reset to <repo>`, so
you can't tell from the transcript whether the cwd leaked.

Use absolute paths, or a tool's own directory flag (`git -C`, `pnpm -C`, `--cwd`). Belt and
braces before running `vp`/`pnpm`: start the PowerShell call with `Set-Location <repo root>`.

## A subprocess "can't find" a file that is sitting in its working directory

Check `NoDefaultCurrentDirectoryInExePath` before anything else. **Claude Code puts
`NoDefaultCurrentDirectoryInExePath=1` into the environment of every process it spawns**, and that
is the Windows switch telling `cmd.exe` *not* to look in the current directory when it resolves a
bare command name. So any external tool we drive that runs `cmd.exe /C something.bat` with a
working directory — a common pattern in generated build scripts — dies with `'something.bat' is not
recognized as an internal or external command` while the file is right there in cmd's cwd. Windows
inherits the variable down the whole chain, so it reaches the tool however many processes deep it
sits.

Everything about the symptom points away from the cause: the message names the file, so it reads as
a missing dependency you should go install, and the developer cannot reproduce it, because a shell
they started themselves does not have the variable. It is set in neither the User nor the Machine
environment, and Git Bash, PowerShell and a normally-launched app are all clean — it enters at
`claude.exe`. So this is an agent-session artifact: **do not "fix" the product, which is not at
fault.** If a test or script has to drive such a tool, clear the variable around that call
(`Environment.SetEnvironmentVariable(name, null)` in C#, restoring it afterwards) and say in a
comment why.

Real cost: Reading App Builder's Android build in Bloom does exactly this, and it took most of a day
across two sessions to find, having first produced a confident and completely wrong diagnosis.

## "A previous session already did this" is a lookup, not a guess

When the user says an earlier session built something — and especially when it doesn't work —
read what that session actually did instead of re-deriving it from the code. The transcripts are
on disk: `~/.claude/projects/<repo-slug>/*.jsonl`, one JSON object per line with `type`,
`timestamp`, and `message.content`. `grep -c <symbol> *.jsonl` finds the right session in one
command, and a small filter over `type == "user"` / `"assistant"` prints the real requests and
the real claims. That turns "here's what probably happened" into what happened — in one case,
that the feature had only ever been run against synthetic fixtures the agent generated itself,
never against the book that motivated it, a fact its own sign-off mentioned in a footnote.

Corollary, since that's the failure it exposes: **when a feature is built for a specific
artifact, running it against that artifact is part of the work**, not a nice-to-have.

## Papercuts

When you hit tooling/process friction, have to work around something, or learn something the
docs or skills should have told you — and now isn't the time to fix it — log a papercut:
append a short entry to `PAPERCUTS.md` at the current repo's root if the cut is about that
repo, or to `PAPERCUTS.md` in bloom-team-skills if it's about the environment, machine, or
team workflow. Follow the `papercut` skill for the format and git handling (in your working
repo: just edit, don't commit separately; in bloom-team-skills: commit and push). Don't derail
your current task — capture takes under a minute — and mention the logged cut in your final
report. Users can also ask directly: "add a papercut about ...".
