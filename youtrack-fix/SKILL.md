---
name: youtrack-fix
description: Fix a bug or task tracked on a YouTrack card. Use when the user gives a card id or URL like "BL-1234" and wants it fixed — read the card, plan, branch, implement, then hand off to preflight.
argument-hint: "the card id (BL-xxxxx) or its URL"
---

# Fix a YouTrack card

You will be given a card id starting with `BL-`, or its URL
(`https://issues.bloomlibrary.org/youtrack/issue/<id>`). For *creating* a card see
`youtrack-create-issue`; for *querying* across cards see `bloom-youtrack-reporting`.

1. **Read the card** — summary, description, comments and attachments — through the
   `youtrack-api` skill (the web URL is a SPA and returns blank to a plain fetch).
2. **Plan.** Read the code as needed and write a short plan. Ask the user for anything you need
   clarified, then present the plan and ask whether to proceed.
3. **Branch.** The project's `AGENTS.md` names the target branch (and a `[6.X]` prefix on the
   card's summary overrides it — see the repo's issue-tracker section; confirm with the user if
   they disagree). Branch off that target as `BL-<n>-<one to three words>` (the id first is
   load-bearing: `preflight` reads the card id off the branch name). If you are in a worktree
   that already carries someone's uncommitted work on another branch, stop and ask before
   switching.
4. **Implement** the plan, following the repo's `AGENTS.md`, its skills, and its testing rules.
   Keep the change to this card only; other agents may be working in parallel.
5. **Hand off to `preflight`** to commit, push, open the draft PR, run the bots and link the card.
   Do not commit or push outside it unless the user asks.

Never run destructive git operations (`git reset --hard`, `git checkout`/`git restore` to an
older commit, deleting files you did not author) without an explicit written instruction in this
conversation; if in doubt, stop and ask.
