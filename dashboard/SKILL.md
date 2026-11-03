---
name: dashboard
description: Build or refresh the developer's dashboard of their in-progress YouTrack cards, a local web page that groups each card by how close it is to review, shows live which ones agents are working and which are waiting for the developer, and opens each worktree in Orca. Use when the developer says "dashboard", "/dashboard", asks which cards to finish first, or asks to keep the board up to date while agents work.
argument-hint: "[Kanban Board, e.g. 6.6]"
---

# Dashboard

`server.mjs` serves `board.html` at http://127.0.0.1:47321/ for as long as the Claude session that
started it is open. The page's buttons ask the server to switch Orca to a worktree or create one,
and the server shows each agent's live state from Orca. The session decides what each row says
and writes it to a file.

## Which board

`/dashboard <board>` limits the board to cards whose YouTrack `Kanban Board` field is that value,
for example `/dashboard 6.6` (a bare version number means `Bloom 6.6`) or `/dashboard "Bloom 6.7"`.
With no argument the board shows cards from every Kanban Board. Keep using the same board for
every refresh in the session, unless the developer names another.

## 0. Check the install and find the developer

This folder lives in the bloom-team-skills clone, and Claude Code finds it through a link at
`~\.claude\skills\dashboard` that `update-team-skills` creates. Check that the link is in place:

```powershell
(Get-Item "$HOME\.claude\skills\dashboard" -ErrorAction SilentlyContinue).Target
```

It should print the `dashboard` folder of the bloom-team-skills clone. If the path is missing, run
`update-team-skills`. If the path is a real folder or a link to somewhere else, stop and tell the
developer instead of deleting it.

Then run `node ../developer.mjs` from this folder. It prints who the developer is (their name,
GitHub login and YouTrack login) from `~/.claude/bloom-developer.json`, working out and saving
whatever that file lacks. If it exits with code 2, it could not settle a login; ask the developer
which candidate is theirs and save it with `node ../developer.mjs --set youtrack=<login>`.
Address the developer by the record's `name` in what you write to them.

## 1. Start the server

Start `node <this folder>/server.mjs` as a background task with the **PowerShell** tool
(`run_in_background`). The Bash tool's sandbox refuses listening sockets and reports a clean
exit. Wait for its first line:

- `DASHBOARD_URL http://127.0.0.1:47321/`: give the developer the URL.
- `ALREADY_RUNNING ... pid <pid>`: another Claude session is running the dashboard. Tell the
  developer, and ask whether to stop that pid (`Stop-Process -Id <pid>`) and start this one.
- `PORT_TAKEN`: another program holds the port; start it with `--port <other>` and give that URL.

The server stops when this session ends, and the page then says so.

## 2. Gather

Run `node gather.mjs <scratchpad>/facts.json [board]` from this folder (about 15 s), passing the
board from "Which board" when there is one. It writes:

- `cards`: every unresolved card assigned to the developer, plus every card named by a worktree's
  branch, with its State;
- `worktrees`: each Orca worktree whose branch or path names a card: uncommitted files, unpushed
  commits, commits behind the base branch, its own commits, its Orca comment, and its agents, each
  `working`, `waiting` (with the question it is asking) or `done` (with its last message);
- `prs`: the developer's open PRs in the repos those worktrees belong to, with draft state, size,
  mergeability, review decision and requested reviewers.

It needs Orca running, `gh` signed in as the developer, and `YOUTRACK_BOT` in the User
environment. The search for the developer's cards relies on the Bot holding YouTrack's "Read User
Basic Role" granted globally; granted only on a project, that role's permission does nothing and
the search fails with "The value "<login>" isn't used for the Assignee field".

## 3. Decide each row

A card gets a row only when its State is **In Progress** or **Has Comments**, whatever worktrees
or PRs it has. Every row is a card; a worktree or PR whose card is in any other state stays off
the board.

**Group** (`group`), by how much work stands between the card and human review:

- `near`: a PR of modest size whose bot reviews are clean; a master merge, preflight and
  pr-ready-for-human away.
- `nopr`: work pushed or finished, with no PR yet.
- `large`: a big diff, or blocked on other work (name the blocker).
- `cleanup`: a card that has sat In Progress for years with nothing happening on it.

Order rows within a group (`order`) easiest first.

**Who has it** (`who`): `you` when the card needs a decision only the developer can make, or an
agent is `done` and its result needs them (a reviewer to pick, a promotion to approve); state the
decision in `next` as a question. Otherwise `idle`. The page overrides this live from Orca: a
`waiting` agent in the row's worktree shows "Waiting for you" with the agent's question, and a
`working` one shows "Agent working".

## 4. Write the rows

The rows live in `~/.claude/bloom-dashboard/`, which the server reads every few seconds:

- `board.json`: `{ "board": "<the Kanban Board value, e.g. Bloom 6.6>" }`, or `""` when no board
  was given. The page's heading reads "Your active cards for version 6.6" from it.
- `rows/<card id>.json`: one file per card (or a short slug for one cleanup row that lists
  several stale cards). Delete the file of a card that left the board.

| field | content |
| --- | --- |
| `card`, `cardUrl`, `title` | id, YouTrack URL, a short title |
| `ytState` | the card's YouTrack State, shown as a pill beside the id |
| `group`, `order`, `who` | from step 3 |
| `status` | one or two sentences on where it stands now |
| `next` | the next step, or the developer's question |
| `pr` | PR URL |
| `worktree` | worktree path; the page turns it into an "Open in Orca" button |
| `updated` | ISO timestamp of this write |

Then give the developer the URL and a few lines on what changed, leading with what waits for them.

## 5. Keep it current

The server appends a line to `~/.claude/bloom-dashboard/events.log` whenever an agent in a card's
worktree changes state, such as `BL-16775 D:/BL-16775-grade-branding-2: working -> waiting`.
Start a Monitor on `tail -n 0 -F ~/.claude/bloom-dashboard/events.log` with `timeout_ms`
1800000, and re-arm it when it expires, for as long as the developer wants the board kept live.

On a line, read what the agent said (`orca worktree ps --json`, that worktree's agents'
`lastAssistantMessage` and `programStatus`), check the card's State, and rewrite that row's
`status`, `next` and `who`. Remove the row when the card has left In Progress and Has Comments.
Push a notification when an agent is waiting on the developer. The page already shows the change
of Who on its own, so the row is about what the agent reported.

Match a worktree to a row by path, not by the card id in its branch: a PR's branch can name
another card, and the server labels a worktree by the id in its branch.

## The buttons

- **Open in Orca** (on a row with a worktree, and on its Who pill) switches Orca to the
  worktree's agent terminal or, with no agent there, opens a "Claude" terminal running
  `claude --continue || claude`.
- **Create & Open Orca Worktree** (on a row without one) makes a worktree and starts Claude in it.
  With a PR it checks out the PR's branch; without one it makes
  `<card>-<first three words of the title>` from the repo's default base. Once the worktree
  exists, write its path into the row's `worktree`.
- **Work on this skill in Orca**, at the top, opens the bloom-team-skills clone the same way.

Every button then launches `Orca.exe` again, which makes the running Orca bring its window to the
front; the CLI alone does not. The server logs each click and its result in
`~/.claude/bloom-dashboard/server.log`. It refuses any request that does not carry the token it
wrote into the page it served, so other web pages cannot drive Orca.
