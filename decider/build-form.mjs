// Builds a decider page from the form's JSON (see SKILL.md, "The form's JSON") and form.html.
//
//   node build-form.mjs <form.json> <page.html>
//
// claude-decider.mjs does this itself when it is given a .json file; use this script for a page
// that is published instead of served (an Artifact, or dev-process-artifacts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "form.html");

/** Checks the form's JSON and throws on the first thing a page could not show or serialize. */
function check(form) {
  const fail = (what) => { throw new Error(`form JSON: ${what}`); };
  if (!form.about) fail('"about" is missing: one line naming the project, repos and branches');
  if (!Array.isArray(form.questions) || form.questions.length === 0) fail('"questions" must be a non-empty array');
  form.questions.forEach((q, i) => {
    const where = `question ${i + 1} (${q.title ?? "no title"})`;
    if (!q.title) fail(`${where} has no "title"`);
    if (!q.leaveAsIs) fail(`${where} has no "leaveAsIs": a one-line restatement of what stays as it is`);
    for (const o of q.options ?? []) {
      if (!o.label || !o.instruction) fail(`${where} has an option without "label" or "instruction"`);
    }
    if (!(q.options ?? []).length && !q.leaveAsIsRecommended) fail(`${where} has no options`);
  });
}

/** Returns the page's HTML for a form object. */
export function buildForm(form) {
  check(form);
  const data = { date: new Date().toISOString().slice(0, 10), ...form };
  // "</" inside the JSON would end the script element early.
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return fs.readFileSync(TEMPLATE, "utf8").replace("/*FORM*/", () => json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node build-form.mjs <form.json> <page.html>");
    process.exit(2);
  }
  fs.writeFileSync(output, buildForm(JSON.parse(fs.readFileSync(input, "utf8"))));
  console.log(`wrote ${output}`);
}
