---
name: update-team-skills
description: Update the bloom-team-skills checkout and make sure every skill in it is linked into your personal skills directory. Pulls the latest from the repo, then creates a symlink in ~/.claude/skills for any skill folder that isn't linked yet (e.g. a newly added skill), and reports what changed. Use when asked to "update team skills", "sync the team skills", "/update-team-skills", or after someone says a new shared skill was added.
user-invocable: true
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
4. **Tidy broken links (optional).** If a link in `~/.claude/skills` points *into this repo* but its
   target no longer exists (a skill was renamed/removed upstream), remove that dangling link. Never
   remove links that point outside this repo — those are the developer's own / other skills.
5. **Report.** Summarise: pull result, which links were newly created, which already existed, any
   removed. If any link was newly created, tell the user to **restart Claude Code (or start a new
   session)** for the newly linked skills to be discovered — skills are loaded at session start.

## Commands

Use the shell that fits the machine. Windows is the common case here; lead with PowerShell.

**Windows (PowerShell).** Creating symlinks needs **Developer Mode** on (Settings → Privacy &
security → For developers) or an elevated shell; if `New-Item -SymbolicLink` throws, report that as
the cause rather than failing silently.

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
    try { New-Item -ItemType SymbolicLink -Path $link -Target $_.FullName | Out-Null; "LINKED   $($_.Name)" }
    catch { "FAILED   $($_.Name): $($_.Exception.Message)  (enable Developer Mode or run elevated)" }
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
