// Compares two outputs of gather.mjs and describes what changed, one line per change, in the form
// that server.mjs appends to events.log, e.g.
//   BL-16812 card: State In Progress -> Ready For Code Review
//   BL-16988 PR https://github.com/BloomBooks/BloomDesktop/pull/8367: reviewDecision "" -> "APPROVED"
//   BL-16777 D:/grid-calendar: pushed
// Changes that happen all the time without meaning anything for a row (master moving on, files
// being edited, PR line counts) are left out.

const ACTIVE = ["In Progress", "Has Comments"];
const PR_FIELDS = ["isDraft", "mergeable", "reviewDecision", "checks", "baseRefName", "report", "reportDecisions"];

/** Returns the lines describing how `next` differs from `prev`; [] when `prev` is missing. */
export function diffFacts(prev, next) {
  if (!prev) return [];
  const lines = [];

  const prevCards = new Map(prev.cards.map(c => [c.id, c]));
  const nextCards = new Map(next.cards.map(c => [c.id, c]));
  for (const [id, c] of nextCards) {
    const p = prevCards.get(id);
    if (!p) { if (ACTIVE.includes(c.state)) lines.push(`${id} card: new, State ${c.state}`); }
    else if (p.state !== c.state) lines.push(`${id} card: State ${p.state} -> ${c.state}`);
  }
  for (const [id, p] of prevCards) {
    if (!nextCards.has(id) && ACTIVE.includes(p.state)) lines.push(`${id} card: no longer listed (resolved, reassigned or moved to another board)`);
  }

  const prevPrs = new Map(prev.prs.map(p => [p.url, p]));
  const nextPrs = new Map(next.prs.map(p => [p.url, p]));
  for (const [url, pr] of nextPrs) {
    const p = prevPrs.get(url);
    if (!p) { lines.push(`${pr.card ?? "-"} PR ${url}: opened`); continue; }
    for (const f of PR_FIELDS) {
      if (JSON.stringify(p[f]) !== JSON.stringify(pr[f])) lines.push(`${pr.card ?? "-"} PR ${url}: ${f} ${JSON.stringify(p[f])} -> ${JSON.stringify(pr[f])}`);
    }
    const asked = (pr.reviewRequests || []).filter(r => !(p.reviewRequests || []).includes(r));
    if (asked.length) lines.push(`${pr.card ?? "-"} PR ${url}: review requested from ${asked.join(", ")}`);
  }
  for (const [url, p] of prevPrs) if (!nextPrs.has(url)) lines.push(`${p.card ?? "-"} PR ${url}: merged or closed`);

  const prevWts = new Map(prev.worktrees.map(w => [w.path, w]));
  const nextWts = new Map(next.worktrees.map(w => [w.path, w]));
  for (const [path, w] of nextWts) {
    const p = prevWts.get(path);
    if (!p) { lines.push(`${w.card} ${path}: worktree added on ${w.branch}`); continue; }
    if (p.branch !== w.branch) lines.push(`${w.card} ${path}: branch ${p.branch} -> ${w.branch}`);
    const added = w.ownCommits.filter(c => !p.ownCommits.includes(c)).length;
    if (added) lines.push(`${w.card} ${path}: ${added} new commit${added > 1 ? "s" : ""}`);
    if (p.unpushed > 0 && w.unpushed === 0) lines.push(`${w.card} ${path}: pushed`);
  }
  for (const [path, p] of prevWts) if (!nextWts.has(path)) lines.push(`${p.card} ${path}: worktree removed`);

  return lines;
}
