Note: When resolving a git merge conflict in this file, keep both sides' entries unless they can be merged. See the "papercuts" skill for more info.

---

## 2026-08-14 — Preflight's review sub-agent edited the live tree it was reviewing

- **Cut:** The light local review in `preflight` Phase 1 is dispatched as a general-purpose
  sub-agent, which gets write tools. Asked to review a fix that added a lock, it proved the
  point by editing the code under review — replacing `lock (GetFileLock(fullPath))` with
  `if (true) // TEMP-REVIEW-NO-LOCK` — while the session's full C# suite was running against
  that same tree. The suite came back "1 failed", which cost a re-run and a few minutes of
  suspicion aimed at the wrong thing (a base merge). It restored the line when told, but only
  after being told.
- **Idea:** Have `preflight` dispatch the light review with a read-only tool set (the `Explore`
  agent type, or general-purpose minus Edit/Write/NotebookEdit), and say in the prompt that the
  tree is live and shared. Worth stating in the skill even if the tool set can't be constrained:
  "do not modify any file; if you want to know whether a test is load-bearing, say so and let the
  caller check."
- **Context:** BloomDesktop PR 8207 (BL-16702), preflight run 2026-08-14.

## 2026-08-12 — In multi-agent sessions, Write silently clobbers a sibling agent's new file

- **Cut:** Two Opus subagents working the same package each created `src/alphabet.spec.ts`;
  the second used Write without checking the path existed and silently replaced the first
  agent's 6 uncommitted tests. Nothing caught it: the suite still went green (72 passing read
  as "9 added to 63", not "9 replaced 6"), and the file was unrecoverable from git.
- **Idea:** When orchestrating concurrent agents in one package, tell each agent to Read (or
  Glob) before Writing any new file, or pre-assign distinct spec filenames. A total-test-count
  ledger kept by the orchestrator catches the arithmetic mismatch immediately.
- **Context:** EthnoLib `CharacterVariants` branch on Hatton's machine, FontChooserScreen
  build-out with parallel polish/cv-extend agents.

## 2026-08-06 — The Remove-Item safety hook mis-parses a quoted path containing a space

- **Cut:** `Remove-Item "C:\Screenshot History\some file.png" -Force` was refused with
  `Remove-Item on system path '"C:\Screenshot' is blocked. This path is protected from removal.`
  The guard splits the command on whitespace before honouring the quotes, so it judges the
  leading fragment `"C:\Screenshot` rather than the real path, and every path with a space in a
  top-level folder name reads as a protected root. The whole tool call is refused, not just the
  one cmdlet, so anything chained after it silently does not run either.
- **Idea:** Teach the guard to parse the argument as PowerShell does (respect quotes, and
  `-LiteralPath`) before matching against the protected list. Meanwhile the workarounds are
  `[System.IO.File]::Delete($full)` or `Remove-Item -LiteralPath $full`, and it is worth
  building the path with `Join-Path` into a variable rather than inlining a quoted literal.
- **Context:** Hit on Hatton's machine while an agent cleaned up its own test files under
  `C:\Screenshot History` during work on the screen-tray project.

## 2026-07-28 — Markdown links in Claude Code replies aren't clickable in Orca's terminal

- **Cut:** `[BL-16618](https://…)` in a chat reply renders coloured + underlined but does
  nothing on click, and the URL is hidden inside the markup so it can't be copied either —
  strictly worse than plain text. Cause is Claude Code's hyperlink gate, not Orca: it emits OSC 8
  only for `WT_SESSION`, or `TERM_PROGRAM` in {ghostty, Hyper, kitty, alacritty, iTerm.app,
  iTerm2, WezTerm, vscode}, or JediTerm/alacritty. Orca sets `TERM_PROGRAM=Orca`, which matches
  nothing, so hyperlinks are suppressed. Orca's own terminal is fine — it bundles xterm.js with
  `OscLinkService` + `WebLinksAddon` (which is why *bare* URLs are clickable).
- **Idea:** Fixed locally with `"FORCE_HYPERLINK": "1"` in the `env` block of
  `~/.claude/settings.json` (scoped to Claude Code; a machine-wide env var would force
  hyperlinks on every CLI). Worth asking Orca to set `FORCE_HYPERLINK` itself when it launches
  an agent, and/or asking Anthropic to add `Orca` to the allowlist. Note Claude Code checks an
  embedder handshake (`attacherCaps.hyperlinks`) *before* the env var, so if Orca ever declares
  that capability explicitly it wins over `FORCE_HYPERLINK`.
- **Context:** Found 2026-07-28 while reporting BL-16618 links; guidance to prefer bare URLs in
  chat replies added to `TEAM-AGENTS.md` regardless, since it survives copy-paste and doesn't
  depend on the reader's terminal.

## 2026-07-23 — nx test runner hangs with no output; direct vitest is instant

- **Cut:** Running a package's tests through nx (`npm run … testonce` → `nx vite:test`, or
  `nx run-many --target test`) produced **zero output for 7+ minutes** while the node process
  stayed alive — indistinguishable from a hang. The identical suite run directly with
  `npx vitest run --config vitest.config.ts` (cd'd into the package) finished in ~4s. Made
  preflight's fast gate and full-suite steps unusable through nx.
- **Idea:** Figure out whether it's the nx daemon on this machine or output buffering in nx's
  task runner — try `nx reset`, `NX_DAEMON=false`, or check the daemon logs. If it's chronic,
  teach the preflight/run skills to fall back to per-package `vitest run` (the workaround used
  here) instead of going through nx.
- **Context:** Preflight run on EthnoLib (worktree `C:\dev\EthnoLib.worktrees\next`, PR #150),
  Windows 11, nx 20.4.6. Workaround: loop over packages, `cd $pkg && npx vitest run --config
  vitest.config.ts`.
- seen again: 2026-08-12 (EthnoLib CharacterVariants branch, Hatton's machine) — `nx run-many
  --target=test` over two packages overran a 10-minute timeout while per-package `npx vitest run`
  took ~2s each; NX_DAEMON=false did not help the test target. Same workaround.

## 2026-07-18 — One shared local Supabase stack, many parallel agents

- **Cut:** Parallel agents (and sessions) all share the single local Supabase stack for
  bloom-core-supabase. One agent's `supabase db reset` + reimport wiped another agent's
  in-place data scrub mid-task (books went 699→0→699 under it); the second agent only
  succeeded because it made its scrub idempotent and re-ran in a tight window.
- **Idea:** Treat the local stack as a shared resource: a convention (announce resets in the
  workspace, or a lock file), or per-task throwaway stacks/DBs for destructive ops
  (`supabase db reset` should be the exception, not a casual verify step).
- **Context:** bloom-core-supabase readiness work 2026-07-18; CI-fixture agent vs a
  concurrent reset during B-track parallelism.

## 2026-07-18 — Background subagents go idle without delivering their final report

- **Cut:** Claude Code background agents (Agent tool) frequently finish and emit only an
  `idle_notification` — the final report never arrives until the coordinator sends a
  SendMessage ping asking for it, which then works immediately. Hit 5 times in one
  session (roughly half of all spawned agents); each costs a round-trip and user-visible
  delay.
- **Idea:** Investigate whether this is a harness bug or a prompt-shape issue (agents may
  be ending on a tool call instead of final text). If prompt-shape: add a standard
  "your final message must be the report, output it as plain text last" line to our
  agent-spawning conventions; if harness: report upstream.
- **Context:** bloom-core-supabase readiness session 2026-07-18, agents on sonnet+opus.
- seen again: 2026-07-18 (decisions round) — opus agent idled twice without its report even
  after a SendMessage ping; coordinator gave up and read the working-tree diff instead,
  which worked fine as a fallback. The "final message must be the report" prompt line was
  present and did not help.

## 2026-07-18 — Orca worktree rm hangs on zombie PTYs; workaround is sending "exit"

- **Cut:** `orca worktree rm --force` fails with "Timed out waiting for physical PTY
  teardown" / "Failed to physically stop every PTY" even after `orca terminal stop` and
  `orca terminal close` both report success (`ptyKilled: true`); the terminals stay listed as
  `connected: true` and the worktree dir stays locked (cwd of the live shell).
- **Idea:** Report upstream to Orca. Until fixed: `orca terminal send --text "exit" --enter`
  to each stuck shell (send `/exit` first if a TUI agent like claude is running in it), then
  `worktree rm` succeeds and locked dirs become deletable.
- **Context:** Hit removing failed SupabaseMigration worktrees of the blorg repo (Windows,
  Git Bash PTYs).

## 2026-07-17 — Machine-wide SUPABASE_* env vars silently redirect tools to a cloud project

- **Cut:** John's machine has global `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env vars
  pointing at a real cloud Supabase project (live service key). Any tool reading the
  conventional `SUPABASE_*` names targets that project instead of the local stack — the new
  sync-tool in bloom-core-supabase nearly wrote sample data into it before a Parse-side error
  stopped the run.
- **Idea:** Tools should use app-specific env names (sync-tool now uses `SYNC_*`) and refuse
  non-localhost writes without an explicit opt-in flag. Also review whether those global env
  vars should be removed from the machine (deploy creds belong in per-repo `.env` files).
- **Context:** Hit while building `packages/sync-tool` in bloom-core-supabase (Local
  Supabase + Blorg milestone).

## 2026-07-14 — plannotator-last shows a blank page when reviewing plans

- **Cut:** `/plannotator-last` runs `plannotator annotate-last`, which annotates the *last
assistant chat message*. After plan-mode work the last message is often a one-liner, so the
review page looks empty/broken; one invocation also died with exit code 4 after an
interrupted turn, and retries left multiple zombie plannotator instances on different ports.
- **Idea:** Teach the skill (or the CLI) a plan-file mode: `plannotator annotate-last --stdin --gate < <plan-file>` works today; the skill could locate the current session's plan file
automatically, kill stale instances, and print the localhost URL.
- **Context:** Hit while reviewing the AI-source-bubbles batch plan in BloomDesktop.
- **Cut:** An agent driving Bloom (or another GUI app) gets stuck because a native dialog box
opened that it doesn't see; John has to notice and dismiss it by hand.
- **Idea:** Detection/notification: a watcher that spots unexpected top-level windows/dialogs
during agent runs and either alerts John or auto-dismisses known-safe ones; or make the
run-bloom skill screenshot-check for dialogs when the app seems unresponsive.
- **Context:** Recurring across agent sessions driving Bloom.exe/WebView2.

## 2026-07-14 — xlf-strings skill overstates the risk of editing a translated `<source>`
- **Cut:** The `xlf-strings` SKILL.md says to never change the source text of a translated
  entry and to instead use the "mark obsolete + new id" pattern. But per
  `DistFiles/localization/README.md` + the current `crowdin.yml` (`update_option:
  update_without_changes`), editing a `<source>` does **not** affect the translation, while
  changing the **id** is exactly what deletes a target translation. So for a pure text tweak
  the skill's recommended fix (new id) is the *destructive* option, and the in-place edit is
  safe. Devin flagged an in-place source edit as a translation-loss bug (BL-16548, PR #8062);
  it was a false positive under our Crowdin config.
- **Idea:** Update `xlf-strings` SKILL.md to reflect the `update_without_changes` reality:
  distinguish id changes (destructive) from source-text edits (safe here), and stop
  recommending obsolete+new-id for spacing/wording tweaks of an existing key.
- **Context:** BL-16548 dialog title "Open/Create" -> "Open / Create Collections".

## 2026-07-29 — The Read tool renders `//` as `\` in some source files, so comments look like syntax errors
- **Cut:** Reading `packages/lib/src/4-generate-html/html-generator.ts` with the Read tool, several
  line comments came back with the `//` replaced by a single backslash — e.g.
  `const MARGIN_PX = 12 * MM_TO_PX; \ --page-margin: 12mm` and
  `return i < count - 1 ? 1 \ 2 ** (i + 1) : 1 / 2 ** i;`. Both are valid `//` in the file
  (confirmed with `grep | cat -A`). The mangling is *inconsistent within one Read* — some `//`
  survive, some don't — and it lands on real code (`1 \ 2 **` reads as a broken expression), so I
  stopped mid-investigation to check whether the repo was actually corrupt.
- **Idea:** Worth reporting upstream as a Read/display bug. Meanwhile: if a Read shows a lone `\`
  where an operator or comment marker belongs, don't trust it — confirm with `grep -n … | cat -A`
  before concluding the source is broken. Never "fix" such a line based on Read output alone; an
  edit built on the mangled text would corrupt a file that was fine.
- **Context:** investigating a BloomBridge origami/overflow bug; reading `HtmlGenerator.pagePx` and
  `origamiPaneRect`.

## 2026-07-29 — The YouTrack Bot account cannot set Assignee at all, and no skill says so
- **Cut:** Asked to file a card "assigned to me", I created it fine (Type, Kanban Board, State all
  set via `$YOUTRACK_BOT`) but every attempt at Assignee returned
  `400 {"error_description":"Assignee expected: <whatever I passed>"}`. Not a syntax problem: the
  Bot has no read access to the user directory, so it cannot *resolve* any assignee. Evidence —
  `GET /api/users` returns only `Bot` itself; the Assignee values on existing issues all come back
  as `anonymized-6104`, `anonymized-8057`, …; `commands/assist` on `"Assignee "` offers no user
  completions at all; and even `Assignee Bot` fails. I burned a round of guesses on plausible
  logins (`JohnHatton`, `jhatton`, `john_hatton`, `hatton`, `John.Hatton`, the email) before
  testing `Bot` and realising the account is the limitation, not the value.
- **Idea:** `youtrack-create-issue` should say up front that **Assignee is not settable by the Bot**
  — set Type/board/State, then hand the user the link and ask them to assign (one click), rather
  than letting an agent discover it by trial and error. Same for `youtrack-api` §fields. If we do
  want agents to assign, that needs a token with user-directory read, and the skill should name it.
  Worth also noting the anonymization, since it makes *any* "who is on this card" question
  unanswerable through the Bot.
- **Context:** filing BL-16627 (Bloom auto-fit origami splits) with State=In Progress, requested
  "assigned to me".

## 2026-08-04 — `node -e` from the Bash tool: output can vanish, and module resolution follows the script, not cwd
- **Cut:** Wanted a quick "does this LESS still compile" check. `node -e "…"` with a multi-line
  double-quoted script returned *no output at all* twice (exit 0, empty), so the check looked like
  it had silently succeeded when it had not run; the identical logic in a single-line form printed
  fine. Then, moving the script to a `.cjs` file in the scratchpad, `require("less")` failed with
  MODULE_NOT_FOUND — node resolves from the *script's* directory, and the scratchpad has no
  `node_modules`. Also worth knowing: `npx prettier` dies on this repo with `EBADDEVENGINES`
  (devEngines pins node 24.13.0, machine has 24.15.0); `pnpm exec prettier` works.
- **Idea:** For any throwaway node script that needs the project's deps, write the `.cjs` **inside
  the package directory** (`src/BloomBrowserUI/`), run it, and delete it — don't use the scratchpad,
  and don't trust a silent `node -e`. Have it write results to a file and `cat` that, so "no output"
  can't be mistaken for "passed". And reach for `pnpm exec`, never `npx`, in this repo.
- **Context:** verifying that a new `inlineImages.less` partial compiled into basePage.css,
  basePage-legacy-5-6.css, baseEPUB.css and editMode.css during the inline-images work.

## 2026-08-06 — Chrome MCP `computer` screenshots dead in this session; `chrome-devtools-cli` covered for it
- **Cut:** Every `mcp__claude-in-chrome__computer` action with `action: screenshot` failed with
  "Script injection timed out after 5000ms — the page is busy or mid-navigation", including on a
  freshly-loaded `https://example.com` in a brand new tab. So it was not the page: the extension's
  capture path was simply broken for the whole session. `javascript_tool`, `navigate`,
  `read_console_messages` and `tabs_*` on the *same* tab all worked fine throughout, which makes the
  failure easy to misread as "my app is hanging" and send you debugging a nonexistent render loop.
  I burned several round trips proving the page was idle (patched `console.log` and counted calls
  over 1s: zero) before concluding the tool was at fault.
- **Idea:** When `computer screenshot` times out, don't debug the page — first sanity-check the tool
  against `example.com` in a new tab. If that fails too, fall back to the `chrome-devtools-cli`
  skill: `chrome-devtools new_page <url>` then `chrome-devtools take_screenshot --filePath <png>`
  worked first try. Two gotchas with that fallback: it drives its **own** Chrome instance (separate
  profile, so localStorage from the extension-driven tab is not there — seed it with
  `evaluate_script`), and `evaluate_script` rejects a multi-line arrow function ("Unexpected token
  ')'"), so collapse the script to one line before passing it. Remember `chrome-devtools stop` at
  the end; `new_page` also holds the terminal until the daemon is stopped, so run it backgrounded.
- **Context:** verifying the config-r prototyper's three-pane layout (Phase 0 + 1) in the browser.

## 2026-08-13 — The Edit tool cannot touch a line containing a zero-width character
- **Cut:** ESLint's `no-irregular-whitespace` flagged a literal U+200B in a spec assertion
  (`expect(entries).not.toContain("​")` written with the real character). Every attempt to
  replace it with `Edit` failed: pasting the line into `old_string`/`new_string` loses the
  zero-width character somewhere between reading the file and the tool comparing strings, so the
  call comes back "No changes to make: old_string and new_string are exactly the same" — even
  though the file on disk plainly differs from what I asked for. `Read` shows the line; the
  invisible character just doesn't survive the round trip. Three wasted calls, and the failure
  message actively misleads (it says my two strings match, not that the *file* couldn't be
  matched).
- **Idea:** Don't try to edit a line whose content includes an invisible or zero-width character.
  Patch it from the shell against the code point instead — in PowerShell:
  `$t=[IO.File]::ReadAllText($p); $t=$t.Replace("x$([char]0x200B)x", 'escaped'); [IO.File]::WriteAllText($p,$t)`
  — then grep to confirm. Better still, write such characters as `\uXXXX` escapes in the first
  place; lint requires it anyway.
- **Context:** the SLDR alphabet provider's spec, asserting that a language's auxiliary exemplar
  set (which for Thai is a lone zero-width space) stays out of the alphabet.

## 2026-08-13 — `npm -C <pkg> exec -- vite` starts vite with the *repo root* as cwd
- **Cut:** To run a package's dev server on a fixed port I used
  `npm -C components/fonts/react/font-chooser-react-mui exec -- vite --port 5390 --strictPort`.
  Vite started and printed a normal "ready in 144 ms / Local: http://localhost:5390/" banner, but
  every request to `/` came back 404. `-C` sets npm's own prefix, not the child process's working
  directory, so vite resolved its config relative to the repo root, found none, and served the
  monorepo root as a static site — where there is no `index.html`. The banner gives no hint: it
  looks exactly like a healthy server, and the 404 reads as a routing or build problem in the app.
- **Idea:** Point vite at the config by absolute path instead — `npx vite --config
  D:/<repo>/<pkg>/vite.config.ts --port <n> --strictPort` — which works because these configs set
  `root: __dirname`. Same shape for any tool that discovers config from cwd; `-C`/`--prefix` is not
  a `cd`, and the team rule against `cd` in shell tools means the flag is the fix, not a directory
  change.
- **Context:** browser-verifying the font chooser's sample-text provenance work.

## 2026-08-13 — A backgrounded PowerShell command looks hung when its output is piped to `Select-Object -Last`
- **Cut:** I ran `npm run testonce 2>&1 | Select-Object -Last 30` to keep a noisy nx/vitest run
  short. It exceeded the 300s tool timeout, moved to the background, and its output file stayed
  completely empty for another five minutes. Everything pointed at a hang — an nx daemon waiting on
  stdin, a prompt nobody could answer — and I killed it and started diagnosing the wrong problem.
  Nothing was wrong: `Select-Object -Last N` cannot know which lines are the last ones until the
  stream ends, so it buffers the whole run and emits nothing until the command exits. The run had
  in fact finished successfully at the moment I killed it.
- **Idea:** Never pipe a long-running command through `Select-Object -Last` (or `Sort-Object`, or
  anything else that must see the whole stream) when the command might be backgrounded. Let it
  write raw and read the tail of the output file afterwards, or use `Select-Object -First`/
  `Where-Object`, which stream. Corollary for reading the result: an empty background output file
  proves nothing about whether the process is alive.
- **Context:** running the font packages' vitest suites while implementing the chooser's
  auto-download work.

## 2026-08-16 — Chrome screenshots time out on a busy page, and `find` goes with them
- **Cut:** On the font-chooser demo, every `mcp__claude-in-chrome__computer` screenshot failed with
  "Script injection timed out after 5000ms" and `find` with "Page still loading (executeScript
  waited 45000ms for document_idle)" — for ten minutes, on a page that was rendering perfectly and
  responding to input. The page never reaches `document_idle` because the demo keeps fetching
  (sample text, Fontsource, font files), and the two tools that need script injection at idle are
  the two an agent reaches for first. The messages both blame loading or navigation, so the obvious
  reading is "the app is broken", and I nearly went diagnosing an app that was fine.
- **Idea:** `javascript_tool` does not wait for idle and kept working throughout. On a page with
  ongoing network activity, drive it with `javascript_tool`: `document.body.innerText` in place of a
  screenshot, `element.click()` and a native-setter `input` dispatch in place of clicks and typing.
  For verifying *rendering* — the thing a screenshot is actually for — `canvas.measureText` with
  and without a font in the stack proves which font drew a character, which is stronger evidence
  than looking at a picture anyway.
- **Context:** verifying an "Add font from URL" dialog and a tofu-fallback font in the EthnoLib font
  chooser demo.

## 2026-08-17 — Spawning `npx` from a Node script on Windows: both obvious ways fail
- **Cut:** A skill script needed to run `npx supabase db query ... "<sql>"`. `execFileSync("npx",
  [...], {shell: true})` let the shell re-parse the SQL argument, so its quotes and newlines came
  back as garbage flags and the CLI answered by printing its own help — which reads as "you called
  it with the wrong flags", not as a quoting problem, and sent me looking at the wrong thing.
  Dropping the shell and calling `npx.cmd` directly then failed with `spawnSync npx.cmd EINVAL`,
  because Node (since the Windows argument-injection fix in 18.20/20.12) refuses to spawn `.cmd`
  without `shell: true`. So on Windows you cannot have both a shell-free spawn and a `.cmd` shim.
- **Idea:** Keep `shell: true` and make sure no argument needs quoting: write SQL (or any
  multi-line/quoted payload) to a file and pass `-f <file>`, and wrap every path argument in
  double quotes yourself. Same shape applies to any `.cmd`/`.ps1` shim — npm, pnpm, vercel, tsc.
- **Context:** building the `feedback-from-font-chooser` skill, which dumps the font chooser demo's
  Supabase feedback rows verbatim.
