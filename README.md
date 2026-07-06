# bloom-team-skills

Agent skills for the Bloom team's development workflow — the procedures that aren't specific
to any one repository: driving PR reviews (Devin, Reviewable), talking to our YouTrack
tracker, and the preflight → self-review → peer-review pipeline.

Each skill is a folder containing a `SKILL.md` in the
[Claude Code / agent skill format](https://code.claude.com/docs/en/skills)
(frontmatter with `name` and `description`, then the procedure).

## Skills

| Skill | What it does |
|---|---|
| `preflight` | Everything automatable before human review: local review+fix loop, tests, draft PR, bot gauntlet, decision report. |
| `pr-ready-for-human` | Step 3 of the pipeline: after preflight and your own review, verify clean, link YouTrack, un-draft the PR, move boards. |
| `devin-review` | Single source of truth for operating Devin (devinreview.com / app.devin.ai): trigger, read signals, post findings to GitHub. |
| `reviewable-replies` | Reply to Reviewable.io review discussions per-thread via the `reviewable` CLI. |
| `youtrack-api` | Low-level: auth and REST conventions for our YouTrack (`issues.bloomlibrary.org`). |
| `youtrack-fix` | Fix an issue given a `BL-xxxxx` id: plan, branch, implement, commit. |
| `youtrack-create-issue` | File a new bug/task/card on the right board in the right state. |
| `bloom-youtrack-reporting` | Query and report across YouTrack issues. |

The review pipeline the top skills implement:

1. **`preflight`** — the agent makes the branch the best version of itself and lands it for you.
2. **You review the work yourself.**
3. **`pr-ready-for-human`** — promotes it to a teammate's review.

## Installation

Clone the repo, then symlink each skill folder into your personal skills directory so agents
discover them in every project:

**Windows (PowerShell; needs Developer Mode or an elevated shell for symlinks):**

```powershell
git clone https://github.com/BloomBooks/bloom-team-skills d:/bloom-team-skills
Get-ChildItem d:/bloom-team-skills -Directory | ForEach-Object {
  New-Item -ItemType SymbolicLink -Path "$HOME\.claude\skills\$($_.Name)" -Target $_.FullName
}
```

**macOS / Linux:**

```bash
git clone https://github.com/BloomBooks/bloom-team-skills ~/bloom-team-skills
for d in ~/bloom-team-skills/*/; do ln -s "$d" ~/.claude/skills/"$(basename "$d")"; done
```

(Re-run the loop after pulling a new skill; existing links keep working since they point at
folders. Skills for other agent tools that read a different directory can be linked the same
way.)

## Ground rules

- **Never commit a token or secret here** — this repo is public. Skills reference tokens only
  by environment variable name (`$YOUTRACK`, `REVIEWABLE_API_TOKEN`, …).
- Repo-specific skills (build quirks, XLF strings, etc.) stay in that repo's
  `.github/skills/`; this repo is for cross-repo team workflow.
- Skills that touch a developer's *personal* setup (e.g. a private board) stay in that
  developer's own `~/.claude/skills` — these skills only reference such a skill by name
  (`personal-board`) and degrade gracefully when it's absent.
