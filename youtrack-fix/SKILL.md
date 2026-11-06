---
name: youtrack-fix
description: Fix a bug or task tracked on a YouTrack card. Use when the user gives a card id or URL like "BL-1234" and asks for it to be fixed or implemented — read the card, work in this checkout only if it is named for the card or this session already started the card here (otherwise open the card's own Orca worktree and hand the fix to a Claude there), plan, branch, implement, then hand off to preflight. When they only say they want to work on a card ("work on BL-1234", "I want to work on issue BL1234", "start BL-1234"), use work-on-youtrack instead, which opens or creates the card's Orca worktree.
argument-hint: "the card id (BL-xxxxx) or its URL"
---

# Fix a YouTrack card

You will be given a card id starting with `BL-`, or its URL
(`https://issues.bloomlibrary.org/youtrack/issue/<id>`). For *creating* a card see
`youtrack-create-issue`; for *querying* across cards see `bloom-youtrack-reporting`.

1. **Read the card** — summary, description, comments and attachments — through the
   `youtrack-api` skill (the web URL is a SPA and returns blank to a plain fetch).
2. **Decide where to work: here, or in a new worktree.** Look at this checkout
   (`git rev-parse --abbrev-ref HEAD`, `git status --short`, and which repo it is). Work **here**
   only when it is the repo the fix belongs in and either
   - its branch or worktree is named for this card (the card id is in the name), or
   - this session has already started the card in this checkout: it made changes toward it, or
     the developer said to do it here. Having only discussed the card does not count. If that
     work is on a branch named for something else, step 4 moves it to the card's own branch, in
     place, keeping the changes.

   A clean checkout is not a reason to work here: it is often the developer's main checkout, or
   a worktree for other work. In every other case, **move the work to a worktree of its own**,
   and do not plan or change anything here:
   1. Run `node <bloom-team-skills>/work-on-youtrack/work-on-youtrack.mjs <card> --json`, adding
      `--repo <owner/name>` when the fix belongs in a repo other than BloomDesktop (reach the
      script through this file's real path, as with `dev-process-artifacts.md`). It assigns the
      card, finds or creates the card's worktree and branch, starts Claude there, and brings
      Orca to the front. If it fails (the card is someone else's, or Orca lacks the repo), report
      its reason and stop.
   2. If its JSON has a `terminal`, that worktree already had an agent running: leave it alone and
      tell the developer the card is already being worked there. Otherwise find the new Claude's
      terminal (`orca terminal list --worktree path:<worktree> --json`), wait with
      `orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 90000 --json`, and send it
      `orca terminal send --terminal <handle> --text "<brief>" --enter --wait-submit 20 --json`.
      The brief is `/youtrack-fix <card>` plus anything from this conversation it needs (what the
      developer already said about the cause or where the fix goes) and "this worktree and branch
      were made for this card; stay on that branch". Done when the result's stages include
      `turn_started`; if they show only `input_accepted`, reissue the same command with the
      `--retry-request` id it gave (that never sends twice).
   3. Tell the developer which worktree and branch took the card, and stop here.
3. **Plan.** Read the code as needed and write a short plan. Ask the user for anything you need
   clarified, then present the plan and ask whether to proceed. List in it the existing tests
   whose expectations the change will alter, and why. Approving the plan approves changing those
   tests, and only those (see "Changing an existing test needs the developer's approval" in
   `TEAM-AGENTS.md`).
4. **Branch.** The project's `AGENTS.md` names the target branch (and a `[6.X]` prefix on the
   card's summary overrides it — see the repo's issue-tracker section; confirm with the user if
   they disagree); step 2 needs it too. If you are not already on the card's branch, branch off
   that target as `BL-<n>-<one to three words>` (the id first is load-bearing: `preflight` reads
   the card id off the branch name). Uncommitted changes you already made for the card come along
   with `git switch -c`; if the branch you are on has commits that aren't this card's, ask before
   carrying them over.
5. **Implement** the plan, following the repo's `AGENTS.md`, its skills, and its testing rules.
   Keep the change to this card only; other agents may be working in parallel.
6. **Hand off to `preflight`** to commit, push, open the draft PR, run the bots and link the card.
   Do not commit or push outside it unless the user asks.

Never run destructive git operations (`git reset --hard`, `git checkout`/`git restore` to an
older commit, deleting files you did not author) without an explicit written instruction in this
conversation; if in doubt, stop and ask.
