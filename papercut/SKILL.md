---
name: papercut
description: Log or triage "papercuts" — small dev/agent/tooling friction points and improvement ideas that aren't worth fixing mid-task. Use in ADD mode when the user says "add a papercut about ...", or proactively when you hit tooling/process friction, have to work around something, or learn something the docs/skills should have told you but now is not the time to fix it. Use in TRIM mode when asked to "trim", "triage", or "work on" the papercuts. Product bugs and feature ideas belong in YouTrack, not here.
argument-hint: "a description of the cut to log, or 'trim' to work through the backlog"
user-invocable: true
---

# Papercut

A papercut is a small piece of friction worth remembering but not worth fixing right now:
stale or missing agent docs, a script quirk you had to work around, a dialog box that stalled
an agent, a lesson that belongs in CLAUDE.md/AGENTS.md or a skill. The system has two modes:
**add** (capture in under a minute, then get back to work) and **trim** (periodically fix
entries and delete them from the log).

**Scope guard:** product bugs and feature requests go to YouTrack (`youtrack-create-issue`),
not a papercut. Papercuts are about the *development and agent experience*: tooling, scripts,
docs, workflows, environment.

## The log files

One `PAPERCUTS.md` per repo, at the repo root. Route by what the cut is *about*:

| The cut is about...                                              | Log it in...                          |
| ---------------------------------------------------------------- | ------------------------------------- |
| the repo you're working in (its docs, scripts, build, tests)     | `PAPERCUTS.md` at that repo's root    |
| the environment, machine, team workflow, or agents in general    | `PAPERCUTS.md` in bloom-team-skills   |

If the target `PAPERCUTS.md` doesn't exist yet, create it with this two-line header (adjust
the scope sentence to the repo), then start adding entries below the `---`:

```markdown
Papercuts for <this repo> — small dev/agent/tooling friction points, captured now and fixed
later. See the "papercut" skill for the procedure.

Note: when resolving a git merge conflict here, keep both sides' entries unless they merge cleanly.

---
```

## Add mode

Keep this under a minute — do not derail the task you were doing.

1. Skim the target log for an existing entry about the same thing. If found, add a dated
   `seen again: ...` line to that entry instead of writing a duplicate.
2. Otherwise insert a new entry at the **top** of the log, directly under the header block:

   ```markdown
   ## YYYY-MM-DD — Short title
   - **Cut:** the friction / what happened
   - **Idea:** what could fix it (doc change, script, skill, automation)
   - **Context:** repo/branch/PR, links, who hit it  _(optional)_
   ```

   2–5 lines total. Today's date. Enough context that someone triaging weeks later, with no
   memory of the incident, understands it.
3. Git handling depends on which repo you wrote to:
   - **The repo you're currently working in:** just leave the edit in the working tree — it
     rides along in the next commit. Do **not** make a separate commit for it.
   - **bloom-team-skills (when it's not your current working repo):** commit and push the
     entry immediately (`papercut: <title>`). An uncommitted edit in a repo nobody has open
     would be lost, and that repo takes direct commits to main.
4. Mention in your final report to the user that you logged a papercut, and where.

## Trim mode

Triggered by "trim the papercuts", "triage the papercuts", "work on papercuts".

1. Read the current repo's `PAPERCUTS.md` **and** bloom-team-skills' `PAPERCUTS.md`.
2. Present a grouped, prioritized summary: quick wins (doc/skill edits), needs-a-system
   (scripts, automation, new skills), possibly stale (old, superseded, or no longer
   reproducible).
3. For each cut the user picks (or all of them, if told to run autonomously), do one of:
   - **Fix it** via the normal workflow for the repo it lives in (branch + PR for code repos;
     direct commit for bloom-team-skills).
   - **Promote it**: file a YouTrack issue, fold the lesson into a CLAUDE.md/AGENTS.md or a
     skill, or spin up whatever system the Idea line called for.
   - **Drop it** as stale, saying why.
4. Whatever the outcome, **delete the entry** from the log as part of the same change, so the
   log only ever contains open cuts.
