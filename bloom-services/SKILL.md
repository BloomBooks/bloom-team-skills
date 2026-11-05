---
name: bloom-services
description: Reach the Bloom team's services with no token of your own, through the team's tool server, signed in by your GitHub login. Use to read YouTrack cards (and comment or change them as the Bot), Sentry issues, Slack channel history, Notion (the roadmap, the docs site's pages, the manual test cases in Test Case Runs), Cloudflare, Mixpanel, the community forum, TeamCity builds or a Bloom Library book; and before changing Azure, Supabase or Sentry settings with your own account.
---

# The team's services

Run the commands in `tools.mjs` beside this file:

```
node <this skill's folder>/tools.mjs <command> [arguments] [@<body file>]
```

The commands, their arguments and what they print are listed at the top of `sources.mjs`, beside
this file. Some that come up often:

- `youtrack "/issues/BL-17064?fields=idReadable,summary,description"` reads a card (YouTrack's REST
  API; the `youtrack-api` skill covers its fields and queries).
- `sentry "/organizations/bloom-app/issues/?query=is:unresolved&limit=10"` lists Sentry issues,
  one line each.
- `slack-history C0CE75BEJTU 7 crash` lists the last 7 days of #bloom-team-developers that mention
  "crash" (the bot reads only channels it has been added to).
- `notion /databases/<id>/query @query.json` queries a Notion database; the body file makes it a
  POST, so the command takes no method. `notion-text <page id>` prints a page. Where the roadmap,
  the docs and the test cases are: [notion.md](notion.md).
- `book <Bloom Library link>` saves a public book's files under `./.book/`.

A request body goes in a file under the working directory, passed as `@<file>`.

For the big picture (Bloom's parts, how books move between them, and which outside services the
team uses and pays for), read `ARCHITECTURE.md` in the private bloom-bot repo, which the Bloom bot
keeps up to date:

```
gh api repos/BloomBooks/bloom-bot/contents/ARCHITECTURE.md -H "Accept: application/vnd.github.raw"
```

## What goes through here, and what doesn't

The tool server holds each service's token and adds it. It lets in any member of the BloomBooks
GitHub organization, signed in with `gh auth token`, so `gh auth login` is the only setup. It
records each call with your GitHub login.

- **Reads** go through here, except Sentry events and other Sentry data about users (their email
  and IP addresses, feedback, replays, attachments). For those, use your own Sentry login.
- **YouTrack writes** go through here, as the shared Bot account: `youtrack POST <api path>
  @<file>`. Start every comment and card description with the attribution line (TEAM-AGENTS.md);
  the tool server refuses a comment or card without one.
- **Notion writes** are made as yourself, through Notion's own MCP server: [notion.md](notion.md).
- **Changing Azure, Supabase or Sentry** (settings, functions, resources, resolving Sentry issues)
  is done with your own account in that service: [own-logins.md](own-logins.md).
- **Slack posts** are made only by the bot.

When the tool server refuses a call, its message says which of these applies.

## When a command fails

- "isn't on Cloudflare yet": the tool server has no public address. Until it has one, set
  `BLOOM_BOT_WORKER_URL` to the address of one that is running, or wait; there is no token to
  fall back on.
- "GitHub doesn't accept that token" or "not a member of BloomBooks": run `gh auth login`, or ask
  to be added to the BloomBooks organization.
- "<NAME> is not among the bot's service tokens yet": the tool server doesn't hold that service's
  token. Say so; the bot's maintainer adds it.
