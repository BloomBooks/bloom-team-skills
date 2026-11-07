// Sets the PR-state chip of a published preflight report to "ready" or "merged".
// Usage: node patch-report-chip.mjs <report.html> <ready|merged>
// Rewrites only what sits between the <!-- pr-state:begin --> and <!-- pr-state:end --> markers
// (preflight/references/report-artifact.md), so the report's own class names and styling stay.
// Prints "patched", "NO CHANGE" (already in that state), or "NO MARKERS" (exit code 2).
import fs from "node:fs";

const LABELS = { draft: "Draft PR", ready: "Ready for review", merged: "Merged" };
const [file, state] = process.argv.slice(2);
if (!file || !(state in LABELS) || state === "draft") {
  console.error("usage: node patch-report-chip.mjs <report.html> <ready|merged>");
  process.exit(1);
}
const s = fs.readFileSync(file, "utf8");
if (!/<!-- pr-state:begin -->[\s\S]*?<!-- pr-state:end -->/.test(s)) {
  console.log("NO MARKERS");
  process.exit(2);
}
const label = new RegExp(">(" + Object.values(LABELS).join("|") + ")<", "g");
const out = s.replace(/<!-- pr-state:begin -->[\s\S]*?<!-- pr-state:end -->/g, m =>
  m.replace(/data-pr-state="[a-z]+"/g, `data-pr-state="${state}"`).replace(label, `>${LABELS[state]}<`));
fs.writeFileSync(file, out);
console.log(out === s ? "NO CHANGE" : "patched");
