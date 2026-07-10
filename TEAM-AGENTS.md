# Team-wide agent guidance (always loaded)

This file holds the Bloom team's agent rules that should be active in **every** repo and
session — things no single repo's AGENTS.md can reach. Each dev imports it once from their
personal global `~/.claude/CLAUDE.md` with a line like `@D:/bloom-team-skills/TEAM-AGENTS.md`
(pointing at their own clone; see the README's Installation section). Keep it short: only
rules that genuinely apply everywhere belong here.

## Papercuts

When you hit tooling/process friction, have to work around something, or learn something the
docs or skills should have told you — and now isn't the time to fix it — log a papercut:
append a short entry to `PAPERCUTS.md` at the current repo's root if the cut is about that
repo, or to `PAPERCUTS.md` in bloom-team-skills if it's about the environment, machine, or
team workflow. Follow the `papercut` skill for the format and git handling (in your working
repo: just edit, don't commit separately; in bloom-team-skills: commit and push). Don't derail
your current task — capture takes under a minute — and mention the logged cut in your final
report. Users can also ask directly: "add a papercut about ...".
