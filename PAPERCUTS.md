Note: When resolving a git merge conflict in this file, keep both sides' entries unless they can be merged. See the "papercuts" skill for more info.

---

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

