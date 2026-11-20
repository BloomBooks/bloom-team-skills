---
name: release-readiness
description: Say what holds up publishing Bloom's next beta and release. Reads the changes waiting in TeamCity for every live Beta Publish and Release Publish config, checks each YouTrack card they name, and lists the version's open cards whose code isn't in yet. Use when asked "what's outstanding for the next beta/release?", "can we publish 6.5?", "which [6.5] cards are still open?", or "are we ready to ship?".
---

# Release readiness

The question is the one a developer answers by hand before a publish: open the TeamCity config's
pending changes, see which cards they name, and check whether each card is closed. A card whose
code is waiting but which isn't resolved holds up the publish, because its code goes out with the
next build. This skill does that for **both the release and the beta every time**: every Beta
Publish and Release Publish config in TeamCity's Bloom / Publish project that isn't paused. It
takes no arguments.

## Gather

Run the script with the `node.exe` itself (on Windows, the Volta `node` shim goes through `cmd`,
which cuts URLs at `&`; the script keeps every URL inside Node, so any `node.exe` works):

```bash
node ~/.claude/skills/release-readiness/readiness.mjs > "$TEMP/readiness.json"
```

It prints one entry per config, release first:

- `lastBuild`: the config's last finished build (when it last published).
- `holdingUp`: unresolved cards named by a waiting change, with state, assignee, board and the
  commits.
- `resolvedAndWaiting`: resolved cards whose code is waiting (fine).
- `changesWithoutCard`: waiting commits that name no card (Crowdin merges, branch merges, tooling).
- `versionCardsNotWaiting`: unresolved cards on any board whose summary starts with the version's
  prefix (`[6.5]`, `[6.5 regression]`) and that no waiting change names, leaving out the "Issues
  We'll Live With for now" board, whose cards are parked. `alreadyPublished` is
  true when an earlier build of this config already carried a commit that names it, and
  `latestComments` are its last few comments.

## Report

In the terminal, one section per config, release first. Lead each with a verdict line: "nothing
holds it up" or "N cards hold it up", and when it last published. Then:

1. **Holding it up**: a table of the `holdingUp` cards (card, title, state, assignee). Flag a card
   in Ready For Testing with no assignee, since nobody will test it.
2. **Waiting, no card**: one line naming the kinds of commit in `changesWithoutCard`, calling out
   any that isn't a translation or branch merge so someone looks at it.
3. **Resolved and waiting**: one line of card ids.
4. **Not in yet**: the `versionCardsNotWaiting` cards. These don't hold up the publish; they are
   work still aimed at the version. Read each card's `latestComments` and give one line on where
   it stands (what it's waiting on, who has it). Mark `alreadyPublished` cards as shipped in an
   earlier build and awaiting test or closing.

Say once that a commit which never names its card can't be matched, so a card with code waiting
under another name shows up as not in yet.

Don't change any card. This skill only reports.
