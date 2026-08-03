Note: When resolving a git merge conflict in this file, keep both sides' entries unless they can be merged. See the "papercuts" skill for more info.

---

## 2026-08-03 — githack serves 403/404 for dev-process-artifacts while GitHub Pages works

- **Cut:** After pushing a fresh preflight report to dev-process-artifacts, the "default"
  `raw.githack.com/main/...` URL gave the user a 404 in the browser, and both it and the
  commit-pinned `rawcdn.githack.com/<sha>/...` URL returned 403 to curl — while
  `raw.githubusercontent.com` served the file fine (200) and the GitHub Pages URL worked
  immediately. So the link posted to the YouTrack card was dead until replaced.
- **Idea:** Flip `dev-process-artifacts.md`'s recommendation: make GitHub Pages the default
  target (first-party, no third-party proxy, worked when githack didn't) and githack the
  instant-but-flaky alternative — or at least have publishers verify the URL with a HEAD
  request before posting it anywhere.
- **Context:** Hit 2026-08-03 during preflight on BloomDesktop BL-16627-process-book (PR 8135).

---

## 2026-07-30 — a `cd` in the Bash tool silently moves the PowerShell tool's cwd too

- **Cut:** The Bash and PowerShell tools share one working directory, so a throwaway
  `cd <somewhere> && grep …` in a Bash call leaves *every later PowerShell call* in that
  directory. The failure surfaces far from the cause and looks like a broken repo: `vp test run
  packages/lib` died with `Startup Error … Projects definition references a non-existing file or
  a directory: D:/BloomBridge/test-outputs/fix-cover-credits/in/bench`, because root
  `vite.config.ts`'s `test.projects` are resolved relative to cwd. Nothing in that message hints
  at "you are in the wrong directory". Confusingly, Bash *sometimes* prints
  `Shell cwd was reset to <repo>` after a `cd` and sometimes doesn't, so you can't tell from the
  transcript whether the cwd leaked.
- **Idea:** Never `cd` in either shell tool — both are already launched in the repo root, and
  absolute paths work everywhere. Worth a line in TEAM-AGENTS.md next to the existing
  "never mix shell syntaxes" rule, since this is the same class of trap (two shell tools that
  look independent but aren't). Belt-and-braces for agents: start any PowerShell call that runs
  `vp`/`pnpm` with `Set-Location <repo root>`.
- **Context:** Hit 2026-07-30 on BloomBridge (`master`) while verifying a Stage 4 cover-credits
  fix; cost a confusing detour into "did I break vitest discovery?".

---

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

## 2026-07-27 — reviewable CLI rejects JSON piped from Windows PowerShell (BOM)

- **Cut:** Piping a JSON body to `reviewable review discussions reply` from Windows PowerShell
  5.1 fails with `Expected valid JSON on stdin: Unexpected token '﻿'` — the PowerShell pipe
  prepends a UTF-8 BOM even with `$OutputEncoding` set to BOM-less UTF-8.
- **Idea:** Note the working pattern in the reviewable-replies skill: write the JSON to a file
  and run `cmd /c "reviewable ... < file.json"` (raw stdin redirect, no BOM).
- **Context:** BloomDesktop PR #8100 preflight, 2026-07-27; also hit the CLI's 1.0.1-outdated
  warning (updated to 1.0.3 on this machine the same day).

## 2026-07-24 — Devin polling silently reads about:blank when its isolated tab disappears

- **Cut:** Two related cuts in the `devin-review` browser loop. (1) `chrome-devtools new_page
  <devin url> --isolatedContext devin-noauth` **never returns** — it opened the tab fine but the
  CLI call hung until the 300 s tool timeout, twice. (2) Mid-run, the `devin-noauth` tab
  vanished; `evaluate_script` then ran against the leftover `about:blank`, where the
  same-origin fetch fails, so 14 consecutive poll iterations returned empty strings that look
  identical to "no job yet". Six minutes burned before I checked `list_pages`.
- **Idea:** The skill tells you to verify `location.pathname` every iteration (good) — extend
  that to say what to do when the tab is *gone* rather than merely drifted (reopen it), and to
  run `new_page` as a background/fire-and-forget call since it may not return. A one-line
  "empty result means the tab, not the job" note would have saved the whole detour.
- **Context:** BloomDesktop PR #8107 preflight, 2026-07-24; chrome-devtools CLI 1.2.0.

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


## 2026-07-27 — "another agent already did this" is answerable from the session transcripts
- **Cut:** John said a previous session had built a feature that visibly wasn't working, and
  I started re-deriving what that session must have done from the code alone. The session
  transcripts are right there — `~/.claude/projects/<repo-slug>/*.jsonl`, one JSON object
  per line with `type`, `timestamp`, and `message.content` — so `grep -c <symbol> *.jsonl`
  finds the session in one command and a tiny Python filter over `type == "user"` /
  `"assistant"` prints the actual requests and claims. That turned a speculative "here's
  what probably happened" into the real answer: the agent had built and tested the feature
  entirely against synthetic fixtures it generated, written the disconfirming fact ("a
  vision pass would be the only option for a scan with no text layer") into its own
  sign-off as a footnote, and never once run the code against the book that motivated it.
- **Idea:** Note the transcript location + the grep/filter recipe somewhere agents will see
  it (TEAM-AGENTS.md or a `session-history` skill), so "what did the last agent actually do
  and verify?" is a lookup rather than a guess. Corollary worth stating in the same place:
  when a feature is built for a specific artifact, running it against that artifact is part
  of the work, not a nice-to-have.
- **Context:** BloomBridge paragraph indent/spacing detection — shipped reading the PDF text
  layer, while the book that prompted it is a pure scan with zero text items on every page.

## 2026-07-28 — Review sub-agents can stall indefinitely with no way to see progress
- **Cut:** During a `preflight` run the light-review sub-agent never returned. After ~50 min I
  nudged it via `SendMessage`, got nothing, dispatched a second, tightly-scoped one with an
  explicit "return in ~15 tool calls" budget, and that stalled the same way. There is no way to
  poll a running sub-agent's progress or partial output — you only ever get the completion
  notification — so a stalled agent is indistinguishable from a slow one, and it silently blocks
  the phase that depends on it. I finished by doing the review pass myself, which worked fine and
  would have been faster from the start.
- **Idea:** Either (a) give `preflight`'s local-review step an explicit wall-clock budget with a
  documented fallback ("if the sub-agent hasn't returned in N min, do the pass inline and say so
  in the reviewer row"), or (b) find out whether sub-agent partial output is inspectable
  anywhere on disk (the way background Bash tasks write to a task output file) and document the
  path. Right now every skill that fans out to a review agent has this failure mode.
- **Context:** preflight on BloomDesktop PR #8117 (MXB-More-PageOptions), two agents lost.

## 2026-07-28 — A piped exit code made a failing `tsc --noEmit` look clean
- **Cut:** I ran `tsc --noEmit -p tsconfig.json 2>&1 | tail -20; echo "tsc exit=$?"` as a
  background Bash task and reported typecheck as clean, because the task's exit code was 0 and
  my `$?` was `tail`'s, not tsc's. `tsc` was actually reporting 13 errors the whole time. The
  errors turned out to be pre-existing and unrelated to the branch, so the conclusion held, but
  the gate row in my report was wrong until I re-read the output file and corrected it.
- **Idea:** Worth a line in TEAM-AGENTS.md (or wherever the quality-gate mechanics live): when a
  gate command's pass/fail matters, never read `$?` through a pipe — use
  `set -o pipefail`, capture the status directly (`cmd > out.txt; st=$?`), or judge by grepping
  the output for the tool's own error format. This bites hardest in `preflight`, whose whole
  output is a table of pass/fail claims.
- **Context:** preflight on BloomDesktop PR #8117; `src/BloomBrowserUI` typecheck.

## 2026-07-28 — Repro steps written from a warm session were missing the one step that matters
- **Cut:** I filed a bug card with repro steps I had never re-run from a cold start. John asked the
  obvious questions — does it need the MXB subscription? the MXB front matter? — and testing
  revealed the steps were wrong in a way that would have wasted a tester's time: the flash needs a
  **fresh book load from disk**. Clicking to another page doesn't show it, and neither does
  selecting a different book and coming back (Bloom keeps the loaded `Book` in memory), so anyone
  following my steps in an already-open Bloom would have concluded "cannot reproduce". Restarting
  Bloom was the missing step. The two things I *had* implied were required (MXB branding, MXB
  xmatter) turned out to be irrelevant — the capture reproduces under Factory xmatter and
  Local-Community branding, because everything load-bearing travels in the book's data-div.
- **Idea:** Add to the bug-filing skills (`youtrack-create-issue`, and the report side of
  `preflight`): before writing repro steps, run them yourself in the state a *tester* will be in —
  cold app, fresh book — and state explicitly what is NOT required, since a reader assumes every
  detail of your setup is load-bearing. If a step can't be verified, say so in the card rather
  than asserting it.
- **Context:** BL-16619, the stale-`overflow`-class red flash found alongside PR #8117.

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
