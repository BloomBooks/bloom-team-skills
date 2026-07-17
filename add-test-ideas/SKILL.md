---
name: add-test-ideas
description: Write manual test ideas / a QA test plan for a feature or change, aimed at a Bloom-savvy but semi-technical tester. Use when asked to "add test ideas", "write manual testing ideas", "make a test plan for QA", or to put testing notes on a YouTrack card. Leads with a plain-language explanation of how the feature works, then testing ideas, then the risky parts to watch.
argument-hint: "optional: a BL-xxxxx card id or PR/branch to base the test ideas on — defaults to the current branch's change"
user-invocable: true
---

# Writing manual test ideas

Use this when someone asks for manual **test ideas**, a **test plan**, or **QA notes** for a
feature or change — often to post as a comment on the YouTrack card. The goal is a document a
human tester can actually follow.

The single most important thing: **start by explaining how the feature works**, in plain
language, before you list anything to test. A tester who understands what the feature is *for*
and how it's *supposed* to behave will test it far better than one handed a bare checklist. That
explanation is the backbone of the whole write-up.

## Who you're writing for

A tester who **knows Bloom well but is only semi-technical**. They know Collection Settings, the
Book Making tab, editing books, Team Collections, languages, publishing, etc. They do **not**
think in code. So:

- Write **whole sentences**, not terse checklist fragments.
- Describe **what the tester does and what they should see**, in the words of the Bloom UI.
- **No developer jargon.** Never mention code-level things like class names, DOM attributes,
  file internals, threads, endpoints, or data structures. Translate every such idea into what a
  user does or sees. Some common translations:

  | Don't write (dev-speak)                     | Do write (tester-speak)                                   |
  | ------------------------------------------- | -------------------------------------------------------- |
  | "a bloom-editable" / "the data-div"         | "a text box in the book"                                 |
  | "the resolution cascade / the resolver"     | "how Bloom decides which keyboard (etc.) to use"         |
  | "blocks the UI thread"                      | "Bloom freezes / hangs for a few seconds"                |
  | "canvas element"                            | "a text box added on top of a picture (an overlay)"      |
  | "inspect the .htm / the saved attributes"   | "save, close, and reopen the book; check it looks right" |
  | "the API returns an empty array"            | "the list comes up empty (but doesn't error)"            |

  If you truly must name a file or folder the tester has to find (e.g. a cache folder to
  delete), name it plainly and say where it is — that's fine; deep code internals are not.

## Structure of a good test-ideas write-up

Two sections are **always present**: the plain-language explanation at the top and the "watch
these especially" summary at the bottom. Between them is a **menu of dimensions** — run through
*every* one so nothing gets missed, but only include the ones this change actually touches. Do
**not** pad the write-up with empty "Migration: N/A" sections; a dimension you leave out reads as
"not relevant here," which is what you want. Order the ones you include roughly the way a tester
would meet the feature.

**Always, at the top:**

1. **What this does and how it works (lead with this).** A short, plain-language summary, from
   the *user's* point of view, of what the feature does and how it behaves. Include any mental
   model the tester needs up front — for example "the first time you use it you need to be online,
   but after that it works offline," or "this setting only takes effect after a restart." This
   section is what makes the rest make sense; spend real effort on it.

**The middle — a menu of dimensions (include each only when the change touches it):**

2. **Setup / where to find it.** What the tester needs before they can even see the feature: a
   particular kind of collection or book, a certain subscription tier, a setting turned on, a
   feature flag, being online. Save them the guesswork of reproducing the starting state.

3. **Normal use (the happy path).** The main flows a typical user runs, as *do this → expect
   that*. Prefer real, specific examples ("try Thai and Myanmar", "a collection with only two
   languages") over abstract ones.

4. **Boundaries and edge cases.** The extremes: empty / none / one / many / very large; the
   first-ever run vs. later; minimum and maximum; long names, special characters, right-to-left
   and complex scripts; a language or option that isn't there.

5. **Error and failure situations.** What happens when things go wrong — offline, a missing or
   moved file, no permission, a disk full, the operation cancelled halfway, invalid input, two
   things happening at once. The point is usually "does Bloom fail *gracefully* (a clear message,
   nothing lost) rather than crash or corrupt?"

6. **Interactions with other Bloom features.** Other parts of Bloom that touch the same data or
   area and could be knocked over by this change — e.g. spreadsheet import/export, Team
   Collections (sync/checkout), publishing, duplicating a book, other editing tabs, undo/redo.
   Ask the tester to exercise the feature and then use these to confirm nothing downstream broke.

7. **Interactions across the Bloom ecosystem.** Whether the change carries correctly into the
   *other products*: Bloom Reader, Bloom Library (upload/download and the harvester), BloomPUB and
   BloomPUBViewer, the Bloom apps, and ePUB. Especially anything that changes what gets saved into
   or published from a book.

8. **Migration and backward compatibility.** Round-tripping across Bloom versions: an older book
   or collection opened in *this* build (does it upgrade cleanly?), and — where it matters — a book
   made in this build opened in an *older* Bloom (does it survive, or at least fail safely?).
   Anything that rewrites a saved format belongs here.

9. **Subscription / tier behavior.** Where behavior depends on the subscription level: what a
   lower tier sees vs. a higher one, gated features, and what happens right at the boundary (a
   book using a feature the current tier doesn't include).

10. **Performance and scale.** Large collections and books, many pages / images / languages,
    responsiveness under load — Bloom shouldn't freeze, hang, or balloon in memory. Give a
    concrete "big" case to try.

11. **Platform and environment differences.** Where the result depends on the environment:
    Windows vs. Linux, different machines, the UI in a non-English language, screen size / zoom.
    Ask them to try the combinations that matter here.

**Always, at the bottom:**

12. **Watch these especially — the risky parts.** This is not a peer section; it's the closing
    summary that points a time-limited tester at where to spend their attention. Call out the
    items from above that are most likely to be wrong or worst if they were: brand-new or reworked
    logic, anything about data being saved / synced / lost, and anything that used to be broken and
    was just fixed (say what the old broken behavior was, so they can confirm it's gone).

Keep bullets to one idea each, but let each bullet be a full sentence or two. It's a document to
read, not a spec to parse.

Where the write-up is a list of concrete things to *try* (the normal-use, boundary, and error
sections especially), prefer **Markdown checkbox items** — `- [ ] do this → expect that` — so the
tester can tick each one off as they go and see at a glance what's left. Use them wherever a bullet
is an action the tester performs; keep plain prose for the explanatory parts (the "how it works"
lead-in, and the reasoning inside "watch these especially"), where a checkbox would make no sense.
Don't force everything into checkboxes — they're for the do-this items, not for narrative.

### When there's nothing for a tester to do

Some changes have no user-observable behavior to exercise — a pure internal refactor, a
build/CI/tooling change, dependency bumps, comments or developer docs. **Still post the comment;
never silently skip it.** A tester (or the developer) needs to see that testing was *considered*
and deliberately found unnecessary — an absent comment is ambiguous (was it forgotten?), an
explicit one is a decision.

In that case the whole body is a short, plain-language note: state that there's nothing here for a
manual tester to do and **why** in the user's terms (e.g. "this only reorganizes code behind the
scenes — nothing a user sees, opens, or saves changes"). Keep the marker line so it still updates
in place. If you're not certain the change is truly invisible to users, don't claim it is — pick
the one or two things worth a sanity check ("just confirm the affected screen still opens and looks
normal") instead of declaring nothing to test.

## Earn every item — is there a plausible way *this change* breaks it?

Choosing the right *dimensions* is only half the job. Within a dimension you're including, every
individual item still has to **earn its place**, and most bad test notes fail here: they list
things that are *true and worth knowing* but that **this particular change has no plausible way of
breaking**. A tester's attention is finite. Every can't-really-break item you list dilutes the
ones that can, and quietly trains the tester to skim.

So before you write down any item, apply this filter — **name the mechanism**:

> "By what concrete mechanism could *this change* make this fail?"

If you can name a plausible mechanism (even an unlikely one), keep the item. If the outcome is
**guaranteed by how Bloom already works, independent of this change**, cut it — you are not
testing the change, you are re-testing Bloom.

Two moves make this concrete:

- **Trace it to the change, not to the feature in the abstract.** Ask what the change actually
  *does* (adds a hidden folder, writes a new attribute, adds a new save/exclusion path, new
  matching logic) and whether *that* touches the thing you're about to ask the tester to confirm.
  If the path from the change to the failure doesn't exist, there's nothing to test.

- **Watch for "it's just a normal X now" items.** When a change produces something that
  afterward behaves as an ordinary, pre-existing kind of thing (an ordinary book image, an
  ordinary text box), confirming that the *ordinary* thing still does ordinary things is almost
  always a can't-break item — the ordinary behavior was never in the change's path.

Worked examples, from a real run on the AI Image Editor:

- ❌ *Cut.* "A book that already contains AI-edited pictures, opened in a lower-tier collection:
  the pictures still display fine (they don't disappear)." — Once committed, an AI-edited picture
  **is** an ordinary book image. Nothing in the change alters how ordinary images render, and tier
  gating controls whether you can *make new* edits, not whether existing images display. There is
  no mechanism by which they could "disappear." Not a test.
- ❌ *Cut.* "A book edited with AI opened in an older Bloom shows the pictures as ordinary images
  and is fine." — Same reasoning: the older Bloom is reading ordinary `<img>`s and ignoring an
  unknown hidden folder. No path from the change to a failure.
- ✅ *Keep.* "Upload / publish / Team-Collection / `.bloomSource` all exclude the hidden
  `.ai-image-editor` folder but still carry the edited images." — The change added a **new,
  narrow exclusion in the packaging code**; that code genuinely can get the boundary wrong. Real
  mechanism, real test.
- ✅ *Keep.* "Replace two identical pictures on one page with different results; each lands on the
  right slot." — The change added **new matching logic** to pair results with slots. It can
  plausibly mis-pair. Real test.

This filter is not a licence to trim the scary items. Data-loss, new logic, and just-fixed bugs
have obvious mechanisms and stay. The point is to spend the tester's checkboxes only where the
change could actually go wrong.

## Deciding what's risky

You usually know the change (you or another agent just made it, or it's on the card/PR). Flag as
risky the things that match:

- **New or substantially reworked behavior** — the core of what the card added.
- **Anything touching saved data or syncing** — could silently lose or corrupt a user's work.
- **Edge cases and failure paths** — offline, missing files, no matching option, a language that
  isn't there, the first-ever run.
- **Just-fixed bugs** — re-verify the specific thing that was broken; describe the old symptom.
- **Cross-machine / cross-OS differences** — where the result depends on the environment.

If you're unsure how something behaves, don't guess in the write-up — either read enough of the
code/PR to be sure, or phrase it as a question for the tester ("confirm whether …").

## Where it goes

- Usually a **comment on the YouTrack card.** Post it with the **`youtrack-api`** skill
  (auth, base URL, POST a comment). For a body with headings/quotes, write the Markdown to a file
  and `curl -d @file.json` after JSON-encoding (`jq -Rs '{text: .}' body.md > body.json`).
- **Prefix the comment** with an identifier of which model you are (per the user's identity
  convention, e.g. `[Claude Opus 4.8] …`), since it posts under their account.
- If it's wanted somewhere else (a doc, a PR comment, a message), same content, same voice.

### Update in place (the default) — don't stack duplicates blindly

The normal case is **one live test-ideas comment per card**, refreshed in place. Each run should
find that comment and rewrite it rather than pile on a new one every time (preflight, in
particular, calls this repeatedly as a PR evolves). A stable marker makes it findable:

- **Marker.** Make the marker the *first line of the body*, on its own:
  `<!-- bloom-test-ideas -->`. Put the identity prefix and the human title on the next lines.
  Include it regardless of whether YouTrack renders HTML comments visibly — a stray marker line
  showing in the text is a fine price for reliable find-again.
- **Find-or-create.** Before posting, list the card's comments asking for `id` and `text`
  (`GET …/issues/<id>/comments?fields=id,text`) and look for ones whose text contains
  `bloom-test-ideas`.
  - **Found →** update the **most recent** marked comment in place:
    `POST …/issues/<id>/comments/<commentId>` with the new full body (marker line included).
  - **None →** create a new comment (marker line included).
- Always write the **complete** refreshed body, not a diff — the update replaces the whole text.

**Re-derive from the current code — never just touch up the old text.** When you refresh an
existing comment, treat its content as **possibly describing superseded behavior**, not as a
trustworthy base to lightly edit. A branch evolves, and a later commit can *change or outright
reverse* what an earlier one did (real case, BL-16569: an early commit dropped per-computer grid
layout persistence and the notes said so; a later commit **brought it back** in a new form and
added a Reset button — but the comment still described the dropped-persistence design and had
"fallen behind"). The failure mode is regenerating the notes by reading the *old comment* instead
of the *current code*, which silently carries the reversed claim forward and sends the tester to
verify behavior that no longer exists. So when updating in place:

- **Re-read the current diff/code for HEAD and re-ground every claim in it.** Diff against the
  base branch (`git diff <base>...HEAD`), not just the last commit, so a mid-branch reversal is
  visible. If the caller (e.g. preflight) says "base the write-up on the final diff," that is
  exactly why.
- **Verify each sentence you keep from the old body still matches the code** — especially any
  statement of the form "X now happens" / "Y is no longer remembered" / "the default is now Z."
  Those are the ones a reversal invalidates. If a claim no longer holds, rewrite it to the current
  behavior and flag the flip in "watch these especially" (a reversed design is a genuinely risky
  spot: the old behavior can resurface as a regression).
- The safest habit is to write the refreshed body **from the code**, then check the old comment
  only to preserve voice and any still-accurate framing — not the other way around.

### When a *new* comment is the right call instead

Updating in place is the default, but it isn't a hard rule — before you overwrite, pause and ask
whether replacing the old text would erase context a reader still needs. The overwrite is right
when the write-up is simply the current, best plan for testing this change and nobody has acted on
the old one yet. A **new** comment can be the better choice when the history matters — most often:

- **Testers have already worked from the previous notes**, found bugs, and now there's a fresh
  round of changes. Overwriting would silently discard what they already checked. A new comment
  can say, in plain terms, **what changed since last time and so what needs *re*-testing** — and,
  just as usefully, **what does *not* need retesting** — rather than making them re-run everything.
- Any time the previous comment is a record worth keeping (e.g. the tester ticked boxes or replied
  to it) and a clean "round 2" is clearer than an edit that loses that trail.

This is a judgment call, not a formula — it will be rare. When you do add a new comment, still give
it the marker (so future runs update *it*, the most recent, and leave the earlier ones as history),
and open it by orienting the reader ("Round 2 — since the testing above, X and Y changed; please
re-test A and B; C is unaffected"). When unsure, prefer the in-place update; only branch to a new
comment when you can name what would be lost by overwriting.

## Quality bar before you post

- Does it **open with how the feature works**, in user language?
- Could a semi-technical Bloom tester **follow every step** without asking a developer what a
  word means?
- Is every item **do-this → expect-that**, with specific examples?
- Does **every item have a plausible failure mechanism tied to this change**? Cut any
  "can't-really-break" confirmations (especially "it's just a normal X now" items) — they dilute
  the tester's attention.
- Is there a clear **"watch these especially"** for the risky/just-fixed/data-affecting parts?
- Did you prompt them to try the relevant **conditions** (online/offline, different computers,
  first run vs. later) where they matter?
- If you're **updating an existing comment**, did you re-derive it from the **current** diff/code
  rather than lightly editing the old text — and confirm no claim carried over from the previous
  version has since been changed or reversed by a later commit on the branch?
