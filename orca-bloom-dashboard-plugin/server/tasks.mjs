// The developer's to-do items for the dashboard's History: tasks.json, [{ id, text, created,
// checked }], `checked` an ISO time or null. Only the dashboard server writes it, through
// changeTask. It is the one file the dashboard keeps that nothing can work out again from git,
// GitHub or the transcripts, so a change is written whole to a temporary file and renamed over it:
// a crash mid-write cannot leave half a list.
import crypto from "node:crypto";
import fs from "node:fs";
import { readJson } from "./row-facts.mjs";

export const TASK_ACTIONS = ["create", "check", "uncheck", "delete"];

export function readTasks(file) {
  try { const t = readJson(file); return Array.isArray(t) ? t : []; } catch { return []; }
}

// Applies one of TASK_ACTIONS, with `body` as the page posted it ({ text } to create, { id }
// otherwise), and returns the new list. Throws on a request that changes nothing.
export function changeTask(file, action, body, now = new Date()) {
  const tasks = readTasks(file);
  const index = () => {
    const i = tasks.findIndex(x => x.id === String(body?.id || ""));
    if (i < 0) throw new Error("no such task");
    return i;
  };
  if (action === "create") {
    const text = String(body?.text || "").trim();
    if (!text) throw new Error("a task needs some text");
    tasks.push({ id: crypto.randomUUID(), text, created: now.toISOString(), checked: null });
  } else if (action === "check") tasks[index()].checked = now.toISOString();
  else if (action === "uncheck") tasks[index()].checked = null;
  else if (action === "delete") tasks.splice(index(), 1);
  else throw new Error("unknown task action");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, file);
  return tasks;
}
