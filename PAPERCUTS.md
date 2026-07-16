Note: When resolving a git merge conflict in this file, keep both sides' entries unless they can be merged. See the "papercuts" skill for more info.

---

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

