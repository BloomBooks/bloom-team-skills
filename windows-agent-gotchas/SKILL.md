---
name: windows-agent-gotchas
description: Diagnose a tooling failure on a Windows dev machine under Claude Code that presents as a bug in the code or the repo — a subprocess that "can't find" a file in its own cwd, a node -e that prints nothing, a heredoc-written script with impossible syntax errors, a module that won't resolve from a scratch directory, a .cmd shim that rejects arguments, a browser screenshot tool that times out, a background tab whose CSS or focus seems dead, mojibake seen only through a formatter, a backgrounded command that shows no output for minutes, npm -C serving the wrong root, sed -i or a heredoc corrupting a script, a Filename-too-long worktree. Use when the symptom matches a line of the "Tooling traps" index in TEAM-AGENTS.md, before changing any product code.
---

# Windows and Claude Code tooling gotchas

The index of symptoms lives in `TEAM-AGENTS.md` ("Tooling traps that look like code bugs"). This
file is the full account of each trap: what it looks like, why it happens, and what to do. Every
one of these has produced a confident wrong diagnosis of innocent code at least once.

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
