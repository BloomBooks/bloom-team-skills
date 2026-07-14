# Papercuts

Small dev/agent/tooling friction points and improvement ideas — captured in the moment,
fixed later. This file holds cuts about the **environment, machine setup, team workflow, or
agents in general**; cuts about a specific repo go in that repo's own `PAPERCUTS.md`. The full
procedure is the `papercut` skill in this repo.

House rules:

- Add new entries at the **top**, directly under this header block.
- Entry format: `## YYYY-MM-DD — Title`, then `- **Cut:**` / `- **Idea:**` / optional
  `- **Context:**` lines. 2–5 lines total.
- Hit the same cut again? Add a dated `seen again: ...` line to the existing entry instead of
  duplicating it.
- On a merge conflict here, keep both sides' entries.
- Product bugs/features go to YouTrack instead.
- To work through the backlog, run the `papercut` skill in trim mode ("trim the papercuts").
  Fixed, promoted, or stale entries get **deleted** — the log only contains open cuts.

---

## 2026-07-14 — dotnet-watch Bloom launcher silently blocks agent builds

- **Cut:** A `dotnet watch`-based Bloom launcher auto-rebuilds and respawns Bloom.exe on every
  C# source edit; the running exe locks `output\Debug\AnyCPU\Bloom.exe`, so every agent
  `dotnet build`/`dotnet test` fails at the final copy step (MSB3027). Killing Bloom.exe is
  whack-a-mole — the watcher respawns it on the next agent edit. Blocked three agents in one
  session before the watcher (not the exe) was identified as the root cause.
- **Idea:** Agents doing C# work should check for a `dotnet watch` parent when they hit
  MSB3027 (Get-CimInstance parent chain) and surface "stop your watch loop" instead of
  retrying; and/or the run-bloom / watch tooling could park the watcher while agent builds
  run, or build to a separate output dir for tests.
- **Context:** AI-source-bubbles batch work, multiple sub-agents building concurrently.

## 2026-07-14 — plannotator-last shows a blank page when reviewing plans

- **Cut:** `/plannotator-last` runs `plannotator annotate-last`, which annotates the *last
  assistant chat message*. After plan-mode work the last message is often a one-liner, so the
  review page looks empty/broken; one invocation also died with exit code 4 after an
  interrupted turn, and retries left multiple zombie plannotator instances on different ports.
- **Idea:** Teach the skill (or the CLI) a plan-file mode: `plannotator annotate-last --stdin
  --gate < <plan-file>` works today; the skill could locate the current session's plan file
  automatically, kill stale instances, and print the localhost URL.
- **Context:** Hit while reviewing the AI-source-bubbles batch plan in BloomDesktop.

- **Cut:** An agent driving Bloom (or another GUI app) gets stuck because a native dialog box
  opened that it doesn't see; John has to notice and dismiss it by hand.
- **Idea:** Detection/notification: a watcher that spots unexpected top-level windows/dialogs
  during agent runs and either alerts John or auto-dismisses known-safe ones; or make the
  run-bloom skill screenshot-check for dialogs when the app seems unresponsive.
- **Context:** Recurring across agent sessions driving Bloom.exe/WebView2.
