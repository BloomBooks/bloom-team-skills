# Bloom Worktree

A Worktree tab in Orca's right sidebar. Under the name of the worktree's project ("Bloom" for the
`bloom` repo, "Bloom Team Skills" for `bloom-team-skills`), it shows the Bloom dashboard's row for
the worktree Orca has focused, then the worktree's checkout and its Claude session:

- in a card's worktree, the dashboard's row: the card cell, the Process steps and "Where it
  stands", drawn by the dashboard's own `../row.js` and styled by `../dashboard.css`, without the
  dashboard's Orca button, since the panel is already in Orca;
- the checkout: uncommitted files, unpushed commits, commits behind the base branch;
- the Claude session: its state and last message, with a picker when the worktree runs several,
  and your last three prompts in it, read from its transcript. The panel follows the pane the
  worktree has selected (the one you see in it); a session you pick holds until you move to
  another pane. When the selected pane is no Claude session, it follows the session you last
  typed a prompt into. The Commit links and the Process buttons type into the session it follows.

Where it learns these from depends on the Orca version:

| | Orca that reports it | Older Orca |
| --- | --- | --- |
| A pane's Claude session and transcript | `providerSession` on each agent of `orca worktree ps` | the session id in `%APPDATA%\orca\agent-hooks\last-status.json`, and `<id>.jsonl` in the worktree's `~/.claude/projects` folder |
| The worktree's selected pane | `activeInWorkspace` on a terminal of `orca terminal list` | the selected tab and pane of `--include-visual-layouts`, when the worktree has one tab group |
| A prompt typed onto your own unsent text | refused (`--refuse-draft`), and the panel says so | sent after it, as one prompt |

Either way a prompt goes through `orca terminal send --wait-submit`, which Orca refuses while
Claude asks for permission.

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
(`REVIEWABLE_URL`, `YOUTRACK_BOT`, `~/.vite-plus/bin`) from the registry when it starts. It runs
the `orca` CLI that `ORCA_CLI_COMMAND` names when Orca sets it, so a development build of Orca
answers its own plugins, and otherwise the `orca` on PATH.
