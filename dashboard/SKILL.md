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

The Orca plugin in `orca-plugin/` puts a Bloom Dashboard button in Orca's status bar. When this
server answers, the button asks it to show its window (`POST /api/show`): `raise-window.ps1` brings
the window to the front. Closing the window stops the server, so when the server does not answer, the button leaves alone a session that it started under 90
seconds ago, and otherwise opens a background terminal in the bloom-team-skills workspace running
`claude "Open the dashboard"` (no leading slash, which Git Bash would rewrite into a Windows path).
Neither case switches Orca away from the workspace that the developer is in. When it opens the
terminal, it also starts `server.mjs` itself at once, so the window opens within a second or two showing the rows the last session wrote; this
session's server then takes the port over in step 1, and the window reloads onto it. While a
session starts, the button reads "Loading...". A developer loads it once
with `orca plugin dev load <this folder>/orca-plugin --approve <fingerprint>` (`orca plugin
validate` prints what it may do; loading without `--approve` prints the fingerprint).

A second Orca plugin, whose manifest is this folder's `orca-plugin.json` and whose files are in
`worktree-panel/`, shows one row of this dashboard, for the worktree Orca has focused, in a
Worktree tab of Orca's right sidebar, with the worktree's Claude session and the developer's last
three prompts in it. It needs no server; `node worktree-panel/worktree-facts.mjs <worktree path>`
prints what it shows. The page and the panel share their code: `row.js` draws a row and applies
Orca's live agents to it, `dashboard.css` styles both, and `row-facts.mjs` holds the rules that
the server, `gather.mjs`, `progress.mjs` and the panel's worker apply to agents, PRs, preflight
runs and rows. Change a row's look or rules there, not in a copy. The plugin's folder is this
whole folder because Orca lets a panel load only files inside its plugin's folder.

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

Then check for the Bloom Dashboard button: `orca plugin list` should list `local.bloom-dashboard`
as `running`. When it is missing, or Orca says it needs approval (a pull changed its access or
its button), offer it in the message that ends step 4, not before, so the dashboard opens first:
say in one line that a status-bar button in Orca opens the dashboard and ends its session when the
window closes, and ask whether to load it. On a yes, run `orca plugin dev load <this
folder>/orca-plugin`, show the developer the access it prints, and only when they agree run it
again with `--approve <fingerprint>`. The approval is the developer's to give: the plugin runs code
under their account. Offer it once per session, and skip all this when `orca` is not installed.

## 1. Start the server

Start `node <this folder>/server.mjs` as a background task with the **PowerShell** tool
(`run_in_background`). The Bash tool's sandbox refuses listening sockets and reports a clean
exit. Once listening, the server opens the page in a Chrome app window, a window of its own with
its own taskbar button, so do not open the URL yourself. If another session's dashboard server
holds the port, this one makes it exit and takes the port; that needs nothing from you or the
developer. Wait for its first line:

- `DASHBOARD_URL http://127.0.0.1:47321/`: give the developer the URL.
- `PORT_TAKEN`: another program holds the port; start it with `--port <other>` and give that URL.

The server stops, and the background task ends, in three cases. In none of them start it again
unless the developer asks for the dashboard again (the Bloom Dashboard button types `/dashboard`
into this session, which is that request):

- It prints `WINDOW_CLOSED`: the developer closed the window. Stop the `watch-events.mjs` Monitor
  and stop updating rows.
- It prints `REPLACED`: another session started the dashboard and now keeps it. Stop the Monitor
  and stop updating rows; the other session does both now.
- This session ends. The page then says that the server has stopped.

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
  request-peer-review (or merge-without-peer-review) away.
- `nopr`: work pushed or finished, with no PR yet.
- `large`: a big diff, or blocked on other work (name the blocker).
- `cleanup`: a card that has sat In Progress for years with nothing happening on it.

Order rows within a group (`order`) easiest first.

**Status** (`who`): `you` only when something names a choice that the developer has to make: the
PR's preflight report has `reportDecisions` above 0, or an agent's last message asks them to
choose between options. State the choice in `next`; the pill reads "Needs your decision". The
next step being theirs is not a decision: a clean preflight report means the PR waits for their
own review, so the row is `idle`, with `nextSkill` set and no `next`. Otherwise `idle`. The page overrides this live from Orca: a `waiting` agent
in the row's worktree shows "Claude has a question" with the question, and a `working` one marks
the step it works on (below). An agent that sits at its prompt with a background Monitor running
counts as done, not working.

**Next skill** (`nextSkill`): when the next step is to run `preflight` or `request-peer-review`,
name it here. Write `request-peer-review` once preflight is done and clean,
whether or not the developer has reviewed the PR yet: the page works out the rest.

**The Process column** shows every row the same five steps of Bloom's development process, top to
bottom. A finished step is muted with a tick, the first unfinished step is the one enabled button,
and later steps are dimmed:

1. **Code**: finished once the row has a PR or a `nextSkill`. Its button opens the worktree in
   Orca, or creates one.
2. **Preflight**: finished once `nextSkill` is `request-peer-review` and the PR is neither
   conflicting nor failing CI (`prMergeable` and `prChecks`, which the server copies from
   `facts.json`). A PR that becomes conflicting or fails CI makes Preflight the next step again.
3. **Your review (n of m files left)**: links to the PR's changed files until the developer has
   reviewed every file. `own-review.mjs` counts a file as reviewed when the developer marked it
   Viewed on GitHub or reviewed in Reviewable, for the file's current content; the server runs it
   once a minute for these rows and puts the result on the row as `ownReview`.
4. **Request Peer Review**, which squashes the commits and checks the PR, with **Merge without
   Peer Review** beside it when the card has YouTrack's "Approved Plan" tag (`approvedPlan` on the
   card in `facts.json`). When the review cannot be read, these buttons are enabled together with
   the review.
5. **Peer review**: done by a teammate, so it is never a button. On a card in Has Comments it is
   orange and reads "comments back".

Each skill button runs its skill in the worktree's Claude session. A working agent started on
`/preflight` shows "Preflighting…" on step 2, one started on `/request-peer-review` or
`/merge-without-peer-review` shows on step 4, and any other shows "Agent working" on step 1; the
buttons are disabled meanwhile. The running step is a green band with a spinning ring and how long
the agent has worked on its prompt (from when the server first saw it working on that prompt, or
the preflight run's own start), and the row gets a green stripe on its left edge. It never shows
the agent's tool calls. An agent started on
`/preflight` counts as working while it waits on a Monitor, as preflight does for much of its half
hour, as long as the run that `progress.mjs` records in its worktree has not ended; the band then
reads "Waiting on reviewers and CI". "Needs your decision" or "Claude has a question" shows above the
steps and disables them. A clicked skill button spins at once, for up to a minute until Orca
reports the agent working.

**A preflight run's phases.** Preflight records each phase as it starts and ends with
`progress.mjs` (its "Progress for the dashboard" section), which writes
`~/.claude/bloom-dashboard/progress/<worktree>.json`. The server puts a worktree's latest run on
its row as `progress`. While a run has not ended, and an agent works there or the run wrote in
the last 45 minutes, "Where it stands" shows the run's phases in place of `status` and `next`:
Discover, Local checks, Merge master, Push and draft PR, Automated reviews and tests (Devin,
Answering review comments and Related tests, which run at the same time) and Report, each with its
note.

## 4. Write the rows

The rows live in `~/.claude/bloom-dashboard/`, which the server reads every few seconds:

- `board.json`: `{ "board": "<the facts' board, e.g. Bloom 6.6>" }`, or `""` for every board.
  The page's top bar shows the version from it, e.g. "John's work on version 6.6 board".
- `rows/<card id>.json`: one file per card (or a short slug for one cleanup row that lists
  several stale cards). Delete the file of a card that left the board. Rows left by an earlier
  session are claims from then: check every one against the new facts and rewrite it.

Write these files with the Write tool, or as UTF-8 without a byte-order mark. The server reads
past a mark, but PowerShell's `Set-Content` and `Out-File` add one, and other readers may not.

| field | content |
| --- | --- |
| `card`, `cardUrl`, `title` | id, YouTrack URL, a short title |
| `ytState` | the card's YouTrack State, shown as an icon in the State's colour to the left of the id, which names the State on hover |
| `group`, `order`, `who` | from step 3 |
| `status` | how far the work itself has got toward review, in one short sentence of about ten words: code written or not, PR, conflicts, CI, preflight, review, blockers. "Draft PR conflicts with master; CI green." Worktrees made and agents started or stopped are not progress (the Orca button and the Process column show those), and branch names, commit hashes and commit counts belong in the PR and the worktree |
| `comments` | on a card in Has Comments, what the people who asked for changes said, in a few words: "Colin: Undo does nothing after unlocking." Read the card's comments and the PR's review comments since the card last moved to Has Comments; leave out comments posted by an agent (starting `[Claude …]`). The page shows it in orange under `status`, after a speech-bubble icon. Leave it out on other cards |
| `next` | only what the Process column cannot show, just as short: the choice when `who` is `you`; a manual check before review ("Try the reader-tool undo by hand"); waiting on another PR or person ("Waits for PR 8415 to merge"); a judgement call that is not a decision item ("34 files; consider splitting the card"); or tool trouble that the steps hide ("Reviewable lists removed files as reverted; mark them reviewed there"). Leave it out when it would only name the Process column's next step, such as "Run preflight" or "Review PR 8551, then run request-peer-review" |
| `nextSkill` | `preflight` or `request-peer-review`, when the next step is that skill |
| `pr` | PR URL |
| `report`, `reportDecisions` | the PR's `report` and `reportDecisions` from the facts; the Process column shows a "report" link to the right of the Preflight step, with the number of decisions in the developer's colour; while Preflight is the next step and the report lists no decisions, the link reads "old report", because that report is from an earlier run |
| `worktree` | worktree path; the page shows the path, which opens in VS Code, and the row's Orca button opens the worktree |

The page shows each row's time as when its file was last written; the server reads that from the
file, so a row has no time field.

Then give the developer the URL and a few lines on what changed, leading with what waits for them,
and the offer of the Bloom Dashboard button when step 0 found it missing.

## 5. Keep it current

The server appends lines to `~/.claude/bloom-dashboard/events.log`, each starting with a card id:

- every 5 s, when an agent in a card's worktree changes state:
  `BL-16775 D:/BL-16775-grade-branding-2: working -> waiting`;
- every 15 minutes it runs `gather.mjs` again for the same board, replaces `facts.json`, and
  writes each difference about a card on the board, meaning one assigned to the developer that is
  or was In Progress or Has Comments, or about that card's PRs and worktrees (`diff-facts.mjs`
  lists the kinds): a card's State or assignee, a new In Progress
  card, a PR's draft state, mergeability, review decision, CI checks or requested reviewers, a PR
  merged or closed, a new or changed preflight report, new commits, a push, a worktree added or removed;
- when the page's Create button makes a worktree: `BL-16549 <path>: worktree created from the
  dashboard`;
- `orca error` and `gather error` when Orca or the gather starts failing, each written once
  however long it lasts, and `orca answers again` and `gather works again` when it recovers.

Start a Monitor on `node <this folder>/watch-events.mjs` with `timeout_ms` 1800000, and re-arm it
when it expires, for as long as the developer wants the board kept live. It saves its place in
the log, so lines written between expiry and re-arm arrive when it starts again.

On an agent line, read what the agent said (`orca worktree ps --json`, that worktree's agents'
`lastAssistantMessage` and `programStatus`) and check the card's State. On a fact line, read the
change from `facts.json`. Then rewrite that row's `status`, `next`, `nextSkill`, `who` and
`group`, and add a row for a card that has become In Progress or Has Comments. Remove the row when
the card has left In Progress and Has Comments. Push a notification when an agent is waiting on
the developer. The page already shows the agent's change of state on its own, so the row is about what
the agent reported.

Match a worktree line to a row by path, not by the card id in its branch: a PR's branch can name
another card, and the server labels a worktree by the id in its branch. A "created from the
dashboard" line names the row's own card; write its path into that row's `worktree`.

## Back with you for review

Above the groups, the page lists the other people's PRs that the developer reviewed whose cards
are in Ready For Code Review and need the developer again, one line each, highlighted:

- **Author responded** (orange): the PR's author has commented, reviewed or pushed a commit since
  the developer's last comment, so the PR is back with them.
- **Move to Has Comments?** (amber): the PR is open and the author has not responded, so the
  developer probably asked for changes without moving the card to Has Comments.
- **Move to Ready For Testing?** (amber): the PR is merged, so the card should have moved on.

The session writes nothing for these: `gather.mjs` puts them in `facts.json` as `backForReview`
(the cards from `reviewed.mjs` that have a `followUp`), and the server shows them.
`node reviewed.mjs` prints every reviewed card, with its `followUp`.

## History

Below the groups, the page's History shows what the developer did today and on the two weekdays
(Monday to Friday) before it, newest first, each listed even when it has nothing on it, plus a
Saturday or Sunday in between that has any activity. So Monday's standup shows Monday, Friday and
Thursday, and the weekend days only if the developer worked them. A day within the last week is headed by its
weekday ("Friday"), and older ones add the date. Each day lists its tasks, then its work in one
list, newest first, one line per card (title, State, PR, card id), each line starting with an icon
for one of these, which names it on hover (a check in a circle, a short dash, an eye):

- **Finished:** one of the developer's PRs was marked ready for review that day (or opened ready,
  not as a draft), or was merged that day, by anyone.
- **Worked on:** any of: commits the developer authored that day (on their PRs, on the card's
  worktree branch pushed or not, or on a repo's default branch without a PR); files changed but not
  committed yet, on the day each was last saved; the developer's prompts to Claude Code that day in
  a session that ran in the card's worktree, or in a folder whose path names the card (read from
  the transcripts in `~/.claude/projects`), which covers work that has not reached a file. Agents
  commit under the developer's git name, so their commits count. Sessions that the Bloom Dashboard
  button starts do not. A card finished that day is listed only as finished.
- **Reviewed:** the developer commented on or reviewed someone else's PR for the card that day,
  through GitHub or Reviewable (`reviewed.mjs`). Comments that an agent posted for the developer
  (starting `[Claude …]`) do not count, nor do cards the developer is or was assigned to.

- **Tasks:** the developer's own to-do items, which they add in the box under History's heading,
  check off, uncheck and delete. An open task shows under today, whatever day it was made, so
  today is shown whenever a task is open; a checked one shows under the day it was checked, which
  counts as activity on that day. They live in `~/.claude/bloom-dashboard/tasks.json`
  (`[{ id, text, created, checked }]`, `checked` an ISO time or `null`), which only the server
  writes, through `POST /api/task/create|check|uncheck|delete`. It is the one file the dashboard
  keeps that nothing can work out again from git, GitHub or the transcripts, so never delete or
  rewrite it.

The team's stand-up meeting is at 8:45 local time, Monday to Friday (`STANDUP` in `standup.mjs`).
Work done before it was reported at it, so on a weekday whose stand-up has passed, a line with the
meeting's time splits the day: the work after the meeting above it, and the work before it dimmed
below it. A card worked on both before and after the meeting has a line on each side. A task
checked off before the meeting goes below the line too. Until today's meeting, today has no line.

A PR names its card in its title or, failing that, its branch, and a commit on a default branch in
its message; a PR that names no card is a line of its own, `<repo>#<number>`, and other work in a
repo is the line `<repo>`, for the BloomBooks repos that Orca knows. Untracked folders that are
checkouts of their own (worktrees inside a repo's checkout) count for themselves, not for the
checkout they sit in. The Bloom bot opens PRs and commits as Hatton, on `bot/…` branches,
so for those PRs only cards that are or were assigned to the developer count. The session writes
nothing here either: `gather.mjs` puts the days in `facts.json` as `standup` (from `standup.mjs`,
every board), and `node standup.mjs` prints them (counting only pushed commits).

## Colours

Card links, PR links and State icons share four colours across the page: green for work the
developer still has to do (In Progress, a draft PR), orange for Has Comments and for the comment
summary in "Where it stands" and for a reviewed PR whose author has responded, purple for ready for review
(Ready For Code Review, Ready For UI Review, an open PR that is not a draft), and blue for
presumed done (Ready For Testing, Closed, a merged PR). Anything else is plain.

## The buttons

- **The Orca button** (Orca's logo, in the row's lower right corner under the time, the Code
  step when it is next, and the "Needs your decision" or "Claude has a question" pill) on a row with a worktree switches Orca to the worktree's agent terminal or, with no agent there, opens a "Claude" terminal running
  `claude --continue || claude`.
- **The worktree's path** opens that folder in VS Code (`code <path>`).
- **Preflight**, **Request Peer Review** and **Merge without Peer Review** type `/preflight`,
  `/request-peer-review` or `/merge-without-peer-review` into
  the worktree's Claude terminal, or start one with `claude --continue /<skill>` when there is
  none. When Claude is busy there, the server refuses and the page says so.
- **The Orca button with a sparkle** (on a row without a worktree) makes one and starts Claude in it.
  With a PR it checks out the PR's branch; without one Orca makes a branch named
  `<card>-<first three words of the title>` from `origin/master`, or from `origin/Version6.5` when
  the title starts with `[6.5]` (Claude then starts by telling the developer which branch it is on), with Orca's branch
  prefix in front (e.g. `JohnThomson/`). The server then writes a "created from the dashboard"
  line to `events.log` (step 5).
- **Refresh** (in the top bar, after "Checked 5 minutes ago") runs the server's gather straight away instead of waiting
  for the next 15-minute one, and writes its changes to `events.log` the same way (step 5). A
  click during a gather waits for that gather. Before the session's first `facts.json` it says to
  run `/dashboard`.

Every Orca button then launches `Orca.exe` again, which makes the running Orca bring its window to the
front; the CLI alone does not. The server logs each click and its result in
`~/.claude/bloom-dashboard/server.log`. It refuses any request that does not carry the token it
wrote into the page it served, so other web pages cannot drive Orca.
