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

## 2026-07-10 — Agents get silently blocked by dialog boxes

- **Cut:** An agent driving Bloom (or another GUI app) gets stuck because a native dialog box
  opened that it doesn't see; John has to notice and dismiss it by hand.
- **Idea:** Detection/notification: a watcher that spots unexpected top-level windows/dialogs
  during agent runs and either alerts John or auto-dismisses known-safe ones; or make the
  run-bloom skill screenshot-check for dialogs when the app seems unresponsive.
- **Context:** Recurring across agent sessions driving Bloom.exe/WebView2.
