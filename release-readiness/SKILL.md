---
name: release-readiness
description: Say what holds up publishing Bloom's next beta and release. Reads the changes waiting in TeamCity for every live Beta Publish and Release Publish config, checks each YouTrack card they name, and lists the version's open cards whose code isn't in yet. With an optional `blorg` or `b-p` argument, does the same for the next Bloom Library or bloom-player release, from the commits waiting to be merged into its release branch. Use when asked "what's outstanding for the next beta/release?", "can we publish 6.5?", "which [6.5] cards are still open?", "are we ready to ship?", "can we release blorg?" or "what's waiting in bloom-player alpha?".
---

# Release readiness

The question is the one a developer answers by hand before a publish: open the TeamCity config's
pending changes, see which cards they name, and check whether each card is closed. A card whose
code is waiting but which isn't resolved holds up the publish, because its code goes out with the
next build. This skill does that for **both the release and the beta every time**: every Beta
Publish and Release Publish config in TeamCity's Bloom / Publish project that isn't paused.

An optional argument asks about another repo instead. Each releases by merging one branch into
another, so what waits is the commits on the first branch that the second lacks (leaving out ones
already cherry-picked, by their first line):

| Argument | Repo | Waits on | Published by |
| --- | --- | --- | --- |
| `blorg` | BloomBooks/BloomLibrary2 | `master` (alpha.bloomlibrary.org) | a push to `release` (bloomlibrary.org) |
| `b-p` | BloomBooks/bloom-player | `alpha` (npm `alpha`) | a push to `master` (npm `latest`), and then each product that ships it |

## Gather

Run the script with the `node.exe` itself (on Windows, the Volta `node` shim goes through `cmd`,
which cuts URLs at `&`; the script keeps every URL inside Node, so any `node.exe` works):

```bash
node ~/.claude/skills/release-readiness/readiness.mjs [blorg|b-p] > "$TEMP/readiness.json"
```

With `blorg` or `b-p`, the first entry is the branch merge, whose `lastBuild` is the head of the
release branch (when it last published). Every entry from these repos has `versionCardsNotWaiting`
null: their cards carry no version prefix, so leave out "Not in yet" (step 4 below).

bloom-player reaches users only through the products that ship it, so `b-p` adds one entry per
product (`channel: "consumer"`): what is on bloom-player's `master` that the product's shipped
version lacks. `playerVersion` is the version it ships, read from the lockfile where it publishes
from (`shippedFrom`): Bloom Library's `release` branch, the Bloom Desktop beta's `Version<beta>`
branch (the live Beta Publish config's version), Bloom Reader's `release` branch, and BloomPUB
Viewer's latest GitHub release. Report each as its own section after the merge, titled with the
product and version ("Bloom Reader, on bloom-player 2.20.2"), with the same holding-up, no-card and
resolved lines; a card that holds one up is merged but not yet shipped there.

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
