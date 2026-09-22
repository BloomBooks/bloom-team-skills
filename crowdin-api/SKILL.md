---
name: crowdin-api
description: Drive Bloom's Crowdin projects from a script — get new English strings to translators, upload translations and screenshots, post comments and issues, find and message the translators of a language. Covers every Bloom product that localizes through Crowdin (BloomDesktop, BloomLibrary.org, Bloom Player, Bloom Reader, the docs site).
---

Apply this skill when you need to read or change something on Crowdin from code, rather than
through its web UI. It is product-agnostic: one Crowdin project holds the strings of several
Bloom products, and everything here applies whichever one you are working on.

Two documents in the **BloomDesktop** repo cover the neighbouring subjects, and this skill does
not repeat them:

- `.claude/skills/xlf-strings/SKILL.md` — how to write an entry in an XLF file.
- `DistFiles/localization/README.md` — what Crowdin does when files sync, and why a string
  must not be deleted.

Both are written about XLF, so they apply to BloomDesktop. The other products keep their
strings in JSON or Android XML, but the sync behaviour they describe — Crowdin takes the source
from GitHub, and a string that vanishes from the source takes its translations with it — is the
same everywhere.

## Never write to Crowdin as a person

Every write must go in as **SILCrowdinBot**, never a developer's account. BloomDesktop's
`DistFiles/localization/README.md` gives the reason for translations ("to avoid having a
developer's name attached"), and the same applies to comments, issues and screenshots: on
Crowdin the account name is the only provenance a translator sees.

The bot token is **not** in the process environment, so a check like `echo $TOKEN` reports
nothing and looks like the token is missing. It is in the Windows registry (a User environment
variable), readable without restarting anything. Shell state does not persist between tool
calls, so read it and use it in **one** PowerShell call:

```powershell
$t = [System.Environment]::GetEnvironmentVariable('SIL_CROWDIN_BOT_HATTON_ENV','User')
$env:BOT_TOKEN = $t
node D:/path/to/script.mjs
```

That variable name is one developer's machine. **Ask which variable holds the bot token rather
than assuming**, and don't pick one by its name: several Crowdin-looking variables usually sit
side by side (`BLOOM_CROWDIN_TOKEN`, `SIL_BLOOM_CROWDIN_TOKEN_READONLY`, …), a token whose name
says read-only may not be, and on one machine all three authenticated as the developer.

List the User variables to see what is there:

```powershell
[System.Environment]::GetEnvironmentVariables('User').Keys | Where-Object { $_ -match 'CROWDIN' }
```

**Confirm who you are before writing anything**, because a developer's own token authenticates
fine and writes succeed silently under their name:

```js
const me = await client.usersApi.getAuthenticatedUser();
console.log(me.data.username); // must be SILCrowdinBot
```

If this is caught late, it is recoverable but tedious: a translation's author cannot be
changed, so every affected translation must be deleted and re-uploaded as the bot. Filter the
deletion by author and date so a real translator's work is never caught in it.

**Text a translator will read must say it came from an AI.** Start the body with
`[AI-generated message to translators]`. Translators are professionals; state facts and leave
the translating to them. Do not explain how to use Crowdin, and do not tell them to use their
judgement.

## Getting new English strings to translators without waiting for the feature to merge

Crowdin pulls source strings from GitHub through its integration, and picks up a change within
about two minutes. Nothing in the repos pushes them; there is no GitHub Actions workflow for
it. For BloomDesktop the source is `DistFiles/localization/en/*.xlf` **on master**; the other
products' sources are the files listed under [Project constants](#project-constants), on their
own default branch.

So English strings do not have to wait for the feature branch that introduced them. Commit the
source-string change on its own to the release branch, merge that to master, and translation
can start while the code is still in review. Keep the translated language files out of that
commit: committing them does nothing on Crowdin and complicates the incoming `l10n_master`
pull requests.

Do **not** try to shortcut this by uploading the source file through the API. It works, and
then the next sync from GitHub deletes every string that the repo's copy lacks, taking their
translations with them.

Verify rather than assume, by polling until the strings appear:

```js
const page = await sourceStringsApi.listProjectStrings(PROJECT_ID, { fileId, limit: 500, offset });
```

## Project constants

Two Crowdin projects carry Bloom:

| Project | Id | Holds |
|---|---|---|
| `sil-bloom` | `261564` | The UI strings of every Bloom product |
| `sil-bloom-docs` | `515854` | The documentation site (`docs/**.md` plus its screenshot assets) |

Within `sil-bloom`, the files are grouped by product. Ids are stable; get the current list with
`GET /projects/261564/files?limit=200` rather than trusting a stale table.

| Product | File | Id |
|---|---|---|
| BloomDesktop | `DistFiles/localization/en/Bloom.xlf` | `34` |
| BloomDesktop | `DistFiles/localization/en/BloomLowPriority.xlf` | `74` |
| BloomDesktop | `DistFiles/localization/en/BloomMediumPriority.xlf` | `76` |
| BloomDesktop | `IntegrityFailureAdvice.xlf`, `TrainingVideos.xlf`, `leveledReaderInfo.xlf`, `Publish-WiFi-Network.xlf`, `CantPasteHyperlink.xlf`, `velopack.xlf` | `35`, `37`, `39`, `82`, `194`, `4392` |
| BloomDesktop | One `ReadMe-en.xlf` per book template (Big Book, Decodable Reader, Leveled Reader, Picture Dictionary, Template Starter, Wall Calendar, Playground, Sign Language, Digital Comic Book, Paper Comic Book) | `47`–`52`, `4046`, `4048`, `4054`, `4056` |
| BloomLibrary.org | `Contentful Bible Terms.json`, `Contentful High Priority.json`, `Contentful Low Priority.json`, `Code Strings.json`, `Topics And Features.json`, `Stats Strings.json` | `104`, `106`, `108`, `110`, `112`, `114` |
| Bloom Player | `bloom-player/messages.json` | `3470` |
| Bloom Reader | `strings.xml` | `67` |

**Only the BloomDesktop files sit on a branch.** They are under Crowdin branch `master`
(id `27`); the BloomLibrary.org, Bloom Player and Bloom Reader files have no `branchId` at all.
Anywhere a call takes a branch — adding a screenshot, for instance — pass `27` for a
BloomDesktop file and omit it entirely for the others.

**A language's editor code is not its language id.** `pt-PT` has `editorCode` `pt` and `es-ES`
has `es`, and the editor URL uses the editor code:
`https://crowdin.com/editor/sil-bloom/<fileId>/en-<editorCode>#<stringId>`. Get it from
`languagesApi.getLanguage(id)` instead of guessing.

The project's target languages include `es-ES` and `pt-PT`, with **no** `pt-BR` and no plain
`es` or `pt`. The region halves of those codes do not describe Bloom's actual readership:
Portuguese is read in both Brazil and Lusophone Africa, and French mostly in Africa. Do not
translate to a region because the code names it.

## Uploading translations

Upload a file containing **only the units you wrote**, rebuilt from the full translated file.
Then an upload cannot touch a string someone else owns, whatever goes wrong.

```js
const storage = await uploadStorageApi.addStorage(name, readFileSync(path));
await translationsApi.uploadTranslation(PROJECT_ID, languageId, {
  storageId: storage.data.id,
  fileId,
  importEqSuggestions: false,
  autoApproveImported: false,
  translateHidden: false,
});
```

`markAddedTranslationsAsDone` and `isShared` are rejected outright: `Field '...' is unexpected`.

`autoApproveImported: false` is what leaves each translation as an unapproved suggestion. Also
strip any `approved` attribute from the file before uploading; a build script that refuses to
run when it finds one is cheap insurance.

**`importEqSuggestions: false` silently skips any translation identical to the English.** So a
correct translation of "Style" into French, or "Simple" into Spanish, never arrives, and the
string shows as untranslated with nothing to explain why. Expect a count slightly short of what
you sent, and check which ids are missing before assuming an error.

Verify after uploading, per language: who each translation is attributed to, and that the
approval count is zero.

```js
await stringTranslationsApi.listStringTranslations(PROJECT_ID, stringId, languageId, { limit: 1 });
await stringTranslationsApi.listTranslationApprovals(PROJECT_ID, { stringId, languageId, limit: 1 });
```

Those are per string. To check a whole batch -- what every string in a file currently reads in
one language, and whether anything is approved -- page **`/projects/{id}/languages/{languageId}/translations?fileId=`**
instead. One paged call per file per language answers "do all N carry a suggestion?" and
"is the approval count still zero?", where the per-string calls would be N round trips.


## Pointing translators at just the strings you mean

A file link drops a translator into the whole file. **The Editor takes a `?q=` search on the
end of the URL** and opens filtered to the strings that match:

```
https://crowdin.com/editor/sil-bloom/76/en-es?q=AiImageEditor
```

Where the ids of a feature share a prefix, that one parameter isolates them exactly and costs
nothing: no writes to the project, nothing to maintain, and it keeps working as later strings
with the same prefix arrive. Use it in any mail or comment that sends someone to a file. `q`
matches the key, so it catches every id carrying the prefix -- including ones the app has since
stopped using (see the string-table trap below).

Crowdin's own mechanism for this is **labels** -- create one, attach it to the strings, then
filter by it in the Editor and copy the resulting URL. Prefer `?q=` unless the set you want
cannot be described by a prefix or a search: a label is a write to a shared project and has to
be re-applied to every new batch. Labels live at `/projects/{id}/labels` and a string carries
its `labelIds`.

**A language's editor code is not its language id** -- get it from `languagesApi.getLanguage(id)`
rather than guessing (see [Project constants](#project-constants)). `es-ES` is `en-es`, `pt-PT`
is `en-pt`.

## Comments and issues

```js
await stringCommentsApi.addStringComment(PROJECT_ID, {
  stringId,
  text,
  targetLanguageId: "pt-PT", // scopes it to one language
  type: "comment",           // or "issue", which then needs issueType
  issueType: "general_question",
});
```

A comment sits quietly in the comments panel. An issue is pushed at the translator and appears
in the project's issue list. Use issues sparingly, for a handful of strings.

**The response field is `languageId`, not `targetLanguageId`.** Reading back the field you sent
makes a correctly scoped comment look unscoped, which invites deleting and reposting something
that was already right.

Edit in place rather than delete and repost:

```js
await stringCommentsApi.editStringComment(PROJECT_ID, commentId, [
  { op: "replace", path: "/text", value: newText },
]);
```

## Screenshots

A screenshot is an image plus **tags**, each tying one source string to a rectangle on it; the
editor then shows a translator the picture with their string outlined. There is a working,
automated pipeline for the AI image editor in `bloom-ai-image-tools` (`pnpm screenshots:capture`
and `pnpm screenshots:upload`, `dev/uploadCrowdinScreenshots.mjs`), which is the thing to copy
for any other Bloom UI rather than starting again.

The API sequence:

```js
const storage = await uploadStorageApi.addStorage("name.png", pngBuffer); // kept 24 hours
const shot = await screenshotsApi.addScreenshot(PROJECT_ID, {
  storageId: storage.data.id,
  name: "AiImageEditor/settings-dialog.png", // a slash in the name is fine
  autoTag: true,          // Crowdin's OCR tags what it can recognise
  branchId: MASTER_BRANCH_ID, // BloomDesktop strings only; omit for the other products
});
const tagged = await screenshotsApi.listScreenshotTags(PROJECT_ID, shot.data.id, { limit: 500 });
await screenshotsApi.addTag(PROJECT_ID, shot.data.id, [
  { stringId, position: { x, y, width, height } }, // pixels, from the top-left
]);
```

- **Let the OCR go first, then add your own tags for what it missed.** `replaceTags` with an
  array wipes the OCR tags; `addTag` adds to them. Filter your list against
  `listScreenshotTags` first, or you get the same string twice. The OCR is good: on the editor's
  screenshots it found roughly two thirds of the strings unaided.
- **`branchId` is accepted by `addScreenshot` and rejected by `listScreenshots`** --
  `Field 'branchId' is unexpected`, a 400. List them unfiltered and match on the name prefix
  you gave them (`AiImageEditor/...`), which is the only thing tying a screenshot to a feature.
- **Find a screenshot by name to update it** (`listScreenshots(PROJECT_ID, { search: name })`,
  then compare `name` exactly) and call `updateScreenshot(id, { storageId, name,
  usePreviousTags: false })`. Re-running a script then replaces rather than piling up copies.
- **The uploader cannot be changed.** Updating in place keeps the account that first created
  the screenshot, so screenshots uploaded under a developer's name have to be deleted
  (`deleteScreenshot`) and created again as the bot. Filter the deletion by `userId`.
- Several tags may cover the same rectangle: two ids with the same English ("Estimate {0}" and
  "Estimate {0}{1}") should both be tagged, since the text alone cannot say which is on screen.
- Resolve a string's numeric id by paging **each file** with `listProjectStrings(PROJECT_ID,
  { fileId, limit: 500, offset })` and comparing `identifier` exactly. The
  `filter`/`scope: "identifier"` search is case-insensitive and crosses files, and the products
  share a project, so asking for BloomDesktop's `Common.Close` also returns BloomLibrary.org's
  `common.close`. Always constrain by `fileId`.
- Crowdin's CLI can upload a screenshot (`crowdin screenshot upload`, upsert by file name) but
  can only OCR auto-tag; it has no way to place a tag. The hosted MCP server
  (`https://mcp.crowdin.com/v2/mcp`) has a `screenshots` tool set and is handy for looking at
  the project interactively, not for a repeatable command.
- Anything visible in the screenshot goes to every translator. Mask a field that shows an API
  key (`-webkit-text-security: disc` through an injected style) before capturing, and delete
  any Playwright trace from a failed attempt, which holds unmasked frames.

## Who translates a language, and how to reach them

The API never gives an email address. `listProjectMembers` returns `username`, `fullName`,
`role` and, for translators, `permissions` per language id (`"fr": "translator"`,
`"pt-PT": "proofreader"`); the public user endpoint has no email either.

The rights list is long and mostly dormant (22 to 27 names per language for Bloom). Membership
is per project, not per product, so a name on the list may only ever have worked on one of the
products. To see who actually works on a language, generate the **top-members report**:

```js
const started = await reportsApi.generateReport(PROJECT_ID, {
  name: "top-members",
  schema: { unit: "words", format: "json", languageId: "fr", dateFrom, dateTo },
});
// poll reportsApi.checkReportStatus until status === "finished", then
const { data } = await reportsApi.downloadReport(PROJECT_ID, started.data.identifier);
const rows = await fetch(data.url).then((r) => r.json()); // rows.data[].user, .translated, .approved
```

**Do not decide who works on a language from `permissions[languageId]` alone.** The most
productive contributor on a language can have no entry there at all: a project-wide
`role` of `"translator, proofreader"` carries the rights without a per-language key, and the
per-language map otherwise reads `denied` for every language a person is not on. On Bloom the
top Portuguese contributor by a wide margin -- more words than the named proofreader -- has an
empty `permissions` map. Rank by the report's `translated`/`approved`, then read `role` and
`permissions` only to describe the people it found.

Excluding the non-translators is manual: the report counts the bot (`SILCrowdinBot`), the
project owner and any manager who has touched a string, and they sit among the real names.

Sending them something: `notificationsApi.sendNotificationToProjectMembers(PROJECT_ID,
{ userIds, message })` posts a plain-text notification that Crowdin shows in the bell menu and,
by default, emails. There is no reply channel, so put a contact address in the text, and it
carries the same `[AI-generated message to translators]` rule as any other text. The
person-to-person "Send message" on a profile page (`https://crowdin.com/profile/<username>`)
exists only in the web UI.

## Deleting a translation

The method is `deleteTranslation(projectId, translationId)`. There is no
`deleteStringTranslation`; the plausible name throws `is not a function` at runtime, after the
script has already started working. `deleteAllTranslations` exists too and takes out other
people's work, so prefer deleting the specific ids you listed.

## Traps that cost real time

- **`fileId` and `branchId` are mutually exclusive** in `listProjectStrings`. Sending both is a
  400. Pass `fileId` alone.
- **`addString` does not work on XLIFF files.** Strings arrive by file sync, not one at a time.
- **CroQL has no `identifier` field.** `identifier = '...'` fails with a complaint about
  datetimes, which points nowhere near the cause. Filter by identifier with
  `{ filter: id, scope: "identifier" }` and compare exactly, since the filter matches loosely.
- **String ids can contain spaces**, because some are derived from display text
  (`...Option.Asian (General)`). Splitting a list of ids on whitespace silently produces more
  entries than you had. Split on lines.
- **`node -e` with a multi-line double-quoted script can print nothing and exit 0.** Write the
  script to a file instead of reading the silence as a passing check.
- A throwaway script must live **inside the package directory** to resolve
  `@crowdin/crowdin-api-client`, not in a scratch directory. Write it, run it, delete it. Or
  keep it in scratch and resolve through the package:
  `createRequire("file:///D:/repo/package.json")("@crowdin/crowdin-api-client")`.
  In a repo that has no such dependency, PowerShell's `Invoke-RestMethod` against
  `https://api.crowdin.com/api/v2/...` with an `Authorization: Bearer` header does everything
  the client does, and needs nothing installed.
- **The product's own string table and Crowdin can disagree.** When a UI reads its strings
  from a table (`ALL_IMAGE_EDITOR_STRINGS` in bloom-ai-image-tools), an id can be in that table
  and absent from the source file, or the reverse; the UI then asks for a string Crowdin has
  never seen, and it stays English. Compare the two lists after any change to either. The reverse
  case is the one that wastes a translator's time: an id the app has stopped asking for stays in
  the XLF, so Crowdin still offers it and people translate it for nothing. **Do not answer that
  by deleting the string** -- Crowdin re-syncs it from master within minutes, and deleting the
  trans-unit at source takes its translations with it, permanently. Mark it obsolete instead;
  BloomDesktop's `DistFiles/localization/README.md` ("Why we can't just delete a string") has
  the reasoning and the one exception, and is written to pre-empt the argument that a particular
  deletion is safe. Check the id against the app before assuming it is dead: a string can be
  dropped from the table while the code still renders it, for a feature that is switched off
  rather than removed.

## What Crowdin actually shows a translator

**An XLF `<note>` element becomes the string's context field**, joined with the file name and
the id — the same slot the other formats' comment mechanisms feed. So a translator context note
written in the source file does reach the person who needs it, and is the right place to explain
a string. Notes that only make sense as part of a list do not work here: each string is read on
its own.

**Crowdin does not decode XML entities on import.** An XLF source of `Theme &amp; Layout`
reaches the translator as the literal text `Theme &amp; Layout`. This is not a mistake in the
XLF — `&amp;` is the correct escape, and Bloom has written it that way throughout — and it
affects every XLF string containing an ampersand. Worth knowing before diagnosing it as a fault
in a new string.

**Screenshots are visible in the editor without being announced**, so a note telling a
translator to look for one adds nothing.
