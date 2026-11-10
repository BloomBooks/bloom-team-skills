# Where things are in Notion

`notion <api path>` reads Notion; it may also POST to `/search` and `/databases/<id>/query`, with
a body file. Search and query results print one line per page with its fields; `notion-text <page
id>` prints a page's content as text, naming its child pages by id. Start from these ids rather
than searching, which is slow and matches titles loosely:

- **The roadmap:** the database "Bloom Roadmap", `8e833e5e-8244-4655-85e7-e4cdb77632ba`. One page
  per planned feature. `Version` is the release it is planned for (`6.6`, `6.7`, or `Anticipating`
  for no release yet); `Component`, `Source` (who asked), `Label`, `Size`, `Funded?` and
  `YouTrack` (the card) say more. Query it with a filter, e.g.
  `{"filter": {"property": "Version", "select": {"equals": "6.7"}}}`, or
  `{"filter": {"property": "Name", "title": {"contains": "font"}}}`.
- **The docs site** (https://docs.bloomlibrary.org): the outline page
  `4e0e73118b8d4f72846fdddca00e2da4` lists the site's sections as child pages, each a page you can
  read with `notion-text`; every content page is a row of the database
  `915e28ea-feab-4970-a6c5-180d34a772e2`, which you can query by title.
- **The test cases:** the database "Test Case Runs", `38c4bb19-df12-8123-8bc8-e65b962cb12f`. One
  row per manual test case per release test run: `Test Case ID` (a number) is the case, the same in
  every run; `Test Suite Run` is the release (`6.5`, `6.6`); `Status` says how that run went. A
  card's body holds its steps. Query by
  `{"filter": {"property": "Test Case ID", "number": {"equals": 69}}}`, or by title.

Changing Notion (a docs page, a roadmap row, a test run) is done as yourself, not through these
commands: John Hatton invites you as a guest on the pages you work on, and you connect Claude Code
to Notion's own MCP server once, with
`claude mcp add --transport http notion https://mcp.notion.com/mcp` and a browser login. Notion
then records each change under your name.
