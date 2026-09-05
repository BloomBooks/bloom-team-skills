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

## Throwaway scripts, worktrees, and other shell mechanics that look like code bugs

Each of these presents as a problem with the code or the repo, which is why they cost a retry
every time. Splitting one 38-file PR into an eleven-branch stack hit three of them in a row.

- **Put a scratch worktree at a short path.** `git worktree add` under the agent scratchpad dies
  with `Filename too long` — that path is ~120 characters before the repo's own deep paths start.
  Use something like `D:/bl-master`.
- **Never `sed -i` a script.** It silently eats backslash escapes, so the next run fails with
  `SyntaxError: Invalid or unexpected token` in a file you just wrote and believe. Rewrite the
  whole file instead — with the `Write` tool, or a quoted heredoc (`cat > /tmp/x.mjs <<'SCRIPT'`).
- **Don't type a conflict marker into a script or a command.** Seven angle brackets in `node -e`
  are parsed as a shell redirection (`<< was unexpected at this time`, from Git Bash). Build the
  marker by concatenation: `"<" + "<<<<<< ours"`.
- **`git apply -3` stages what it applies**, so the following `git diff` looks empty and tells you
  nothing happened. `git diff --cached` is the one to read.

The general rule behind the middle two: a string that passes through a heredoc, a shell, and then
a second language is escaped three times, and the diagnosis always points at the innermost layer.
Write the file verbatim rather than editing it in place, and construct troublesome characters
rather than typing them.

## Running scripts and tools on Windows: the ways they lie to you

Every item here presents as a bug in your code or the project. They are not — and the wasted time
goes into diagnosing the innocent layer, so check these first.

**Silence is not success.**

- **`node -e` can print nothing and exit 0** with a multi-line double-quoted script — the identical
  logic on one line prints fine. Never read an empty `node -e` as "the check passed": have it write
  results to a file and `cat` that.
- **The Bash sandbox denies listening sockets and reports it as a clean exit.** A one-liner HTTP
  server exits instantly, code 0, no output, which reads as "my one-liner is wrong". It needs
  `dangerouslyDisableSandbox: true`.
- **A backgrounded command piped to `Select-Object -Last N` writes nothing until it exits** —
  `-Last`, like `Sort-Object`, must see the whole stream before it can emit. Five minutes of an
  empty output file looked exactly like a hung nx daemon; the run had actually succeeded. Let a
  long command write raw and read the tail of the file afterwards; `-First`/`Where-Object` stream
  and are safe. An empty background output file proves nothing about whether the process is alive.

**Escapes through a heredoc.** A backslash escape inside a shell heredoc reaches the file as the
character it names, *even in a quoted (`<<'EOF'`) heredoc that the shell is not supposed to touch*.
`\n` and `\r\n` become real line breaks and `\"` becomes a quote, so generated code arrives with
unterminated string literals — it bit four times in one session, twice reaching a commit before a
build caught it, and once broke the very script that was being written to record it. Use the
**`Write` tool** for any file whose content contains backslash escapes; it writes bytes verbatim.
Where a heredoc is unavoidable, construct the character instead of escaping it (`chr(92)`,
`String.fromCharCode(10)`), or pick a form with no escapes at all — C# raw
string literals (triple double-quotes) work well for multi-line fixtures. The failure presents as a compiler complaint
about code you are certain you wrote correctly, which sends you looking in the wrong place.

**Paths and module resolution.**

- **A throwaway node script resolves modules from its own directory, not cwd**, so a `.cjs` in the
  scratchpad gets `MODULE_NOT_FOUND` for the project's deps. Write it *inside the package
  directory*, run it, delete it.
- **A bare Windows absolute path is not a valid ESM specifier** — Node parses `D:` as a URL scheme
  and throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Import `file:///D:/repo/tools/x.mjs`, or build it
  with `pathToFileURL(path).href`. The trap catches agents precisely because "always use absolute
  paths" is the rule everywhere else.
- **`-C`/`--prefix` is not a `cd`.** `npm -C <pkg> exec -- vite` sets *npm's* prefix, so vite
  resolved its config from the repo root, found none, and served the monorepo root — printing a
  perfectly healthy "ready in 144 ms" banner while every request 404'd. Point the tool at its
  config by absolute path (`--config D:/<repo>/<pkg>/vite.config.ts`) instead.

**Spawning a `.cmd` shim (npm, pnpm, npx, tsc) from Node on Windows.** You cannot have both a
shell-free spawn and a `.cmd`: without `shell: true` Node refuses with `spawnSync npx.cmd EINVAL`
(the argument-injection fix in 18.20/20.12), and with it the shell re-parses your arguments. Keep
`shell: true` and make sure **no argument needs quoting** — write SQL or any multi-line payload to
a file and pass `-f <file>`, and quote path arguments yourself. A CLI that answers by printing its
own help is usually telling you its arguments were re-parsed, not that you used the wrong flags.

**Don't trust a formatter's rendering of non-ASCII.** `py -m json.tool` re-encodes with
`ensure_ascii=True` and mangles UTF-8 on the way through the pipe, so clean data prints as textbook
mojibake (`Ã¢`) and you go hunting for corruption that isn't there — zero rows were actually
bad. Eyeball non-ASCII JSON through `node -e`, or set `PYTHONIOENCODING=utf-8` and print with
`ensure_ascii=False`. Before believing any encoding bug seen through a formatter, check one record
through a second path. (Relatedly, Python's `urllib` gets a bare 403 from endpoints that answer
node's `fetch` fine — probably the missing User-Agent; use node for API probing.)

## Looking at a page in the browser: when the tools fail, and what to use instead

Browser verification fails often, and **every failure message blames the page**, which is almost
never at fault. Seven separate cuts, hours of misdirected diagnosis, one shared lesson.

**"Script injection timed out after 5000ms — the page is busy or mid-navigation" is not about your
page.** `computer` screenshots and `read_page` need script injection at `document_idle` in the
**active** tab. They fail when another agent's tab is activated in the same Chrome, when the page
keeps fetching and so never reaches idle, and sometimes for a whole session on every page including
a static one-`<style>` file. `find` fails the same way ("waited 45000ms for document_idle").

- **One failed screenshot plus one successful `javascript_tool` call on the same tab** tells you in
  seconds whether the page is broken or the tooling is. `javascript_tool` and `navigate` keep
  working throughout — they don't wait for idle.
- **Two failures on two *different* pages means the tooling.** Stop retrying, stop hunting for a
  lighter page, and say the page is unverified.
- Two agents should not share one Chrome profile if either needs screenshots.

**Verify numerically instead — it is often better evidence than a picture.** `getComputedStyle` and
`getBoundingClientRect` over the elements a mockup specifies give a token-by-token comparison
(surface, ink, radius, padding, font weight) and have caught real defects a screenshot would have
missed. `document.body.innerText` replaces a screenshot for content; `element.click()` and a
native-setter `input` dispatch replace clicking and typing; `canvas.measureText` with and without a
font in the stack proves which font actually drew a character.

**A background tab silently changes what the page does** — check `document.visibilityState` and
`document.hasFocus()` *before* believing any of this:

- **Transitions and animations do not tick**, so every transitioned property sits at its start
  value forever and the CSS looks dead. Set `element.style.transition = 'none'` before reading a
  computed style, and restore it.
- **Nothing can hold focus**, so `element.focus()` does nothing and `element.blur()` fires neither
  `blur` nor `focusout` — a blur handler looks broken when it is fine. Test it by dispatching
  `new FocusEvent('focusout', { bubbles: true })` (React listens for `focusout` at the root).
- **`navigator.clipboard.writeText` rejects** with `Document is not focused`, and `window.focus()`
  won't lift it. Stub only the write, capturing the text, so the rest of the component still runs.
- **Timers are throttled.** A 2000 ms `setTimeout` measured as gone before 1650 ms, and a probe
  that slept repeatedly hit a 45 s CDP timeout on a live page. Assert that a transient element
  clears — never *when*.

**Looking at a static file you just generated.** `navigate` refuses `file://` outright, so it needs
a local server — which the Bash sandbox blocks (see the Windows section: a listening socket exits 0
with no output; use `dangerouslyDisableSandbox: true`). `vite preview` binds `localhost` only, not
`127.0.0.1`. The reliable route skips the extension entirely:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu \
  --hide-scrollbars --no-first-run --user-data-dir="<abs scratch>/profile" \
  --window-size=1100,2400 --screenshot="<abs scratch>/shot.png" http://localhost:8757/
```

Every path there must be **absolute**: Chrome resolves a relative `--screenshot` against its own
install directory and fails with `Access is denied`, which reads as a permission problem on the
directory you meant. It needs its own `--user-data-dir` (delete it afterwards), and
`--force-dark-mode` gives the dark pass.

**When a skill ends with "render it and look at it"** — `dataviz` and `artifact-design` both do —
and the screenshot never arrives, that step is unreachable. Say the output is unverified rather
than quietly treating it as checked.

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
