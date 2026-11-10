# Changing a service's settings with your own account

Configuring Azure, Supabase or Sentry (resources, Edge Functions, alert rules, project settings)
goes through that service's own command-line tool, signed in as the person at the keyboard. Each
service then records the change under their name, and its own roles decide what they may do. The
tool server does not take part.

Each tool signs in once per machine with a browser login. When a command fails because the tool
isn't signed in, run the login, which opens a browser for the person to confirm:

| Service | Tool | Sign in | Check who you are |
|---|---|---|---|
| Azure | `az` | `az login` | `az account show` |
| Supabase | `supabase` | `supabase login` | `supabase projects list` |
| Sentry | `sentry-cli` | `sentry-cli login` | `sentry-cli info` |

What each is for at Bloom (from bloom-bot's `ARCHITECTURE.md`):

- **Azure** hosts Parse Server (the book database's API, `server.bloomlibrary.org/parse`, and
  `dev-server` for development) and Analytics' PostgreSQL.
- **Supabase** runs the server-side Edge Functions: book upload, OPDS, social sharing, stats,
  subscriptions, Contentful-to-Crowdin and `fs`. Their code is in the bloom-core-supabase repo.
- **Sentry** is the organization `bloom-app`, with the projects `bloom-desktop` (the Editor, C# and
  JS) and `bloomlibrary` (Bloom Library, in all its environments).

Before changing anything, list what the login can see (`az account list`,
`supabase projects list`) and confirm with the person which subscription or project to change;
a production project and a development one can look alike.

A person without an account in that service, or without the role a change needs, asks John Hatton
for one; there is no shared login to fall back on.
