---
name: work-on-reviewing
description: Set up to review a PR, especially a large or complex one - open it in Reviewable in the browser, save the card's files, open (or create, at the PR's tip) the PR's Orca worktree with a Claude ready to answer questions about its code, and start a second Claude there that builds and launches Bloom, makes any test books the review needs, and publishes a review report (reading order, changes to the HTML Bloom stores, public functions added or changed, new complexity, new jargon, where to look hardest). Use when the developer says "/work-on-reviewing BL-12345", "/work-on-reviewing 7421", "I want to review PR 7421", "help me review BL-12345", or "set me up to review ...". Takes a YouTrack card (its open PR created last) or a PR number or URL. Changes nothing on the card or the PR.
argument-hint: "<BL-id | PR number | PR URL> [--repo owner/name] [--no-report] [--dry-run]"
---

# Work on reviewing a PR

`work-on-reviewing.mjs` in this folder does all of it. Run it with the developer's arguments and
report what it prints:

```powershell
node <this folder>/work-on-reviewing.mjs BL-16627
node <this folder>/work-on-reviewing.mjs 7421
```

Run it in the foreground; it takes 5 to 40 seconds. It needs Orca running with the PR's repo added,
`gh` signed in, and, for a card, `YOUTRACK_BOT` set (see `youtrack-api`).

What the script does, so you can explain its output:

1. Finds the PR. For a card, its open PRs, found as `work-on-youtrack` finds them (PR links on the
   card plus `gh search prs <card>` in BloomBooks, keeping open PRs whose title or branch names the
   card), and takes the one created last; the others are listed. For a PR number, the PR in
   `--repo` (default `bloombooks/bloomdesktop`); its card is the `BL-` id in its title or branch,
   if any. A GitHub or Reviewable URL names the repo itself.
2. Opens the PR in Reviewable (`https://reviewable.io/reviews/<owner>/<repo>/<n>`) in the system
   browser.
3. Saves every attachment of the card into `Documents/Bloom Review/<card>/card files/` (the review
   folder is `Documents/Bloom Review/PR <n>/` for a PR with no card). A file already there at the
   same size is not downloaded again. Failing to save them is reported, not fatal.
4. Finds the Orca worktree on the PR's branch. When there is one it fetches the branch and, when
   the worktree is only behind it with nothing uncommitted, fast-forwards it to the PR's tip. A
   worktree with local commits or uncommitted changes is left as it is, and both Claudes are told
   to read the PR from `origin/<branch>`. When there is none, it creates one on the PR's branch at
   its tip, as `work-on-youtrack` does for a card with a PR (a PR from a fork is refused). A
   worktree for the card on another branch is not used; it is listed.
5. Starts a Claude in the worktree that reads the PR's description, commits and changed files,
   says in a few sentences what the PR does, and waits for the developer's questions. It answers
   with file:line references and changes nothing unless asked.
6. Starts a second Claude in the worktree, in a tab beside the first, that follows
   `references/report.md`:
   - starts a subagent that builds Bloom from the worktree and launches it (BloomDesktop PRs, or a
     repo with a `run-*` skill), without stopping a Bloom that another worktree runs;
   - adds files the card links to into `card files/`, and makes any test books the developer needs
     to see the problem or try the feature, in collections in the review folder;
   - publishes a report as an Artifact: the testing setup (Bloom, files, test books), size and
     shape, a reading order by concern, changes to the HTML that Bloom stores, the public
     functions added or changed (marking those whose name or comment does not match what they
     do), what got more complex, new jargon, where to look hardest and possible issues, and what
     is safe to skim. It does not repeat what the PR description says the PR does or how it was
     tested. It republishes when the build finishes.
   For a big PR it splits the reading among subagents. That takes several minutes; the developer
   can start reviewing meanwhile.
7. Makes the worktree the one Orca shows. It does not bring Orca's window to the front, so the
   browser with Reviewable stays on top.

It does not assign the card, move it, or comment on the card or the PR.

Options:

- `--repo <owner/name>`: the repo of a PR given by number; with a card, the only repo searched.
- `--no-report`: start only the Claude that answers questions (no build, no test books, no report).
- `--dry-run`: finds the PR and the worktree and prints what it would do; opens and saves nothing.
- `--json`: one JSON object instead of text (`action` is `open`, `create`, `would-open` or
  `would-create`; `ok: false` with `error` on failure).

On failure it exits 1 with `work-on-reviewing failed: <reason>`. "Orca has no repo for
github:<repo>" means the developer must add that repo to Orca first; pass the reason on rather than
working around it. Each run starts two new Claudes, even in a worktree that already has some.
