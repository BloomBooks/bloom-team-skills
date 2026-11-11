---
name: card-sorter
description: Sort the YouTrack cards on a release's board into where each should go (stay, next release, Issues We'll Live With, close), in a local app that shows an analysis of each card and makes each of the developer's changes in YouTrack as they make it. Use when the developer wants to triage or split a release board, or to reopen the Card Sorter on one they started.
---

# Card Sorter

A local web app for deciding, card by card, where each card on a release's board goes. Each card
shows its description, comments, images, links, existing PRs and branches, and an analysis
(benefit, risk, size, a proposal). The developer moves cards between columns, tags them, comments on
them and closes them, and each change goes to YouTrack at once.

## Files

- `server.mjs <dataDir> [port]` serves the app (default port 5177) and makes each change in
  YouTrack. Its header describes the data folder.
- `youtrack.mjs`: the only code that talks to YouTrack, as the Bot account (through
  `bloom-services`, so it needs only `gh` signed in): `pull` re-extracts the cards, and there is
  one function for each kind of change.
- `app/`: the page.
- `analysis-brief.md`: a model brief for the analysis agents, with placeholders for the board's
  facts and the rules that judged the 6.6 split.

## Reopen a board

When the developer runs the skill on a board they have already set up (a data folder such as
`<worktree>/output/split-<release>/` with a `decisions.json`), start the server on that folder as
in step 3 below; it opens the tab.

## Set up a board

1. **Make the data folder** outside every repo, e.g. `<worktree>/output/split-<release>/`, with
   `raw/youtrack.json` holding `{"cards": []}`.
2. **Write `config.json`** in it when the columns differ from the defaults in `server.mjs`
   (`defaultConfig`: every BL card in Incoming, the 6.6 and 6.7 boards, Issues We'll Live With,
   Close / done, Come back later). Each column names a Kanban Board value and a State. A column
   with `anyBoard: true` names only a State and holds every card of `pull.project` in that state,
   on any board or none; keep it whenever you write your own columns, so the developer sees what
   is still waiting in Incoming.
3. **Start the server** in the background with the PowerShell tool (the Bash sandbox refuses
   listening sockets): `node <this folder>/server.mjs <dataDir>`. It opens the page in a tab of the
   default browser by itself, so do not leave that to the developer. Press Refresh, or ask the
   developer to, to pull the cards in.
4. **Add the context** the analysis reads, in `raw/`: `prs-<repo>.json` from
   `gh pr list --repo BloomBooks/<repo> --state all --limit 300 --json number,title,headRefName,state,isDraft,url,updatedAt`
   and `branches-<repo>.txt` from `git ls-remote --heads`, for the repos the cards touch.
5. **Analyze the cards.** Write a brief for this board from `analysis-brief.md`, with the
   developer's own rules for judging cards. Split the cards into batches of about 30 and give each
   batch to a subagent that writes `analysis/part-<n>.json`. The page reloads as each part lands.
   Every card has an analysis when you are done.

## While the developer sorts

The page reloads itself when the app's files or the data change, so edits show at once.

Moving a card to a column sets its Kanban Board and State in YouTrack at once, and so do tag
changes and the details' New Comment box (Add posts the comment). Moving a card to Close / done
first shows the comment it will close with, and closes it only on confirmation. After each change
the card is read back from YouTrack and drawn as YouTrack has it; a refused change shows its reason
at the bottom of the page. Undo (u) reverses the last move, close or tag change in YouTrack. Only
Come back later and an unsent comment stay in the sorter alone, in `decisions.json`. Refresh pulls
the board again; a card that has left the board's states in YouTrack drops out then.

Set order puts the cards of each YouTrack board column in the order the sorter shows, through
`issueOrder`, an undocumented board request copied from YouTrack's own board page
(`youtrack.mjs`). It is refused while the board sorts by a query.
