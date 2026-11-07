# Bloom Worktree

A Worktree tab in Orca's right sidebar. Under the name of the worktree's project ("Bloom" for the
`bloom` repo, "Bloom Team Skills" for `bloom-team-skills`), it shows the Bloom dashboard's row for
the worktree Orca has focused, then the worktree's checkout and its Claude session:

- in a card's worktree, the dashboard's row: the card cell, the Process steps and "Where it
  stands", drawn by the dashboard's own `../row.js` and styled by `../dashboard.css`, without the
  dashboard's Orca button, since the panel is already in Orca;
- the checkout: uncommitted files, unpushed commits, commits behind the base branch;
- the Claude session: its state and last message, with a picker when the worktree runs several,
  and your last three prompts in it, read from its transcript in `~/.claude/projects`. Each
  session's transcript is the one named by the Claude session id that Orca records for its pane
  (`%APPDATA%\orca\agent-hooks\last-status.json`). Orca does not tell plugins which terminal has
  focus, so until you pick one the panel follows the session you last typed a prompt into, and the
  Commit links and the Process buttons type into that session.

The panel shares its code with the dashboard rather than copying it:

| File | Shared with the dashboard |
| --- | --- |
| `../row.js` | draws a row, and applies Orca's live agents to it (`withLiveAgents`) |
| `../dashboard.css` | the styles; `panel.html` adds only the sidebar layout |
| `../row-facts.mjs` | the rules for agents, CI checks, preflight runs, the rows and what the server adds to a row |

`worktree-facts.mjs` (run by `worker.ts`) finds the worktree's row by its path, as the server does,
and reads the card and the PR live from YouTrack and GitHub where the server reads `facts.json`.
It also runs on its own:

```sh
node worktree-facts.mjs D:/BL-16822-Inline-Fixes
```

## Load it

The plugin's folder is `dashboard/` (manifest `../orca-plugin.json`), because Orca lets a panel load
only files inside its plugin's folder, and the panel loads `../row.js` and `../dashboard.css`.

```sh
orca plugin dev load <clone>/dashboard                         # prints the access and a fingerprint
orca plugin dev load <clone>/dashboard --approve <fingerprint>
orca plugin shot local.bloom-worktree --panel worktree --out shot.png
```

The worker reads the user environment variables and PATH folders that Orca's worker process lacks
(`REVIEWABLE_URL`, `YOUTRACK_BOT`, `~/.vite-plus/bin`) from the registry when it starts.
