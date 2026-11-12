---
name: work-on-youtrack
description: Take a YouTrack card (assign it to the developer, move it to In Progress) and open its Orca worktree with Claude running in it, creating the worktree (on the card's PR branch, or a new `<card>-<words>` branch) when there is none. Use when the developer says "/work-on-youtrack BL-12345", "I want to work on issue BL16778", "work on BL-12345", "start BL-12345", or asks to open a card in Orca. The card id may come with or without its hyphen. This only gets the worktree ready; to fix the card in the current session, use youtrack-fix.
argument-hint: "<BL-id or YouTrack URL> [--repo owner/name] [--dry-run]"
---

# Work on a card in Orca

`work-on-youtrack.mjs` in this folder does all of it; a Chrome extension button on YouTrack issue
pages runs the same script. Run it with the developer's arguments and report what it prints:

```powershell
node <this folder>/work-on-youtrack.mjs BL-16627
```

Run it in the foreground; it takes 5 to 40 seconds. It needs Orca running, `gh` signed in, and
`YOUTRACK_BOT` set (see `youtrack-api`).

What the script does, so you can explain its output:

1. Reads the card from YouTrack (summary, description, State, Assignee, comments). When the card
   is assigned to someone other than the developer (their login comes from `developer.mjs`), it
   stops there with `work-on-youtrack failed: BL-… is assigned to <name> (<login>), not to you`,
   having opened and changed nothing. Tell the developer who has the card and leave it with them.
2. Finds the card's open PRs: GitHub PR links on the card plus `gh search prs <card>` in
   BloomBooks, keeping open PRs whose title or branch names the card.
3. Finds the card's Orca worktrees (not archived): a branch that, after any `<prefix>/`, starts
   with `<card>-` or is the card id; a branch that is a PR's head branch; or a worktree that
   `orca reference find` returns. With several, it prefers one on a PR's branch, then the one
   with the latest activity, and lists the rest.
4. With a worktree: switches Orca to its Claude terminal, or starts `claude --continue || claude`
   there. Without one: creates it with `createWorktree` from `orca-worktrees.mjs` at the
   repo root (shared with the dashboard), on the PR's branch when there is a PR, otherwise on
   `<card>-<1-3 words>` in `bloombooks/bloomdesktop`, from `origin/master`, or from
   `origin/Version6.5` when the card's title starts with `[6.5]`. When the branch is based on
   anything but master, the new Claude's first message tells the developer which branch it is on. Claude (haiku) suggests the words; when it
   fails or answers with something else, the first three words of the title are used.
5. Assigns the card to the developer when it has no Assignee, and moves it to In Progress when its
   State comes before In Progress (Incoming, Open, Ready For Work, Has Comments). A card in review,
   in testing or closed keeps its State. Both fields are read back. A card it moved to In Progress
   then goes right after the developer's last card in that column of its board (Bloom Kanban, the
   sprint its Kanban Board field names), through the board's `issueOrder` request as the
   `card-sorter` does; with no other card of theirs there it stays where YouTrack put it. Failing
   to place it is reported, not fatal.
6. Asks a running dashboard (the `dashboard` skill) to gather now, so the card appears there
   without waiting for the dashboard's 15-minute gather.
7. Brings Orca to the front.

Options:

- `--repo <owner/name>`: the repo for a new worktree when the card has no PR, and the only repo
  searched for worktrees and PRs. The script never guesses the repo from the card, so if the
  developer names a repo, or the card is plainly about another repo, pass it.
- `--dry-run`: does steps 1 to 3, asks Claude for the words, and prints what it would open or
  create and what it would change on the card. It changes nothing.
- `--json`: one JSON object instead of text (`action` is `open`, `create`, `would-open` or
  `would-create`; `ok: false` with `error` on failure).

On failure it exits 1 with `work-on-youtrack failed: <reason>`. "Orca has no repo for github:<repo>" means
the developer must add that repo to Orca first; pass the reason on rather than working around it.
