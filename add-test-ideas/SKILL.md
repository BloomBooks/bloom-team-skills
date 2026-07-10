---
name: add-test-ideas
description: Write manual test ideas / a QA test plan for a feature or change, aimed at a Bloom-savvy but semi-technical tester. Use when asked to "add test ideas", "write manual testing ideas", "make a test plan for QA", or to put testing notes on a YouTrack card. Leads with a plain-language explanation of how the feature works, then testing ideas, then the risky parts to watch.
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

1. **What this is and how it works (lead with this).** A short, plain-language summary, from the
   *user's* point of view, of what the feature does and how it behaves. Include any mental model
   the tester needs up front — for example "the first time you use it you need to be online, but
   after that it works offline," or "this setting only takes effect after a restart." This
   section is what makes the rest make sense; spend real effort on it.

2. **Testing ideas, grouped by area.** Walk through the feature the way a user would meet it.
   Give each area a short heading and, under it, concrete things to try written as *do this →
   expect that*. Prefer real, specific examples ("try Thai and Myanmar", "a collection with only
   two languages") over abstract ones. Where behavior differs by condition (online vs. offline,
   one computer vs. another, first time vs. later), say so explicitly and ask them to try both.

3. **The risky parts — what to watch especially.** Call out, in its own section (or clearly
   flagged inline), the parts that are most likely to be wrong or that would be worst if they
   were: brand-new or reworked logic, anything about data being saved/synced/lost, anything with
   edge cases (empty, missing, offline, first-run), and anything that used to be broken and was
   just fixed (say what the old broken behavior was, so they can confirm it's gone). Testers have
   limited time; tell them where to spend it.

Keep bullets to one idea each, but let each bullet be a full sentence or two. It's a document to
read, not a spec to parse.

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
- If asked to **revise** an existing test-ideas comment, update that same comment
  (`POST …/issues/<id>/comments/<commentId>`) rather than posting a new one.
- If it's wanted somewhere else (a doc, a PR comment, a message), same content, same voice.

## Quality bar before you post

- Does it **open with how the feature works**, in user language?
- Could a semi-technical Bloom tester **follow every step** without asking a developer what a
  word means?
- Is every item **do-this → expect-that**, with specific examples?
- Is there a clear **"watch these especially"** for the risky/just-fixed/data-affecting parts?
- Did you prompt them to try the relevant **conditions** (online/offline, different computers,
  first run vs. later) where they matter?
