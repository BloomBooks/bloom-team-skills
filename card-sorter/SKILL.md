---
name: card-sorter
description: Sort the YouTrack cards on a release's board into where each should go (stay, next release, Issues We'll Live With, close), in a local app that shows an analysis of each card and pushes the developer's decisions back to YouTrack. Use when the developer wants to triage or split a release board, or to reopen the Card Sorter on one they started.
---

# Card Sorter

A local web app for deciding, card by card, where each card on a release's board goes. Each card
shows its description, comments, images, links, existing PRs and branches, and an analysis
(benefit, risk, size, a proposal). The developer moves cards between columns and orders them. The
Synchronize button pulls the board again and pushes the decisions to YouTrack after the developer
confirms the list of changes.

## Files

- `server.mjs <dataDir> [port]` serves the app (default port 5177) and saves decisions. Its
  header describes the data folder.
- `youtrack.mjs`: the only code that talks to YouTrack, as the Bot account (through
  `bloom-services`, so it needs only `gh` signed in):
  `pull` re-extracts the cards, `push` applies a confirmed plan.
- `app/`: the page.
- `analysis-brief.md`: a model brief for the analysis agents, with placeholders for the board's
  facts and the rules that judged the 6.6 split.

## Set up a board

1. **Make the data folder** outside every repo, e.g. `<worktree>/output/split-<release>/`, with
   `raw/youtrack.json` holding `{"cards": []}`.
2. **Write `config.json`** in it when the columns differ from the defaults in `server.mjs`
   (`defaultConfig`: every BL card in Incoming, the 6.6 and 6.7 boards, Issues We'll Live With,
   Close / done, Come back later). Each column names a Kanban Board value and a State. A column
   with `anyBoard: true` names only a State and holds every card of `pull.project` in that state,
   on any board or none; keep it whenever you write your own columns, so the developer sees what
   is still waiting in Incoming.
3. **Start the server** in the background: `node <this folder>/server.mjs <dataDir>`, and give the
   developer the URL. Press Synchronize, or ask the developer to, to pull the cards in.
4. **Add the context** the analysis reads, in `raw/`: `prs-<repo>.json` from
   `gh pr list --repo BloomBooks/<repo> --state all --limit 300 --json number,title,headRefName,state,isDraft,url,updatedAt`
   and `branches-<repo>.txt` from `git ls-remote --heads`, for the repos the cards touch.
5. **Analyze the cards.** Write a brief for this board from `analysis-brief.md`, with the
   developer's own rules for judging cards. Split the cards into batches of about 30 and give each
   batch to a subagent that writes `analysis/part-<n>.json`. The page reloads as each part lands.
   Every card has an analysis when you are done.

## While the developer sorts

The page reloads itself when the app's files or the data change, so edits show at once.
Decisions are saved in `decisions.json` as the developer makes them, and so are tag changes made in
the card's details (the chips' ×, or the "Add a tag" box). YouTrack changes only when
the developer presses "Push to YouTrack" after reading the list of changes. A card that has left
the board's states in YouTrack drops out at the next Synchronize.

Card order within a column goes to YouTrack through `issueOrder`, an undocumented board request
copied from YouTrack's own board page (`youtrack.mjs`). It is refused while the board sorts by a
query.
