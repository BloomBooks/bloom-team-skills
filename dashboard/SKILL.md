---
name: dashboard
description: Build or refresh the developer's dashboard of their in-progress YouTrack cards, a local web page that groups each card by how close it is to review, shows live which ones agents are working and which are waiting for the developer, and opens each worktree in Orca. Use when the developer says "dashboard", "/dashboard", asks which cards to finish first, or asks to keep the board up to date while agents work.
argument-hint: "[Kanban Board, e.g. 6.6, or all; default: the current version]"
---

# Dashboard

`server.mjs` serves `board.html` at http://127.0.0.1:47321/ for as long as the Claude session that
started it is open. The page's buttons ask the server to switch Orca to a worktree or create one,
and the server shows each agent's live state from Orca. The session decides what each row says
and writes it to a file.

## Which board

`/dashboard <board>` limits the board to cards whose YouTrack `Kanban Board` field is that value,
for example `/dashboard 6.6` (a bare version number means `Bloom 6.6`) or `/dashboard "Bloom 6.7"`.
`/dashboard all` shows cards from every Kanban Board. With no argument, `gather.mjs` picks the
current version: of the unarchived `Kanban Board` values named `Bloom <version>`, the one with
the most BL cards (anyone's) updated in the last 14 days. It prints the counts; tell the developer
which board it chose and that `/dashboard <board>` picks another. Keep using the same board for
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

Run `node gather.mjs ~/.claude/bloom-dashboard/facts.json [board]` from this folder (about 15 s),
passing the board from "Which board" when there is one. The server compares its own later gathers
with this file (step 5), so write it there. It writes:

- `cards`: every unresolved card assigned to the developer, plus every card named by a worktree's
  branch, with its State;
- `worktrees`: each Orca worktree whose branch or path names a card: uncommitted files, unpushed
  commits, commits behind the base branch, its own commits, its Orca comment, and its agents, each
  `working`, `waiting` (with the question it is asking) or `done` (with its last message);
- `prs`: the developer's open PRs in the repos those worktrees belong to, with draft state, size,
  mergeability, review decision, requested reviewers, `checks` (`SUCCESS`, `FAILURE`,
  `PENDING`, or `""` with no CI), `report` (the preflight report linked from the PR description)
  and `reportDecisions` (how many decision items that report has; `null` when it could not be
  read);
- `board`: the board it kept, or `null` for every board.

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

**Status** (`who`): `you` only when something names a choice that the developer has to make: the
PR's preflight report has `reportDecisions` above 0, or an agent's last message asks them to
choose between options. State the choice in `next`; the pill reads "Needs your decision". The
next step being theirs is not a decision: a clean preflight report means the PR waits for their
own review, so the row is `idle` and `next` says to review the PR and then run
pr-ready-for-human. Otherwise `idle`, which shows no Status pill. The page overrides this live from Orca: a `waiting` agent in the row's worktree
shows "Claude has a question" with the question, and a `working` one shows "Preflighting" or "Readying for human review" when it was
started on `/preflight` or `/pr-ready-for-human`, and "Agent working" otherwise.

**Next skill** (`nextSkill`): when the next step is to run `preflight` or `pr-ready-for-human`,
name it here as well as in `next`. The page then shows a "Preflight" or "Make ready for reviewer"
button that runs it in the worktree's Claude session.

## 4. Write the rows

The rows live in `~/.claude/bloom-dashboard/`, which the server reads every few seconds:

- `board.json`: `{ "board": "<the facts' board, e.g. Bloom 6.6>" }`, or `""` for every board.
  The page's heading reads "Your active cards for version 6.6" from it.
- `rows/<card id>.json`: one file per card (or a short slug for one cleanup row that lists
  several stale cards). Delete the file of a card that left the board. Rows left by an earlier
  session are claims from then: check every one against the new facts and rewrite it.

| field | content |
| --- | --- |
| `card`, `cardUrl`, `title` | id, YouTrack URL, a short title |
| `ytState` | the card's YouTrack State, shown as a pill beside the id |
| `group`, `order`, `who` | from step 3 |
| `status` | one or two sentences on where it stands now |
| `next` | the next step, or the developer's question |
| `nextSkill` | `preflight` or `pr-ready-for-human`, when the next step is that skill |
| `pr` | PR URL |
| `report`, `reportDecisions` | the PR's `report` and `reportDecisions` from the facts; the page shows a pill linking to the report |
| `worktree` | worktree path; the page shows an "Orca Worktree" button and the path, which opens in VS Code |
| `updated` | ISO timestamp of this write |

Then give the developer the URL and a few lines on what changed, leading with what waits for them.

## 5. Keep it current

The server appends lines to `~/.claude/bloom-dashboard/events.log`, each starting with a card id:

- every 5 s, when an agent in a card's worktree changes state:
  `BL-16775 D:/BL-16775-grade-branding-2: working -> waiting`;
- every 15 minutes it runs `gather.mjs` again for the same board, replaces `facts.json`, and
  writes each difference (`diff-facts.mjs` lists the kinds): a card's State, a new In Progress
  card, a PR's draft state, mergeability, review decision, CI checks or requested reviewers, a PR
  merged or closed, a new or changed preflight report, new commits, a push, a worktree added or removed;
- when the page's Create button makes a worktree: `BL-16549 <path>: worktree created from the
  dashboard`;
- `orca error`, `orca answers again` and `gather error` lines, when Orca or the gather fails.

Start a Monitor on `node <this folder>/watch-events.mjs` with `timeout_ms` 1800000, and re-arm it
when it expires, for as long as the developer wants the board kept live. It saves its place in
the log, so lines written between expiry and re-arm arrive when it starts again.

On an agent line, read what the agent said (`orca worktree ps --json`, that worktree's agents'
`lastAssistantMessage` and `programStatus`) and check the card's State. On a fact line, read the
change from `facts.json`. Then rewrite that row's `status`, `next`, `nextSkill`, `who` and
`group`, and add a row for a card that has become In Progress or Has Comments. Remove the row when
the card has left In Progress and Has Comments. Push a notification when an agent is waiting on
the developer. The page already shows the change of Status on its own, so the row is about what
the agent reported.

Match a worktree line to a row by path, not by the card id in its branch: a PR's branch can name
another card, and the server labels a worktree by the id in its branch. A "created from the
dashboard" line names the row's own card; write its path into that row's `worktree`.

## The buttons

- **Orca Worktree** (on a row with a worktree, and on its Status pill) switches Orca to the
  worktree's agent terminal or, with no agent there, opens a "Claude" terminal running
  `claude --continue || claude`.
- **The worktree's path** opens that folder in VS Code (`code <path>`).
- **Preflight** and **Make ready for reviewer** type `/preflight` or `/pr-ready-for-human` into
  the worktree's Claude terminal, or start one with `claude --continue /<skill>` when there is
  none. When Claude is busy there, the server refuses and the page says so.
- **Create & Open Orca Worktree** (on a row without one) makes a worktree and starts Claude in it.
  With a PR it checks out the PR's branch; without one it makes
  `<card>-<first three words of the title>` from the repo's default base. The server then writes
  a "created from the dashboard" line to `events.log` (step 5).

Every Orca button then launches `Orca.exe` again, which makes the running Orca bring its window to the
front; the CLI alone does not. The server logs each click and its result in
`~/.claude/bloom-dashboard/server.log`. It refuses any request that does not carry the token it
wrote into the page it served, so other web pages cannot drive Orca.
