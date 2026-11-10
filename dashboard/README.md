# How the dashboard works

`SKILL.md` is what the dashboard's Claude session does: gather, decide each row, write it, keep it
current. This file is how the rest works, the page, the server, the Worktree panel and the two Orca
plugins, for a developer or an agent changing this folder's code.

## Who decides what

| Part | Decides | Where |
| --- | --- | --- |
| The session | each row's judgement: `group`, `order`, `who`, `status`, `comments`, `next`, `nextSkill` | `rows/<card>.json` (SKILL.md, step 4) |
| `gather.mjs` | cards, worktrees, PRs, History and "Back with you for review" from YouTrack, GitHub, git and Orca | `facts.json` |
| `server.mjs` | what it adds to a row from facts, git, own-review.mjs and progress files (`enrichRows`), Orca's live agents (`liveAgents`), what is wrong with a row (`rowProblems`) | `/api/state`, `events.log` |
| `row.js` | how a row merges the live agents (`withLiveAgents`), the Process column (`processModel`), drawing | the page and the panel |

Every rule that more than one of these applies lives in one place: `row-facts.mjs` for rows,
agents, PRs and preflight runs, `transcripts.mjs` for the developer's prompts in Claude Code
transcripts, `../orca-worktrees.mjs` for driving Orca (open a worktree, run a skill, type a prompt).
`row.js` is a browser script that the page and the panel both load, so its rules stay plain
functions with no DOM, and its tests run it in a `vm` context.

Everything in `~/.claude/bloom-dashboard/` is listed at the top of `server.mjs`.

## The session's rows

The server checks each row file against `rowProblems` in `row-facts.mjs`: a known `group`, a `who`
of `you` or `idle`, a `nextSkill` of `preflight` or `request-peer-review`, a GitHub PR URL, and none
of the fields the dashboard works out itself. A file that breaks a rule, or is not JSON, is named in
a note at the top of the page, and once in `events.log` as `<card> row: <problem> (rows/<file>)`,
which tells the session to rewrite it.

## A preflight run

Preflight records its phases with `progress.mjs` (`start`, each step's state, `end`) in
`progress/<worktree>.json`. `row-facts.mjs` describes the states a run goes through:

- **showing**: not ended, and an agent works in the worktree or the run wrote in the last 45
  minutes. "Where it stands" shows the run's phases (Discover, Local checks, Merge master, Push and
  draft PR, Automated reviews and tests with Devin, Answering review comments and Related tests at
  the same time, Report), and any working agent there counts as preflight. An agent started on
  request-peer-review or merge-without-peer-review counts only when the run wrote after it started:
  those skills can hand the work back to preflight, but a run that a stopped preflight left without
  an end is older than the agent. request-peer-review and merge-without-peer-review run
  `progress.mjs end` first, which closes such a run and leaves an ended one as it was.
- **stale**: not ended, with nothing showing it is still going. It shows nothing.
- **ended**: `end` recorded the commit and its tree. Preflight counts as done until tracked files
  have uncommitted changes or HEAD's tree differs (`codeChangedSincePreflight`), so the squash that
  request-peer-review makes, which keeps the tree, leaves it done.

An agent started on `/preflight` counts as working while it waits on a Monitor, as preflight does
for much of its half hour, until its run ends; the running step then reads "Waiting on reviewers
and CI".

## The Process column

Every row shows the same five steps of Bloom's development process. A finished step is muted with
a tick, the first unfinished step is the one enabled button, and later steps are dimmed
(`processModel` in `row.js`):

1. **Code**: finished once the row has a PR or a `nextSkill`. Its button opens the worktree in
   Orca, or creates one.
2. **Preflight**: finished once `nextSkill` is `request-peer-review`, the PR is neither conflicting
   nor failing CI, and the code has not changed since the last run ended (above).
3. **Your review (n of m files left)**: links to the PR in Reviewable until the developer has
   reviewed every file. `own-review.mjs` counts a file as reviewed when the developer marked it
   Viewed on GitHub or reviewed it in Reviewable, for the file's current content; the server runs
   it once a minute for rows whose next skill is request-peer-review.
4. **Request Peer Review**, with **Merge without Peer Review** beside it when the card has
   YouTrack's "Approved Plan" tag. When the review cannot be read, these buttons are enabled
   together with the review.
5. **Peer review**: done by a teammate, so never a button. On a card in Has Comments it is orange
   and reads "comments back".

A working agent started on `/preflight` shows on step 2, one on `/request-peer-review` or
`/merge-without-peer-review` on step 4, and any other on step 1, as a green band with a spinning
ring and how long it has worked (from the run's own start while the run shows, or else from when
the server first saw it working on that prompt). The buttons are disabled meanwhile. "Needs your
decision" or "Claude has a question" shows above the steps and disables them. A clicked skill
button spins at once, for up to a minute until Orca reports the agent working.

The "report" link right of Preflight shows the number of decisions in the developer's colour; while
Preflight is the next step and the report lists no decisions, it reads "old report".

## The buttons

- **The Orca button** (Orca's logo, in the row's lower right corner, the Code step and the status
  pill) switches Orca to the worktree's agent terminal, or opens a "Claude" terminal running
  `claude --continue || claude`.
- **The worktree's path** opens the folder in VS Code.
- **Preflight**, **Request Peer Review** and **Merge without Peer Review** type the skill into the
  worktree's Claude terminal, or start one with `claude --continue /<skill>`. The server refuses
  while Claude is busy there.
- **The Orca button with a sparkle** (a row without a worktree) makes one and starts Claude in it:
  on the PR's branch, or on a new `<card>-<three words>` branch from `origin/master` (or
  `origin/Version6.5` for a title starting `[6.5]`), and writes a "created from the dashboard" line
  to `events.log`.
- **Refresh** runs the server's gather now and writes its changes to `events.log`.

Every Orca button then launches `Orca.exe` again, which brings Orca's window to the front. The
server logs each click in `server.log`, and refuses any request without the token it wrote into
the page it served.

## Back with you for review, and History

Above the groups, the cards in Ready For Code Review whose PRs (other people's) the developer
reviewed, when they need the developer again. Each card is judged from all its PRs, not just the
ones the developer commented on, since a card often has a stack merged weeks ago and then a new PR
for a bug found in testing. The card waits for its open PR (drafts aside): **Author responded**
(orange, the author answered since the developer's last comment on it), **New PR to review**
(orange, no comment from the developer yet, and no review asked of someone else instead) or
**Move to Has Comments?** (amber, the author has not responded). With no open PR, **Move to Ready
For Testing?** (amber) only when the developer merged the card's last PR; someone else's merge is
theirs to follow through. `reviewed.mjs` works these out (`backForReview`, `cardFollowUps`).

Below the groups, History shows today and the two weekdays before it, plus a weekend day with any
activity, each day's lines marked **Finished** (a PR marked ready or opened ready, or merged),
**Worked on** (the developer's commits, uncommitted files, and prompts to Claude Code in the card's
worktree) or **Reviewed**, from `standup.mjs`. A line at the stand-up's time (8:45, `STANDUP`)
splits a weekday, with the work before it dimmed. The developer's tasks live in `tasks.json`
(`tasks.mjs`), the one file here that nothing can work out again.

Card links, PR links and State icons share four colours: green for work the developer still has
to do, orange for Has Comments, purple for ready for review, blue for presumed done.

## The server's life

The server opens the page in a Chrome app window. A second server takes the port over: it asks the
first to exit (`/api/handover`, with `handover.key`), and the first prints `REPLACED`. Closing the
window stops it with `WINDOW_CLOSED`, as does no page asking for five minutes.

A session whose command line is `claude "Open the dashboard"` exists only for the dashboard and
holds about 300 MB, so the server ends such sessions: once listening, every one that started before
it except its own; when it exits, its own. `--keep-sessions` turns that off.

## The Orca plugins

`orca-plugin/` puts a Bloom Dashboard button in Orca's status bar. When the server answers, the
button asks it to show its window (`/api/show`); otherwise it starts `server.mjs` at once and a
background terminal in the bloom-team-skills workspace running `claude "Open the dashboard"` (no
leading slash, which Git Bash would rewrite into a Windows path). The button reads "Loading..."
meanwhile, and leaves alone a session it started under 90 seconds ago.

`orca-plugin.json` with `worktree-panel/` is the Worktree panel: the dashboard's row for the
worktree Orca has focused, with its checkout and its Claude session. `worktree-panel/README.md`
covers it. The plugin's folder is this whole folder because Orca lets a panel load only files
inside its plugin's folder.

## Tests

```sh
node --test "*.test.mjs" "dashboard/**/*.test.mjs"
```

from the clone's root; CI runs the same (`.github/workflows/test.yml`). The server's tests start
real servers on free ports with a temporary home folder, `--no-window` and `--keep-sessions`, so
they touch neither your own dashboard nor any Claude session.
