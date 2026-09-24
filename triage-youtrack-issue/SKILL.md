---
name: triage-youtrack-issue
description: Triage one user bug report on the Bloom YouTrack tracker against the BloomDesktop source and post a single outline-style triage comment on it. Use when given a card id (BL-xxxxx) to triage, or when the scheduled bloom-bug-triage routine hands over an issue. Comments only; never changes fields, code, or branches.
argument-hint: "the card id (BL-xxxxx); optionally a label for the caller, e.g. \"Hatton's scheduled task\""
---

# Triage a YouTrack bug report

Input: one card id like `BL-16915`. Output: one comment on that card, and a one-line result for
the caller (commented / skipped and why / error).

Every tracker call goes through the `youtrack-api` skill, with `$YOUTRACK_BOT` and no other
token. Never print the token.

## 1. Check it still needs triage

List the card's comments (`youtrack-api`, "List an issue's comments"). If any comment text contains
`during triage-youtrack-issue` or `during bloom-bug-triage`, stop and report "already triaged".
A scheduled run and a person can reach the same card, so check again here even if the caller
already did.

## 2. Read the report

Fetch `idReadable,summary,description,reporter(login,name),customFields(name,value(name))` and
the attachment list (`youtrack-api`, "List an issue's attachments"). Attachment `url` values are relative:
prefix them with `https://issues.bloomlibrary.org/youtrack` and send the same Authorization
header. Download log and text attachments and read them. Look at screenshots if you can.

If the card is not a bug report (a feature request, an internal task, a question), stop without
commenting and report "skipped: not a bug report (<what it is>)".

## 3. Find the code

Work in a BloomDesktop checkout. If none is present, `git clone --depth 1
https://github.com/BloomBooks/BloomDesktop.git`. Read its `AGENTS.md`.

Search with `rg` for what the report contains: error messages, exception types, stack-frame
method names, UI strings, and localization ids (English strings live in
`DistFiles/localization/en/*.xlf`; the `id` of a matching `trans-unit` usually appears in the
code that shows the string). Read the code you find. Base each hypothesis on code you read;
do not name a file path or describe behavior you did not see.

Do not modify code, create branches, or open PRs.

## 4. Post the comment

Build the body `{"text": "<markdown>"}` with a JSON-aware tool (`jq -n --arg t "$text"
'{text:$t}'` or Python `json.dumps`) and write it to a file, then post it with `curl -d @file`
(`youtrack-api`, "Post a comment"). Markdown with quotes breaks an inline `-d '…'`.

The text:

```
[<model name> from <caller label> during triage-youtrack-issue]

**Triage outline (automated, unverified)**
- **Summary:** one or two sentences restating the problem.
- **Likely area:** components/files involved, as repo-relative paths (e.g. src/BloomExe/...), with a one-line reason each.
- **Hypotheses:** 1–3 likely causes, most likely first, each with the code evidence.
- **Missing info:** what we would need from the reporter (Bloom version, OS, steps, book file, logs), only if actually missing.
- **Suggested next steps:** concrete steps for a developer to confirm or fix.
- **Confidence:** low / medium / high, with a short reason.
```

`<caller label>` is what the caller passed (e.g. `Hatton's scheduled task`); with none, use
`<git config user.name>'s machine`.

Only add this comment. Never change State, Assignee, Type, tags, or any other field, and never
edit or delete existing comments.

## 5. Report

Return one line: `<id>: commented — <one-line gist>`, `<id>: skipped — <reason>`, or
`<id>: error — <what failed>`.
