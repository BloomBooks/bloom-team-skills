# Brief: analyze the <release> board's cards for the <release> / <next release> split

A model brief for the analysis agents. Replace each <angle-bracketed> part with this board's
facts and the developer's own rules, and keep the Output section as it is: the app reads those
fields.

## Background

<Why the board is being sorted, the dates (code freeze, test plan, beta), how many cards are in
which states, and who decides. Each card must either stay in <release> or go somewhere else; the
developer makes the decisions in a local app, and your job is the analysis the app shows for each
card.>

## Inputs (read-only; never query YouTrack or change any card)

- `<dataDir>awyoutrack.json`: `cards[]`, each with description, custom fields (State, Type,
  Assignee, ...), tags, links to other cards, attachments, and comments.
- `<dataDir>awprs-<repo>.json`: recent PRs of each repo (title, headRefName, state, url). A PR
  or branch belongs to a card when its title or branch name contains the card id.
- `<dataDir>awranches-<repo>.txt`: remote branch names.
- <The roadmap rows for <release> and <next release>, if saved to a file.>
- The code: `<worktree>` is BloomDesktop on the branch where <release> is built. Read it to
  judge size, risk, and whether a bug is already fixed (`git -C <worktree> log --oneline
  --grep=<id>` finds commits naming the card). Never edit, build, or run anything in that repo,
  and never `cd`; use absolute paths and `git -C`.

## How the developer wants cards judged

<The developer's rules. These were the rules for the 6.6 split; keep, change or drop each.>

- **Bugs:** what matters is how many people hit it in ordinary work in their own setup, and how
  bad it is when they do. Whether the bug is new in <release> does not matter; a bug that is also in
  the release before it is at least as important. A user working in their own UI language (French, say) or their own
  kind of collection (sign language, say) is doing ordinary work, so a visible problem there is
  significant even though most users are not French. Losing the user's work (text, recordings,
  metadata) or a crash in a normal workflow is always high. Cards are easy to add for super corner
  cases a tester found by a contrived path; those rank low.
- **Roadmap:** the roadmap lists only the biggest features. <The features planned for <release>,
  with their cards.> A card that finishes or fixes one of these gets a boost.
- Bug fixes, technical debt, and small improvements are mostly not on the roadmap; judge them on
  their merits, not by their absence from it.
- **Cards that do not ship in the desktop installer** (Bloom Library website, servers, harvester,
  developer tooling) are scored the same way as everything else. For tooling, the users are the
  developers and agents; tooling that speeds up finishing and testing <release> has real benefit.
- **Who asked:** a request from a funder, an Enterprise subscriber, or a partner organization adds a little to
  benefit. A find only an internal tester could hit adds nothing.
- **Risk to the beta:** a change that touches widely shared code, or could break things the test
  plan has already passed, is risky late in the cycle (e.g. a TypeScript upgrade, retiring
  CKEditor, modernizing bloom-player-core).

## Output

Write a JSON array, one object per card in your batch, to the file named in your prompt. Read or
Glob before writing; the file must not exist yet. Field by field:

```ts
type CardAnalysis = {
  id: string;                 // "BL-16818"
  plain: string;              // one or two plain sentences: what goes wrong (or what is wanted) and for whom. No jargon a product person wouldn't know.
  area: Area;                 // pick the closest one
  kind: "bug" | "feature" | "improvement" | "tech-debt" | "tooling" | "docs" | "support" | "investigation";
  reportedBy: "user" | "forum" | "sentry" | "partner" | "tester" | "developer" | "agent";
  evidence: string;           // who reported it and what backs it: "Error report from a Togo user", "Sentry: 412 events, 37 users", "tester's test plan", "found by an agent reviewing code"
  partner: string | null;     // "Enterprise: <name>", a funder's or partner's name; null if none
  roadmap: string | null;     // the 6.6 roadmap feature it belongs to, exactly as named above; null if none
  reach: 1 | 2 | 3 | 4 | 5;   // 5 = nearly everyone doing ordinary work hits it; 1 = a contrived path only
  severity: 1 | 2 | 3 | 4 | 5;// 5 = loses work or crashes; 3 = blocks or misleads; 1 = cosmetic and easily ignored
  benefitWhy: string;         // one sentence that justifies reach and severity
  risk: 1 | 2 | 3 | 4 | 5;    // risk to the beta of doing it now; 1 = isolated, 5 = touches shared code widely
  riskWhy: string;            // one sentence, naming the code it touches
  sizeLines: number;          // your estimate of lines changed, from the code you looked at
  sizeFiles: number;          // files changed
  sizeWhy: string;            // one sentence: what has to change, naming files or functions
  status: string | null;      // anything that changes the picture: "already fixed by 1a2b3c on master", "PR #8412 open (draft)", "branch BL-16818-tables exists", "needs design first", "duplicate of BL-xxxx"; null if nothing
  proposal: "6.6" | "6.7" | "live-with" | "future";  // "live-with" = the board's "Issues We'll Live With for now"
  proposalWhy: string;        // one sentence a busy lead can accept or reject at a glance
};
type Area = "Canvas & covers" | "Games" | "Bloom Apps" | "Spreadsheet" | "Publish" | "Editing & text"
  | "Images" | "Talking Book & audio" | "Sign Language & video" | "Collection & settings"
  | "Team Collection" | "Localization" | "Language Chooser" | "Bloom Player & Reader"
  | "Bloom Library website" | "Servers & infrastructure" | "Developer tooling" | "Other";
```

Writing rules for the text fields: plain words, no invented names for things (use the names in
the code or the card), no hedging, no em dashes. Keep each `...Why` to one sentence.

Look at the code for every card where size, risk, or "already fixed" depends on it; a guess from
the title is not enough for size. Don't spend long on cards for repos that aren't in `<worktree>`
(Bloom Library, bloom-player, harvester): estimate from the card and say so in `sizeWhy`.

When done, reply with one line per card: id, proposal, and anything surprising (already fixed, a
duplicate, a card that is wrongly on this board).
