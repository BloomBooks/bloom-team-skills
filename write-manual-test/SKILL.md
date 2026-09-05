---
name: write-manual-test
description: Write or rewrite a manual test case in Notion — exact steps a tester follows, "Verify" checkboxes, and a screenshot for every verification. Use when asked to write, fix, or flesh out a manual test / test case / test card in Notion. Not for tracker-card test ideas (that is add-test-ideas).
argument-hint: "the Notion test card URL, or the feature the new card should cover"
user-invocable: true
---
# Writing a manual test case in Notion

A test case is not a test plan. `add-test-ideas` writes prose about what a tester *might*
poke at, and it goes on a YouTrack card. This skill writes the other thing: a **script** in
**Notion** that one tester follows top to bottom and either passes or fails, with no judgement
calls left to them.

So the bar is different, and higher:

- **Every step is an instruction you have performed yourself**, in the real product, in this  
order, with this book. Never write a step you have only read in the code, unless the test is about integration with other products or the OS, which cannot be readily tested through browser automation.
- **No optional tests.** Either something is in the test or it is not. Delete "if you have
time" and "you may also want to".
- **Every verification has a screenshot** under it, showing exactly what a pass looks like.
- **The tester starts from a prepared artifact**, not from a construction job.

## 1. Learn the feature before you write anything

1. Find the control in the front-end source, then follow it to the C# that computes what it
 shows. Write down each rule as a sentence: "a language with an incomplete translation is
 not checked by default".
2. Confirm **every** rule in a running Bloom. Use the `bloom-automation` skill to drive it
 over CDP. A rule you could not make happen on screen does not go in the card.
3. Quote UI text exactly as the product says it, from `DistFiles/localization/en/*.xlf`, not
 from memory. Tooltips, dropdown values, and button captions are what the tester matches
 against.

4. If the feature is behind a subscription tier, learn what a person **without** that
 subscription can do with books that used it, and write those rules down too. Subscribers make
 books; the people who reuse them, above all to translate them, often have no subscription, and
 the Bloom project treats any obstacle to that reuse as a high-priority bug. The card must test
 a derivative made below the tier: every text translatable, pictures replaceable, audio
 recordable, the book publishable; the feature's own add/restructure affordances absent or
 showing the subscription dialog; the original's Publish tab blocked and the derivative's not.
 What is expected here is a product decision: ask the developer rather than reading it off the
 code.

## 2. Build one artifact that exercises every rule

One book, chosen so each rule fires somewhere in it. For the Text Languages list, one book
carried: three complete languages, one language present only in the front matter, and a
fourth state (an incomplete translation) that the tester creates in step 2 of that test.

Then **order the tests around the states you cannot undo**. If clicking a check box makes a
setting explicit for the rest of the book's life, every test of default behaviour must come
before the test that clicks it. Getting this wrong is the most common way one of these cards
becomes unrunnable.

## 3. Host the artifact on dev.bloomlibrary.org

This is our place to keep test books today. It costs the tester one download and no setup.

**Where this is going:** the repo of test books and collections now exists,
https://github.com/BloomBooks/bloom-testing-inputs, pinned by `build/testing-inputs.pin` in
BloomDesktop. A repo versions the book with the test, needs no upload account, and gives an
automated test a fixture folder to copy instead of a download. Its own rule, though, is that a
test builds its own collection unless the fixture is too expensive to build at run time, such as
a collection of 200 books. So prefer a card whose setup a test can perform, and do not build
anything that assumes dev.bloomlibrary.org is permanent.

- **Upload through Bloom itself** (Publish → Web), not by putting files on S3. Only the Bloom
upload writes the database record that the site and the download need. Bloom uploads to the
sandbox when `libraryPublish/useSandbox` is true, and the button then reads
`UPLOAD BOOK (TO DEV.BLOOMLIBRARY.ORG)`.
- **Name the book for the test**: `TC147 Text Languages Test Book`. The test id goes first, so
the book is findable from the card and the card is findable from the book.
- **Put the tie in the summary too**, and warn people off: "TEST BOOK. Do not translate or
reuse. This book exists only to run the manual test "Text Languages Publish List" (test case
TC147)…"
- Put the book's URL in the card. The tester clicks **Translate into your language!**, then
**DOWNLOAD BOOK** in the "Almost there…" dialog. Bloom puts the book under
**Sources For New Books → Books From BloomLibrary.org**. From there they click it once, then
click **MAKE A BOOK USING THIS SOURCE** to get an editable copy in their own collection.
(That button is `forEdit=false`, so it never makes a new collection.)
- A derived book keeps the source's languages, its front-matter-only languages, and its
`publish-settings.json`, so the state you uploaded is the state the tester starts from.
Confirm that once, by making the book yourself, before you trust it.

## 4. Shape of the card

```
callout      Test id, where the book comes from, "do the tests in order".
## What this test covers   one paragraph, then the rules as bullets
## The test book           name, URL, what is in it
## Setup                   numbered: make the collection, download, make the book
## Test 1 — <what it is about>
  numbered steps (one action per step, in the product's own words)
  Verify … checkboxes
  screenshot
## Test 2 — …
```

- **Numbered list** for a step the tester performs. **To-do checkbox starting with the word
`Verify`** for something they must confirm. Never mix the two in one line.
- One test section per rule, named for the rule, not for the mechanism.
- A test that changes the book **restores it** in its last step, unless a later test wants the
change.
- Give the exact string for anything the tester reads: the tooltip, the sub-label, the
dropdown value.
- Say why when the product looks wrong but is not — for example that the Bloom Player menu
uses a language's own name (`español (Spanish)`) while Bloom's own list uses `Spanish`.

## 5. Screenshots

Take them **during your own run of the finished card**, in the card's order, so the images and
the steps cannot drift apart.

- Crop to the control (`Page.captureScreenshot` with a `clip` from the element's rectangle,
`scale: 2`), not the whole window. A full screenshot of Bloom is unreadable in Notion.
- Move the pointer to `5,5` before each shot, or a stale tooltip arrow shows at the edge.
- For a tooltip, hover with a real `Input.dispatchMouseEvent`, wait about 1.8 seconds, then
clip to the union of the control and `[role=tooltip]`.
- Name the files `01-…`, `02-…` in card order. It is the only thing that keeps a rebuild
honest.

## 6. Posting to Notion

Notion has no importer for this; use the REST API. `notion.py` beside this file has the
helpers.

- Token: the `BLOOM_TESTCASE_NOTION` environment variable. Header `Notion-Version: 2022-06-28`.
- **Rewrite, do not patch.** `GET blocks/<page>/children`, `DELETE` each one, then `PATCH`
the new body in batches (100 blocks per call is the limit; 50 is comfortable).
- Images are a two-step upload: `POST /v1/file_uploads` with `{filename, content_type}`, then
a multipart `POST /v1/file_uploads/{id}/send`. The block is
`{"type":"image","image":{"type":"file_upload","file_upload":{"id": id}}}`. **Each upload id
is good for one block**, so upload again if you rebuild the page.
- Afterwards, read the children back and check that the image blocks came back with a
`file.url`. That is the only cheap proof the pictures actually landed.

## 7. Keep the card easy to automate later

Most of a card like this can become a Playwright test against the real `Bloom.exe`, so do not
write steps that fight that.

- **Assert state, not pixels.** The screenshots are for the human reader. An automated version
  reads the control's own text and its `checked` and `disabled` state, and needs no image
  comparison.
- **Setup is the part to automate away.** A fixture collection copied to a temp folder replaces
  the download and the "make a book using this source" step. The download itself is also
  scriptable if you want it covered.
- **Collection settings have no API.** `collectionSettings/changeLanguage` only feeds the open
  WinForms dialog, whose only listener is `CollectionSettingsDialog`. To change the collection
  languages, quit Bloom, write the `.bloomCollection`, and start Bloom. `bloomApp.restart` in
  `src/BloomE2E` does exactly that, and costs about six seconds, so a step that changes a
  collection language is automatable. It does lose whatever the editor had not yet saved.
- **Name the state you depend on.** Say which setting a test needs at its start, so an
  automated version can reach that state directly instead of replaying the tests before it.

## Quality bar before you hand it over

- Every step was performed, in this order, on this book.
- Every `Verify` line has a screenshot under it.
- Nothing is optional.
- Every quoted string was copied from the product, not typed from memory.
- The tester needs nothing but the card, Bloom, and a browser.

