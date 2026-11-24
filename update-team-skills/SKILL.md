---
name: update-team-skills
description: Update the bloom-team-skills checkout and make sure every skill in it is linked into your personal skills directory. Pulls the latest from the repo, then creates a symlink in ~/.claude/skills for any skill folder that isn't linked yet (e.g. a newly added skill), and reports what changed. Use when asked to "update team skills", "sync the team skills", "/update-team-skills", or after someone says a new shared skill was added.
---

# Update the team skills

Bring the shared **bloom-team-skills** checkout up to date and make sure every skill folder in it
is linked into the personal skills directory (`~/.claude/skills`), so newly added skills become
available. This replaces the old manual "pull, then re-run the symlink loop" chore with one
command, and it is what the **author** of a new skill runs too (their own commit never triggers a
pull, so nothing else would create the new link for them).

The operation is **idempotent**: run it any time. It only adds missing links and reports; it never
overwrites an existing link or touches skills that aren't part of this repo.

## What it does

1. **Locate the clone.** Find the bloom-team-skills repo root two ways, whichever applies:
   - **Normal case (already linked):** resolve this skill's own symlink — read where
     `~/.claude/skills/update-team-skills` points and take its parent directory.
   - **First-time bootstrap (run straight from a clone, before anything is linked):** the repo root
     is the clone you're being run from — the parent of the folder holding *this* `SKILL.md` (i.e.
     the current working directory if Claude was started in the repo). This is the path that makes
     the very first run work, since no symlink exists yet.

   Either way, confirm the resolved path is a git repo that contains these skill folders before
   acting. If neither resolves, ask the user where their clone is.
2. **Pull.** `git pull` in that repo. Report the result (already up to date / fast-forwarded N
   commits / failed). If the pull fails (diverged history, conflicts, dirty tree), surface the git
   output and continue to step 3 anyway — linking is independent of the pull and still worth doing.
3. **Link any unlinked skills.** For every top-level folder in the repo that contains a `SKILL.md`,
   ensure `~/.claude/skills/<folder>` exists as a symlink to it. Create the ones that are missing;
   leave existing links alone. Only link folders that have a `SKILL.md` (so docs and other root
   files are ignored).
4. **Tidy broken links.** If a link in `~/.claude/skills` points *into this repo* but its target no
   longer exists or no longer holds a `SKILL.md` (a skill was renamed/removed upstream), remove that
   link. Never
   remove links that point outside this repo — those are the developer's own / other skills.
5. **Install the daily auto-update.** Run `node <repo>/update-team-skills/auto-update.mjs --install`.
   It adds a SessionStart hook to `~/.claude/settings.json` (or reports it is already there). From
   then on, the first Claude Code session each day starts a background `git pull --ff-only`, links
   new skill folders and removes the links of step 4, without delaying the session. It pulls only when the clone is on `main` with no
   uncommitted changes to tracked files. It also sets up the dashboard as in step 6, without
   approving its Orca plugin. Results go to `~/.claude/bloom-team-skills-update.log`.
   The same command, and each daily run, also adds `@<repo>/TEAM-AGENTS.md` to
   `~/.claude/CLAUDE.md` when no line there imports a `TEAM-AGENTS.md` yet, so the team-wide rules
   load in every session.
6. **Set up the dashboard.** Run `node <repo>/orca-bloom-dashboard-plugin/install.mjs`. It writes the
   dashboard service's Claude Code hooks into `~/.claude/settings.json`, starts the service from
   the clone when Orca is running, and loads its Orca plugin (the Bloom
   Dashboard button in Orca's status bar and the Worktree panel in its right sidebar). It says so
   when `orca` is not installed. Exit code 3 means that Orca has not approved the plugin (a first
   load, or a pull changed its access, its button or its panel), and the output lists the access it
   asks for. Show the developer that list and ask once whether to approve it, since the plugin runs
   code under their account. On a yes, run the same command with `--approve`.
7. **Set up the Greenhouse worker.** The worker is an Orca bot that does the Bloom test
   Greenhouse's work items on the part of the developer's Claude plan that they allocate to it. Its
   instructions live in the private repository BloomBooks/greenhouse, kept in
   `~/.claude/greenhouse-repo`, which nobody edits. Reach it through the developer's `gh` login,
   since plain `git` may have no GitHub credentials:
   - When that folder is missing, `gh repo clone BloomBooks/greenhouse ~/.claude/greenhouse-repo`;
     otherwise `git -c credential.helper= -c "credential.helper=!gh auth git-credential" -C
     ~/.claude/greenhouse-repo pull --ff-only`. When `gh` is not logged in, tell the developer to
     run `gh auth login` and skip the rest of this step.
   - Run `node ~/.claude/greenhouse-repo/bots/install.mjs greenhouse-worker` and act on its exit code:
     - **0**: installed. Pass on each line of its output that starts with `Next:`, with any path in
       it in full. On the first install there are two: set the bot's avatar in Orca's bot settings
       to the picture it names (no `orca` command sets an avatar), and press Bloom Greenhouse in
       Orca's status bar to set how much of the plan to allocate and when; the worker stays Off until
       the developer does.
     - **3**: there is no Orca bot named "Greenhouse Worker". Orca makes a bot only when its owner
       creates it, so tell the developer to create one in Orca, named exactly `Greenhouse Worker`,
       and then run `/update-team-skills` again. Do not ask whether they want the worker; this
       line in the report is enough.
     - **4**: the developer has not yet authorized what the worker does under their GitHub login.
       The output says what that is. Ask them with `AskUserQuestion`, quoting it. On a yes, run the
       same command with `--authorize`. On a no, leave it; the worker is not installed.
     - **1**: the output lists what is missing on this machine. Report it.
8. **Report.** Summarise: pull result, which links were newly created, which already existed, any
   removed, whether the hook was installed, whether the TEAM-AGENTS.md import was added, and
   what steps 6 and 7 printed. A running session notices changed and newly linked
   skills within a few seconds, so no restart is needed.

## Commands

Use the shell that fits the machine. Windows is the common case here; lead with PowerShell.

**Windows (PowerShell).** Use a **junction**, not a symbolic link: a symbolic link needs Developer
Mode or an elevated shell, a junction needs neither, and Claude Code follows both. `-ErrorAction
Stop` matters: without it a refused link prints as `LINKED`, because `New-Item`'s error is
non-terminating and never reaches the `catch`.

```powershell
$skills = "$HOME\.claude\skills"
# 1. Find the repo from this skill's own symlink
$repo = Split-Path (Get-Item "$skills\update-team-skills").Target -Parent
# 2. Pull
git -C $repo pull
# 3. Link any folder with a SKILL.md that isn't linked yet
Get-ChildItem $repo -Directory | Where-Object { Test-Path "$($_.FullName)\SKILL.md" } | ForEach-Object {
  $link = Join-Path $skills $_.Name
  if (Test-Path $link) { "exists   $($_.Name)" }
  else {
    try { New-Item -ItemType Junction -Path $link -Target $_.FullName -ErrorAction Stop | Out-Null; "LINKED   $($_.Name)" }
    catch { "FAILED   $($_.Name): $($_.Exception.Message)" }
  }
}
```

**macOS / Linux (bash):**

```bash
skills=~/.claude/skills
repo="$(dirname "$(readlink -f "$skills/update-team-skills")")"
git -C "$repo" pull
for d in "$repo"/*/; do
  name="$(basename "$d")"
  [ -f "$d/SKILL.md" ] || continue
  if [ -e "$skills/$name" ]; then echo "exists   $name"
  else ln -s "$d" "$skills/$name" && echo "LINKED   $name"; fi
done
```

## Notes

- **Bootstrap without a slash command.** On a brand-new machine this skill isn't linked yet, so
  `/update-team-skills` doesn't exist as a command. Run it anyway by opening Claude *in the repo
  folder* and asking it to **follow `update-team-skills/SKILL.md`**; step 1's bootstrap branch finds
  the clone from that file's own location and links everything — including this skill — so the slash
  command works from then on.
- Prefix nothing to GitHub / no network writes here — this only touches the local clone and the
  local skills directory.
