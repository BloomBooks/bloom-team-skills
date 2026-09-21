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

## Two agents in one tree overwrite each other, and it never looks like that

This has cost real work three times, and **not once did it present as a conflict**. Nothing in
`git status` says "another agent is also here", no error is raised, and the damage surfaces later
disguised as something else — a green suite, a flaky test, a file that reverts itself.

What it looked like each time:

- Two subagents each created `src/alphabet.spec.ts`; the second used `Write` without checking, and
  six uncommitted tests vanished unrecoverably. The suite stayed **green** — 72 passing reads as
  "9 added to 63", not "9 replaced 6".
- Two agents fixing different bug "clusters" in one checkout: edits disappeared from disk twice,
  mid-session, because the other agent wrote a whole-file version built on a pre-edit snapshot.
  Between wipes the shared file was transiently uncompilable, so a full suite came back with 39
  failures in code neither of them had touched.
- Two agents in one worktree, one checking out a new branch not knowing the other was mid-task:
  for half an hour each one's edits landed on the other's branch. It surfaced as `ECONNRESET` in
  visual-regression tests (two app instances contending over one `output/`) and as a pin file
  changing to a SHA nobody had written — which nearly got committed.

The rules:

- **A worktree has one owner for the length of a task.** Before `git checkout -b` in a worktree you
  did not create, look for someone else's work in progress — an uncommitted diff plus a branch name
  that is not yours is signal enough — and ask before switching. A lead handing out a worktree
  should say whether it is exclusive.
- **Concurrent agents need a worktree each, or provably non-overlapping file sets.** Only the
  dispatcher can see the overlap, and it is invisible when the work is split by *theme* rather than
  by file, which is the natural way to split it. Assign files, or assign worktrees.
- **Read or Glob before you `Write` a new file** — a `Write` to a path a sibling just created
  destroys it silently.
- **In a shared tree, a red full suite says nothing about your change, and a green one proves
  nothing either.** Re-`grep` for your own edits before trusting any test run, and scope the run to
  your own files. An orchestrator running parallel agents should keep a total-test-count ledger;
  the arithmetic mismatch is what catches a clobbered spec file immediately.

This is the same class of trap as the shared cwd below: **shared state that looks private.**

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

## Tooling traps that look like code bugs

Each of these has cost hours because the error message blames the code. Match the symptom, then
load the `windows-agent-gotchas` skill for the fix before touching the product.

- A tool you drove says `'x.bat' is not recognized` while the file sits in its cwd → Claude Code
  sets `NoDefaultCurrentDirectoryInExePath=1` in every child process; clear it around the call.
- A multi-line `node -e` prints nothing and exits 0 → not a pass; have it write results to a
  file and read that, or put the logic on one line.
- A one-line local server exits 0 at once → the Bash sandbox denies listening sockets.
- A backgrounded command piped to `Select-Object -Last` shows nothing for minutes → it buffers
  until exit; read the raw output file.
- Generated code arrives with `\n` or `\"` turned into real newlines or quotes → heredoc
  escaping, even quoted; write the file with the Write tool.
- `MODULE_NOT_FOUND` from a scratch script, or `ERR_UNSUPPORTED_ESM_URL_SCHEME` on `D:` → put the
  script inside the package; import Windows paths as `file:///` URLs.
- `npm -C <pkg> exec vite` serves the wrong root → `-C` is npm's prefix, not a cd; pass `--config`.
- `spawnSync npx.cmd EINVAL`, or a CLI answering with its own help → `.cmd` shims need
  `shell: true` and arguments that need no quoting.
- Mojibake seen only through `py -m json.tool` → the formatter re-encoded; check via node.
- `sed -i` broke a script → it eats backslashes; rewrite the file. Seven `<` in `node -e` → shell
  redirection; build the marker by concatenation. `git apply -3` → read `git diff --cached`.
  `git worktree add` under the scratchpad → `Filename too long`; use a short path.
- Browser tools: "Script injection timed out" or a `find` waiting for document_idle → the tooling,
  not the page (`javascript_tool` still works; two failures on two pages means stop and say the
  page is unverified). A background tab freezes transitions, focus, clipboard and timers.
  `navigate` refuses `file://`; screenshot with headless Chrome and absolute paths. When a skill
  ends with "render it and look at it" and no screenshot arrives, say the output is unverified.

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

## A problem you removed leaves no record

When a papercut is fixed, an automation retired, or a workaround made unnecessary, take the
thing out and stop there. It is gone; nothing should say that it once existed or that you were
the one who dealt with it.

So, when you delete an entry or a mechanism, do **not** replace it with:

- a "resolved" / "fixed on 2026-09-05" / "history" section, or a list of what each removed
  entry used to be;
- a line saying the log is now empty, or how many cuts were closed;
- a comment in the code narrating the old behaviour — "this used to select twice", "was a
  styled() component before", "kept for the bug where …".

A `PAPERCUTS.md` with every entry deleted is just its header block. Leave that, and nothing
else.

The distinction that matters in code: a comment that states a **live constraint** earns its
place, because a reader is about to break it — "do not import the MUI styles barrel; the dev
server's pre-bundler emits a chunk that calls Emotion's init without importing it". A comment
that narrates **what changed** does not, because git already holds it. Write the constraint in
the present tense, about the code as it stands, with no reference to the fix or the session.

The commit message is where the story goes. It is the one place a reader looks for history,
and the only place it does not get in the way.
