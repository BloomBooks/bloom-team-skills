# Screenshots in PRs, cards and test notes

Whenever a change involves UI, show it: put screenshots of the UI in the **PR description** and
in the **testing notes** on the card. A reviewer or a tester who sees the thing understands the
words around it much faster. This page says how to make those screenshots useful. Skills that
take or embed screenshots point here; `write-manual-test` and `bloom-docs` add rules of their own
for Notion test cards and the docs site.

## Crop to the subject, plus the context it needs

Show the thing being discussed and enough around it to understand it, and no more. A dialog alone
is usually enough; keep part of the screen behind it when it matters where the dialog appears
(over which tool, next to which control). A full Bloom window reduced to a column width is
unreadable.

## Size it so its text matches the text around it

Give every screenshot a **fixed width in pixels**, never a percentage: a percentage scales with
the column, and card and PR columns are wide, so "75%" can still show text twice the size of the
surrounding text.

Pick the width so the screenshot's text comes out about the size of the text beside it:

```
display width = image width × surrounding text size ÷ (text size in the UI × capture scale)
```

Example: a dialog with 16px text, captured at scale 1.5 and 773px wide, shown beside 14px text:
773 × 14 ÷ (16 × 1.5) ≈ 450px.

How to set the width:

- **YouTrack:** `![what it shows](file.png){width=450px}`, where `file.png` is an attachment on
  the card (see `youtrack-api`, "Uploading an image or video is only half the job").
- **GitHub:** `<img width="450" alt="what it shows" src="...">`. Markdown image syntax has no
  width. `pr-attach` uploads the file and gives you the URL without committing it anywhere.

## Captions are text, not alt text

Neither YouTrack nor GitHub displays alt text; only screen readers use it. When a picture needs a
caption, write it as a line of text directly above or below the image. Still give the alt text a
short description of what the picture shows, for screen-reader users.

## Once each, where the words need it

Show each screenshot once, at the point where the text talks about it, rather than in a gallery at
the end. If the same picture would help in two places, put it in the one where the reader meets
the subject first and refer to it from the other.
