---
name: dashboard
description: Build or refresh the developer's dashboard of their in-progress YouTrack cards, a local web page that groups each card by how close it is to review, shows live which ones agents are working and which are waiting for the developer, and opens each worktree in Orca. Use when the developer says "dashboard", "/dashboard", asks which cards to finish first, or asks to keep the board up to date while agents work.
argument-hint: "[Kanban Board, e.g. 6.6, or all; default: the current version]"
---

# Dashboard

`server.mjs` serves `board.html` at http://127.0.0.1:47321/ for as long as the Claude session that
started it is open. You, the session, decide what each card's row says and write it to a file. The
server adds everything it can work out itself (the PR's state and CI, the developer's own review,
preflight runs, Orca's live agents) and the page draws the row. `README.md` in this folder says how
the page, the server, the Worktree panel and the Orca plugins work: read it when the developer asks
how something on the page behaves, or before changing this folder's code.

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

When the background task ends with neither line, the server was killed (Claude Code stops
background commands when memory runs short). Orca's Bloom Dashboard plugin starts it again within
a few seconds, and the open page reloads onto it. Keep the Monitor running and keep updating rows,
and do not start the server yourself.

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
- `board`: the board it kept, or `null` for every board;
- `backForReview` and `standup`, which the page shows as "Back with you for review" and History
  with nothing from you.

It needs Orca running and `gh` signed in as the developer; it reaches YouTrack as the Bot through
`bloom-services`. The search for the developer's cards relies on the Bot holding YouTrack's "Read User
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
own review, so the row is `idle`, with `nextSkill` set and no `next`. Otherwise `idle`. The page
shows Orca's live agents over this by itself: a waiting agent as "Claude has a question", a
working one on the step it works on. An agent that sits at its prompt with a background Monitor
running counts as done, not working.

**Next skill** (`nextSkill`): when the next step is to run `preflight` or `request-peer-review`,
name it here. Write `request-peer-review` once preflight is done and clean, whether or not the
developer has reviewed the PR yet: the page's Process column works out the rest. It shows the
five steps of Bloom's process (Code, Preflight, Your review, Request Peer Review, Peer review)
and sends the row back to Preflight by itself when the PR conflicts, CI fails, or the code changes
after the last preflight run, so leave `nextSkill` at `request-peer-review` when new commits arrive.
It also adds a Process PR Comments step by itself while comments from the developer or a teammate
wait on the PR.

## 4. Write the rows

The rows live in `~/.claude/bloom-dashboard/`, which the server reads every few seconds:

- `board.json`: `{ "board": "<the facts' board, e.g. Bloom 6.6>" }`, or `""` for every board.
  The page's top bar shows the version from it, e.g. "John's work on version 6.6 board".
- `rows/<card id>.json`: one file per card (or a short slug for one cleanup row that lists
  several stale cards). Delete the file of a card that left the board. Rows left by an earlier
  session are claims from then: check every one against the new facts and rewrite it.

Write these files with the Write tool, or as UTF-8 without a byte-order mark. The server reads
past a mark, but PowerShell's `Set-Content` and `Out-File` add one, and other readers may not.

A row holds these fields and no others; the server adds the rest. It checks each row, and a row
that breaks these rules is named at the top of the page and in `events.log` (step 5) until you
rewrite it.

| field | content |
| --- | --- |
| `card`, `cardUrl`, `title` | id, YouTrack URL, a short title |
| `ytState` | the card's YouTrack State, shown as an icon in the State's colour to the left of the id |
| `group`, `order`, `who` | from step 3: `group` one of `near`, `nopr`, `large`, `cleanup`; `order` a number; `who` `you` or `idle` |
| `status` | how far the work itself has got toward review, in one short sentence of about ten words: code written or not, PR, conflicts, CI, preflight, review, blockers. "Draft PR conflicts with master; CI green." Worktrees made and agents started or stopped are not progress (the Orca button and the Process column show those), and branch names, commit hashes and commit counts belong in the PR and the worktree |
| `comments` | on a card in Has Comments, what the people who asked for changes said, in a few words: "Colin: Undo does nothing after unlocking." Read the card's comments and the PR's review comments since the card last moved to Has Comments; leave out comments posted by an agent (starting `[Claude …]`). The page shows it in orange under `status`. Leave it out on other cards |
| `next` | only what the Process column cannot show, just as short: the choice when `who` is `you`; a manual check before review ("Try the reader-tool undo by hand"); waiting on another PR or person ("Waits for PR 8415 to merge"); a judgement call that is not a decision item ("34 files; consider splitting the card"); or tool trouble that the steps hide ("Reviewable lists removed files as reverted; mark them reviewed there"). Leave it out when it would only name the Process column's next step, such as "Run preflight" or "Review PR 8551, then run request-peer-review" |
| `nextSkill` | `preflight` or `request-peer-review`, when the next step is that skill |
| `pr` | the PR's GitHub URL |
| `report`, `reportDecisions` | the PR's `report` and `reportDecisions` from the facts |
| `worktree` | worktree path; the page shows the path, which opens in VS Code, and the row's Orca button opens the worktree |

The page shows each row's time as when its file was last written, so a row has no time field.

`tasks.json` beside the rows holds the developer's to-do items for History. Nothing can work it out
again, and only the server writes it: leave it as it is.

Then give the developer the URL and a few lines on what changed, leading with what waits for them,
and the offer of the Bloom Dashboard button when step 0 found it missing.

## 5. Keep it current

The server appends lines to `~/.claude/bloom-dashboard/events.log`, each starting with a card id:

- every 5 s, when an agent in a card's worktree changes state:
  `BL-16775 D:/BL-16775-grade-branding-2: working -> waiting`;
- every 15 minutes it runs `gather.mjs` again for the same board, replaces `facts.json`, and
  writes each difference about a card on the board, meaning one assigned to the developer or named
  by one of their worktrees that is or was In Progress or Has Comments, or about that card's PRs
  and worktrees (`diff-facts.mjs` lists the kinds): a card's State or assignee, a new In Progress
  card, a PR's draft state, mergeability, review decision, CI checks or requested reviewers, a PR
  merged or closed, a new or changed preflight report, new commits, a push, a worktree added or
  removed;
- when the page's Create button makes a worktree: `BL-16549 <path>: worktree created from the
  dashboard`;
- when a row you wrote breaks the rules of step 4: `BL-16549 row: has group "nearly", not one of
  near, nopr, large, cleanup, so it is in no table (rows/BL-16549.json)`;
- `orca error` and `gather error` when Orca or the gather starts failing, each written once
  however long it lasts, and `orca answers again` and `gather works again` when it recovers.

Start a Monitor on `node <this folder>/watch-events.mjs` with `timeout_ms` 1800000, and re-arm it
when it expires, for as long as the developer wants the board kept live. It saves its place in
the log, so lines written between expiry and re-arm arrive when it starts again.

On an agent line, read what the agent said (`orca worktree ps --json`, that worktree's agents'
`lastAssistantMessage` and `programStatus`) and check the card's State. On a fact line, read the
change from `facts.json`. Then rewrite that row's `status`, `next`, `nextSkill`, `who` and
`group`, and add a row for a card that has become In Progress or Has Comments. Remove the row when
the card has left In Progress and Has Comments. On a row line, rewrite the file it names so that
it keeps the rules. Push a notification when an agent is waiting on the developer. The page
already shows the agent's change of state on its own, so the row is about what the agent reported.

Match a worktree line to a row by path, not by the card id in its branch: a PR's branch can name
another card, and the server labels a worktree by the id in its branch. A "created from the
dashboard" line names the row's own card; write its path into that row's `worktree`.
