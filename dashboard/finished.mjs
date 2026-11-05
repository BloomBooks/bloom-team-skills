// The developer's finished cards, for the dashboard's "Finished" list: cards whose work they handed
// on, so they can report them at the next standup and then clear them with the page's Done button.
//
// A card is finished when its State is one of FINISHED and the developer either is its Assignee
// or was removed as its Assignee in the last SCAN_DAYS days (cards often lose their assignee on
// the way to review or testing). Cards waiting for review stay listed however long the review
// takes; cards already in testing or closed drop off RECENT_DAYS after they were finished.
//
// finishedAt is when the card last went from In Progress or Has Comments to a FINISHED state, or
// the card's last update when its history has no such change.
//
// Run on its own to see the list: node finished.mjs

export const ACTIVE = ["In Progress", "Has Comments"];
export const FINISHED = ["Ready For UI Review", "Ready For Code Review", "Ready For Testing", "Closed"];
const IN_REVIEW = ["Ready For UI Review", "Ready For Code Review"];
const SCAN_DAYS = 30;
const RECENT_DAYS = 7;
const DAY = 864e5;

/**
 * yt(path, params) calls the YouTrack REST API and returns the parsed JSON; login is the
 * developer's YouTrack login. Returns [{ id, url, summary, state, finishedAt }], newest first.
 */
export async function finishedCards(yt, login) {
  const states = list => list.map(s => `{${s}}`).join(", ");
  const ids = new Set();
  // Assigned to the developer now: in review at any age, past review only when recently updated.
  const assigned = [
    `project: BL Assignee: {${login}} State: ${states(IN_REVIEW)}`,
    `project: BL Assignee: {${login}} State: ${states(FINISHED.filter(s => !IN_REVIEW.includes(s)))} updated: {minus ${SCAN_DAYS}d} .. Today`,
  ];
  for (const query of assigned) for (const i of await yt("/issues", { query, fields: "idReadable", $top: "500" })) ids.add(i.idReadable);
  // Removed as Assignee lately.
  const since = String(Date.now() - SCAN_DAYS * DAY);
  for (let skip = 0; ; skip += 500) {
    const page = await yt("/activities", {
      categories: "CustomFieldCategory", start: since, $top: "500", $skip: String(skip),
      issueQuery: `project: BL State: ${states(FINISHED)} updated: {minus ${SCAN_DAYS}d} .. Today`,
      fields: "target(idReadable),field(name),removed(login)",
    });
    for (const a of page) if (a.field?.name === "Assignee" && a.removed?.some(u => u.login === login)) ids.add(a.target.idReadable);
    if (page.length < 500) break;
  }

  const cards = await Promise.all([...ids].map(async id => {
    const i = await yt("/issues/" + id, { fields: "summary,updated,customFields(name,value(name))" });
    const state = i.customFields?.find(c => c.name === "State")?.value?.name;
    if (!FINISHED.includes(state)) return null;
    const history = await yt(`/issues/${id}/activities`, { categories: "CustomFieldCategory", fields: "timestamp,field(name),added(name),removed(name)", $top: "2000" });
    const handedOn = history
      .filter(a => a.field?.name === "State" && a.removed?.some(v => ACTIVE.includes(v.name)) && a.added?.some(v => FINISHED.includes(v.name)))
      .map(a => a.timestamp);
    const at = handedOn.length ? Math.max(...handedOn) : i.updated;
    if (!IN_REVIEW.includes(state) && Date.now() - at > RECENT_DAYS * DAY) return null;
    return { id, url: "https://issues.bloomlibrary.org/youtrack/issue/" + id, summary: i.summary, state, finishedAt: new Date(at).toISOString() };
  }));
  return cards.filter(Boolean).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

// node finished.mjs: print the developer's list.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const { execFileSync } = await import("node:child_process");
  const { developer } = await import("../developer.mjs");
  const token = process.env.YOUTRACK_BOT || execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('YOUTRACK_BOT','User')"], { encoding: "utf8" }).trim();
  const yt = async (p, params) => {
    const url = new URL("https://issues.bloomlibrary.org/youtrack/api" + p);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    if (!r.ok) throw new Error(`YouTrack ${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  for (const c of await finishedCards(yt, (await developer()).youtrack.login)) console.log(`${c.finishedAt}  ${c.id}  ${c.state.padEnd(21)} ${c.summary}`);
}
