---
name: bloom-docs
description: Write, edit, or review pages on the Bloom docs site (docs.bloomlibrary.org). The pages live in Notion and are published by docu-notion, so an agent writes them through the Notion API, not as markdown in the bloom-docs repo. Use when asked to document a Bloom feature, add or fix a docs page, link Bloom's UI to a docs page, or read what the docs already say.
---

# Bloom docs site (docs.bloomlibrary.org)

## How a page gets from Notion to the site

1. Pages are written in Notion, under the docs root page.
2. The GitHub repo **BloomBooks/bloom-docs** runs
   [docu-notion](https://github.com/sillsdev/docu-notion) (`pnpm pull`), which turns every
   page whose Status is `Publish` into Docusaurus markdown under `docs/`, downloads its images
   next to it, and commits the result.
3. The workflow `release.yml` ("Notion->Crowdin->Publish") pulls, builds, and uploads to S3
   behind Cloudflare. **Someone starts it by hand** from the Actions tab (the Notion page "Kick
   off a build" has the clicks); there is no schedule.

So:

- **Never write a page as markdown in the bloom-docs repo.** docu-notion deletes every `.md`
  under `docs/` that it did not write, on the next pull. The only exceptions are
  `static-docs/*` (copied in at build time) and `docs/Help/Reference` (converted from the old
  help files).
- **Never start `release.yml`**, and never set a page's Status to `Publish`, without the user
  asking. Either one publishes to every Bloom user.
- A page that leaves `Publish` stays on the site with its last pulled content, because the
  pull does not clear old files. Removing a page from the site means deleting its `.md` in the
  repo as well.

## Notion ids

| What | Id |
|---|---|
| Docs root page (holds the Outline and the Database) | `043c6aa5842946bdbea3a4f37c97a0e7` |
| The Database (every content page) | `915e28ea-feab-4970-a6c5-180d34a772e2` |
| The Outline | `4e0e7311-8b8d-4f72-846f-dddca00e2da4` |
| "Docs Instructions" (the team's own authoring guide) | `45f03aeb-4b90-4bb6-a0cf-521153b62c19` |
| "✨AI Reviewer Instructions" (plain-English rules) | `2ab4bb19df1280a28b8df64fb4011a63` |

Outline section pages have ids of their own; find them with `py notion_docs.py dump <outline>`
and then the section. For example, "Images in Bloom" under "Bloom Editor" is
`90d9109c-3804-4302-a64e-05aeda98c523`.

**Read "Docs Instructions" before a first page.** Its child pages are the team's rules:
"Bloom Docs Style Guide", "Add a new knowledge base page", "Outline Page Structure", "The
importance of slugs", "Numbered lists with material in-between", "Callouts", "Notion Image
Blocks", "Making good screenshots", "Index Pages", "Keywords". The sections below summarize
them, but the pages win if they disagree.

## Access: a Notion personal access token

Each developer uses their own **personal access token**. It reaches every page its owner
can reach, so no page has to be shared with it.

1. Open https://app.notion.com/developers → **Personal access tokens** → **New token**,
   choose the workspace, and choose an expiry (the longest is 1 year).
2. Store it in the User environment variable `SIL_BLOOM_DOCS_NOTION_TOKEN` (the name
   bloom-docs' `pnpm pull` also reads):
   `[Environment]::SetEnvironmentVariable('SIL_BLOOM_DOCS_NOTION_TOKEN','<token>','User')`

A shell keeps the value it started with, even after the variable is replaced, so
`notion_docs.py` reads the User value from the registry on Windows.

Notion's other kind of access, an **internal connection** (what Notion used to call an
integration), is made at https://app.notion.com/developers/connections and sees only the
pages shared with it, through a page's **•••** menu → **Connections** → **+ Add connection**.
A 404 whose message says "Make sure the relevant pages and databases are shared with your
integration" means a connection's token was used on a page nobody shared with it. Two such
connections exist and neither can reach the Outline: `DN-Reviewer`
(`SIL_BLOOM_DOCS_REVIEWER`, used by the docunotion-reviewer tool, sees only the Database) and
`test-management-access` (`BLOOM_TESTCASE_NOTION`, the test inventory; sees none of the docs).

## The Database's properties

| Property | Values and use |
|---|---|
| `Name` | The page title, which becomes the page's only H1. Title Case. |
| `Slug` | **Required** for a published page (the pull runs with `--require-slugs`). The URL is `https://docs.bloomlibrary.org/<slug>`. Existing pages write it with no leading slash (`image-buttons`). Dashes only, no spaces or other punctuation. The `Detected Problems` formula shows "‼Missing Slug‼" when it is empty. Never change a published slug: it breaks links, localized images, and any Bloom that links to it. |
| `Status` | Future, In progress, Has Comments, Ready For Review, **Publish**, test, Retired. Only `Publish` is pulled. An agent's finished draft is `Ready For Review`. |
| `L1 Category` / `L2 Category` | The site section, e.g. `1. Bloom Editor` / `Images in Bloom`. They help people find pages in Notion; the sidebar comes from the Outline. |
| `Diátaxis Category` | Tutorial, How-To Guide, Explanation, Reference. |
| `Bloom Version` | The version the page describes, e.g. `6.5`. |
| `AI Drafted` | Which model drafted the page, e.g. `Claude Opus 5.5`. A new value becomes a new option. |
| `Keywords` | Words a reader might search for that the page does not use. They go into the page's front matter. |

## The Outline

- **The Outline decides the sidebar.** A Database page that no Outline page links to is not
  published. Order on an Outline page is order in the sidebar.
- An Outline page holds sub-pages (they become folders) and **link to page** blocks (they
  become pages). Link with the `link` command, which makes a link-to-page block.
- **Never put an @mention or any text on an Outline page.** docu-notion then treats the Outline
  page as a content page, and the pull fails because it has no slug.
- An **index page** (what a reader sees on clicking a folder) is a Database page linked from
  that folder, whose slug is the folder's title, hyphenated.

## Writing a content page

Style, from the Style Guide and the AI Reviewer Instructions:

- Plain English for readers whose first language is not English: short sentences, common words,
  active voice. Say "picture" where a Bloom user would.
- Title Case for the page title and every heading. Start the body at `##`; the title is the
  only H1.
- **Text that comes from Bloom's UI goes in `code`**: window names, buttons, menu items,
  labels, messages. Take the exact words from `DistFiles/localization/en/*.xlf` in
  BloomDesktop, then check them against the UI.
- Bold only for essential information. No italics, no colored text, no dividers, no tables
  used as lists.
- Steps are a numbered list, never a paragraph. A single instruction can be a bullet.
- Anything between two steps (a picture, a note) is a **child** of the step above it;
  otherwise the numbering restarts on the site.
- **Link to another Database page with an @mention** of it (`[text](notion:<id>)` in
  `notion_docs.py`); docu-notion makes it a slug link. Mention only Database pages, never
  Outline pages, and never a page that is not published: the site build fails on a broken link
  (`onBrokenLinks: "throw"`). When the target is waiting for review, add the link when it
  publishes.
- Callouts use only these emoji, which docu-notion maps to Docusaurus admonitions: ℹ️ or 📝 →
  note, 💡 → tip, ❗ → info, ⚠️ → caution, 🔥 → danger. The team uses 🚧 for a to-do; it shows
  as a note.

Read an existing page in the same section first (`py notion_docs.py dump <page>`) and match it.

## Screenshots

From "Making good screenshots":

- Take them from the real UI, never mock them up.
- Crop to the smallest area that still gives context. Crop out title bars and anything that
  shows a version number, which dates the picture.
- No frame or dark border: the site adds a shadow.
- A picture that explains several parts of the UI: a sentence introducing it, the picture with
  numbered circles on it, then a numbered list explaining each number. Circles are orange
  `#FF7F00` with white numerals, 40 px across, with a shadow (down 4 px, 50% opacity, blur 2).
  For a single thing to click, use one arrow instead.
- A picture that is too narrow to fill the page goes to the right of the steps; a full-width
  one goes under the step it belongs to.
- The team archives screenshots in Google Drive under Shared drives/Bloom Team/
  docs.bloomlibrary.org/Screenshots, named `page-slug - description.png`.

The team's general screenshot guidance (sizing so the text matches the text around it, captions as
text) is in `screenshots.md` at the root of the bloom-team-skills clone; the rules above are the
docs site's own.

Where to get them:

- **The AI Image Editor:** `pnpm screenshots:capture` in bloom-ai-image-tools drives a fake
  Bloom through set scenes and writes PNGs to `screenshots-out/` (git ignores it). It needs to
  listen on a socket, so run it outside the Bash sandbox. Its results come from the free "Local
  Dummy (No AI)" model and show "DUMMY EDIT" on the picture, and its model menu lists that
  model; crop both out.
- **The rest of Bloom:** the `run-bloom` skill.

Where a screenshot is needed but could not be taken, put a 🚧 callout "Screenshot needed: …"
so a human can find it.

## Writing pages with `notion_docs.py`

`notion_docs.py`, beside this file, is a small CLI and library over the Notion REST API:

```
py notion_docs.py search <text>                 find a page by title
py notion_docs.py dump <page>                   the page's blocks, one per line, with ids
py notion_docs.py props <page>                  its properties
py notion_docs.py create <title>                a new Database page; prints its id
py notion_docs.py set <page> Slug=my-page Status="Ready For Review" "L1 Category=1. Bloom Editor"
py notion_docs.py write <page> draft.md         replace the page's body with a markdown file
py notion_docs.py link <outline-page> <page> [<after-block>]
                                                add a link to <page> on an Outline page, at the end
                                                or just after the block <after-block> (an id from dump)
```

`write` takes a strict markdown subset and stops on anything it does not know:
`##`/`###` headings, paragraphs, `- ` bullets, `1. ` steps, `> 💡 text` callouts,
`![](shots/x.png)` images (relative to the markdown file; uploaded to Notion), and inline
`**bold**`, `*italic*`, `` `code` `` and `[text](url)`. Indent a bullet, image or callout under a
step to nest it. `[text](notion:<page id>)` becomes an @mention, which shows the page's own
title, not `text`.

**Use `write` only on a page that has never been published.** It deletes every block and makes
new ones. The site names each image after its Notion block id, and heading anchors carry block
ids too, so new ids break localized screenshots in Crowdin and links to `#anchors`. To change a
published page, edit its blocks in place (`api("PATCH", "blocks/<id>", …)`, or append after a
block), and replace an image through Notion's own **Replace** so it keeps its id.

## Check a draft before handing it over

1. Set the page's Status to `test`.
2. Clone bloom-docs into a scratch folder with `git -c core.longpaths=true clone --depth 1`
   (some of its paths are too long for Windows otherwise), and run `pnpm install` there.
3. Run `pnpm exec docu-notion -n <token> -r 043c6aa5842946bdbea3a4f37c97a0e7 --status-tag test`.
   Do not add `--require-slugs`: several unpublished pages under the root have no slug, and the
   run then exits with an error after writing everything. (`pnpm pull-test-only` does the same
   but first runs `pnpm clear`.)
4. Read the generated `.md` under `docs/`: front matter `title`/`slug`/`keywords`,
   `sidebar_position`, one H1, admonitions, downloaded images, links turned into slugs.
5. Set Status back to `Ready For Review` and delete the clone.

## Link Bloom's UI to a page

Bloom links straight to a slug, e.g. `https://docs.bloomlibrary.org/image-license-problem`
(see `ImageUpdater.cs`, `ThemeChooser.tsx`, `BookSettingsConfigrPages.tsx`). Pick the slug
before the code ships, because changing it later breaks the link in every installed Bloom.
