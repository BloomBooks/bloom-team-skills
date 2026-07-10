# bloom-team-skills

Agent skills for the Bloom team's development workflow — the procedures that aren't specific
to any one repository: driving PR reviews (Devin, Reviewable), talking to our YouTrack
tracker, and the preflight → self-review → peer-review pipeline.

Each skill is a folder containing a `SKILL.md` in the
[Claude Code / agent skill format](https://code.claude.com/docs/en/skills)
(frontmatter with `name` and `description`, then the procedure).

## Skills


| Skill                      | What it does                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `preflight`                | Everything automatable before human review: local review+fix loop, tests, draft PR (linked once on the YouTrack card), bot gauntlet, decision report. |
| `pr-ready-for-human`       | Step 3 of the pipeline: after preflight and your own review, verify clean, link YouTrack, un-draft the PR, move boards.      |
| `devin-review`             | Single source of truth for operating Devin (devinreview.com / app.devin.ai): trigger, read signals, post findings to GitHub. |
| `reviewable-replies`       | Reply to Reviewable.io review discussions per-thread via the `reviewable` CLI.                                               |
| `youtrack-api`             | Low-level: auth and REST conventions for our YouTrack (`issues.bloomlibrary.org`).                                           |
| `youtrack-fix`             | Fix an issue given a `BL-xxxxx` id: plan, branch, implement, commit.                                                         |
| `youtrack-create-issue`    | File a new bug/task/card on the right board in the right state.                                                              |
| `bloom-youtrack-reporting` | Query and report across YouTrack issues.                                                                                     |
| `papercut`                 | Log small dev/agent/tooling friction to a per-repo `PAPERCUTS.md` without derailing the task; trim mode triages the backlog. |


The review pipeline the top skills implement:

1. `**preflight**` — the agent makes the branch the best version of itself and lands it for you.
2. **You review the work yourself.**
3. `**pr-ready-for-human**` — promotes it to a teammate's review.

## Installation

### Prerequisites — tools

Install these once so the skills have everything they reach for. Not every skill needs every
tool; the "for" column says which ones.


| Tool                                                        | For                                               | Notes                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [**GitHub CLI](https://cli.github.com/) (`gh`)**            | `preflight`, `pr-ready-for-human`, `devin-review` | Authenticate once with `gh auth login`.                                                                                |
| `**reviewable` CLI**                                        | `reviewable-replies`                              | Install globally: `npm install -g reviewable`. See the [Reviewable agent/CLI docs](https://docs.reviewable.io/agents). |
| **`chrome-devtools` CLI** | `devin-review` browser automation | Only needed for `devin-review`, which drives the [Chrome DevTools for agents](https://developer.chrome.com/docs/devtools/agents) **CLI** (not the MCP-server form). Install it globally: `npm i chrome-devtools-mcp@latest -g` (needs Node.js — this puts a `chrome-devtools` binary on your PATH). Verify with `chrome-devtools status`. Works in any environment; no `/plugin` required. |

### Prerequisites — environment variables

Set these in your user environment (never commit them — see [Ground rules](#ground-rules)).


| Variable                   | What                                | How to get it                                                                                                                |
| -------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `**YOUTRACK**`             | YouTrack permanent token (`perm-…`) | In YouTrack: avatar → **Profile** → **Account Security** → **New token…**, scope **YouTrack**. Used by every YouTrack skill. |
| `**REVIEWABLE_API_TOKEN**` | Reviewable agent token (`rvbl_…`)   | In Reviewable: **Account settings** → **Provision new agent** → choose the **Author** agent type. Used by `reviewable-replies`. |
| `**REVIEWABLE_URL**`       | `https://reviewable.io`             | Constant. Used by `reviewable-replies`.                                                                                      |

### Set up the skills

Clone the repo, then symlink each skill folder into your personal skills directory so agents
discover them in every project:

**Windows (PowerShell; needs Developer Mode or an elevated shell for symlinks):**

```powershell
# Set this to the folder where you keep your repos:
$parent = "C:\dev"

$repo = "$parent\bloom-team-skills"
git clone https://github.com/BloomBooks/bloom-team-skills $repo
New-Item -ItemType Directory -Force -Path "$HOME\.claude\skills" | Out-Null
# Only link folders that are actually skills (contain a SKILL.md), so docs and
# other root files/folders are left alone.
Get-ChildItem $repo -Directory | Where-Object { Test-Path "$($_.FullName)\SKILL.md" } | ForEach-Object {
  New-Item -ItemType SymbolicLink -Path "$HOME\.claude\skills\$($_.Name)" -Target $_.FullName
}
```

**macOS / Linux:**

```bash
# Set this to the folder where you keep your repos:
parent=~/src

repo="$parent/bloom-team-skills"
git clone https://github.com/BloomBooks/bloom-team-skills "$repo"
mkdir -p ~/.claude/skills
# Only link folders that are actually skills (contain a SKILL.md), so docs and
# other root files/folders are left alone.
for d in "$repo"/*/; do
  [ -f "$d/SKILL.md" ] && ln -s "$d" ~/.claude/skills/"$(basename "$d")"
done
```

(Re-run the loop after pulling a new skill; existing links keep working since they point at
folders. Skills for other agent tools that read a different directory can be linked the same
way.)

### Load the team-wide agent rules

This repo also carries [`TEAM-AGENTS.md`](TEAM-AGENTS.md) — the few rules that should be
active in **every** repo and session (currently: proactively logging papercuts). Skills only
activate when a request matches them; always-on behavior has to live in context that's loaded
each session. Wire it up once by adding a line to your personal global `~/.claude/CLAUDE.md`,
pointing at your clone:

```
@C:/dev/bloom-team-skills/TEAM-AGENTS.md
```

This import reaches Claude Code only; agents that don't read your global CLAUDE.md (Copilot,
Devin, …) get the same guidance from per-repo `AGENTS.md` rules where those exist.

## Making the review skills actually autonomous (auto-mode setup)

`preflight` and `devin-review` say "invoking this skill IS your permission" to write to GitHub.
That is **intent** authorization — it tells the *agent* not to stop and ask "should I publish
this?". It is **not** the same as **harness** permission, and a skill cannot grant itself the
latter. If you run in **auto mode** (`permissions.defaultMode: "auto"`), the auto-mode
*classifier* is a separate safety gate that will still **deny** the outward-facing `gh` writes
these skills depend on — posting PR comments/reviews, resolving review threads, the "Consulted
Devin …" log comment — with a message like *"denied by the Claude Code auto mode classifier."*
When that happens the skill can't finish the job autonomously: it surfaces the finding in its
report and waits for you instead.

To let these run unattended, add one of the following to your **user** settings
(`~/.claude/settings.json`). Both are personal setup, so they live in your own settings, not in
this repo.

**Option A — teach the classifier (recommended; keeps the guard).** The classifier still runs
and still scrutinizes genuinely dangerous `gh` calls (a `DELETE`, deleting a release/repo); it
just stops denying PR-comment/review writes:

```json
"autoMode": {
  "allow": [
    "$defaults",
    "gh commands that post comments or reviews to GitHub pull requests (gh pr comment, gh pr review, gh api .../pulls/.../comments), and gh api graphql calls that resolve review threads"
  ]
}
```

**Option B — allow-list the commands (more deterministic, broader).** With
`autoMode.classifyAllShell` at its default (`false`), commands matching a `permissions.allow`
rule skip the classifier entirely:

```json
"permissions": {
  "allow": [
    "Bash(gh pr comment:*)",
    "Bash(gh pr review:*)",
    "Bash(gh api repos/BloomBooks/BloomDesktop/:*)",
    "Bash(gh api graphql:*)"
  ]
}
```

Notes:

- A settings change may need a **reload** to take effect — open `/hooks` once (that reloads
config) or restart the agent if the next write is still blocked.
- If you *don't* run in auto mode, you don't need this: you'll simply get a normal permission
prompt to approve each write. This setup only matters for unattended / auto-mode runs.
- `git commit`/`git push` are generally allowed already; the gap in practice is the GitHub
**API/PR-comment** writes above.

## Ground rules

- **Never commit a token or secret here** — this repo is public. Skills reference tokens only
by environment variable name (`$YOUTRACK`, `REVIEWABLE_API_TOKEN`, …).
- Repo-specific skills (build quirks, XLF strings, etc.) stay in that repo's
`.github/skills/`; this repo is for cross-repo team workflow.
- Skills that touch a developer's *personal* setup (e.g. a private board) stay in that
developer's own `~/.claude/skills` — these skills only reference such a skill by name
(`personal-board`) and degrade gracefully when it's absent.

