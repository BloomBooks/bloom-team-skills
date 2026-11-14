---
name: dashboard
description: Show the developer's dashboard of their in-progress YouTrack cards, a local web page that shows where each card stands in Bloom's process, which ones agents are working and which wait for the developer, and starts each next step in Orca. Use when the developer says "dashboard", "/dashboard", asks which cards to finish first, asks why a row says what it says, or wants another board.
argument-hint: "[Kanban Board, e.g. 6.6, or all, or current; default: leave it as it is]"
---

# Dashboard

The dashboard is a service that runs on the developer's machine while Orca does
(`service/service.mjs`), at http://127.0.0.1:47600/. Orca's Bloom plugin starts it, and it exits
once Orca has quit. It reads YouTrack, GitHub, Reviewable, git,
Orca and Claude Code's hooks, computes every row, and serves the page and Orca's Worktree panel.
No Claude session keeps it running or writes its rows, so this skill only shows it, changes its
board, or sets it up. `README.md` in this folder says how it works: read it when the developer asks
how something on the page behaves, or before changing this folder's code.

## Show it

Run `node <this folder>/service/start.mjs --show` with the **PowerShell** tool. It starts the
service when none runs and brings the dashboard window to the front. Give the developer the URL it
prints. It exits within a few seconds; the service keeps running without it.

When it prints that Orca is not running, tell the developer to start Orca: the service runs only
while Orca does.

When it prints that the service did not start, read the last lines of
`~/.claude/bloom-dashboard/service.log` and tell the developer what they say.

## Which board

`/dashboard <board>` shows the cards whose YouTrack `Kanban Board` field is that value:
`node <this folder>/service/start.mjs --show --board "<board>"`. A bare version number means
`Bloom <version>`, `all` shows every board, and `current` picks the unarchived `Bloom <version>`
board with the most cards updated in the last 14 days. With no argument, leave the board as it is.

## Set it up, or repair it

Run `node <this folder>/service/install.mjs` when the developer has not had the dashboard on this
machine, or when the page's Service indicator says that no Claude Code hooks arrive or that the
Orca plugin is not connected. It writes Claude Code hooks into `~/.claude/settings.json`, starts
the service when Orca is running, and loads the Bloom plugin into Orca.
`update-team-skills` and its daily auto-update run the same script.

Exit code 3 means that Orca has not approved the plugin, and the output lists the access it asks
for. Show that list to the developer and ask whether to approve it; on a yes, run the script again
with `--approve`. The approval is the developer's to give: the plugin runs code under their
account.

## Why does a row say that

Each row has a "Why?" under "Where it stands": the rule that put the card in its state, each fact
with where it came from and how old it is, and the latest events in its worktree. Read it there
first. `GET /state` with the header `x-bloom-key` (the content of
`~/.claude/bloom-dashboard/service.key`) returns the same rows as JSON, and
`~/.claude/bloom-dashboard/service-events.jsonl` holds every event.
