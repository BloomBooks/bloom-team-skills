// The decider forms that wait for the developer's answers. A session that needs decisions hands
// its form to the service (decider/claude-decider.mjs) and waits; the service serves the form at
// a URL of its own, lists it on the dashboard beside the card it belongs to, and hands the answers
// to the waiting session when the developer presses Send to Claude. Any number of sessions can
// have forms waiting at once, and no session runs a web server for its form.
//
// Each form is a file in dataDir()/deciders/, so one that was waiting when the service restarted
// is still there afterwards.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir, readJsonFile, writeJsonFile } from "./env.mjs";

const dir = () => path.join(dataDir(), "deciders");
const fileOf = id => path.join(dir(), id + ".json");
const validId = id => /^[a-f0-9]{24}$/.test(id);
// An answered form is kept this long, for a session that asks a moment later.
const KEEP_ANSWERED_MS = 60 * 60_000;
// A form that nobody answers is dropped after this long.
const KEEP_WAITING_MS = 3 * 24 * 3600e3;

const waiters = new Map();   // id -> Set of functions to call with the answers

function all() {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return []; }
  return names.filter(n => n.endsWith(".json")).map(n => readJsonFile(path.join(dir(), n))).filter(Boolean);
}

/** Registers a form: { name, topic, html, session, worktree }. Returns its record without the html. */
export function addDecider({ name, topic, html, session = null, worktree = null }, now = Date.now()) {
  if (typeof html !== "string" || !html) throw new Error("a decider needs its page");
  fs.mkdirSync(dir(), { recursive: true });
  const id = crypto.randomBytes(12).toString("hex");
  writeJsonFile(fileOf(id), { id, name: String(name || "form").slice(0, 60), topic: String(topic || "").slice(0, 80), html, session, worktree, createdAt: now, answeredAt: null, answers: null });
  return { id, path: "/decide/" + id };
}

export function getDecider(id) {
  return validId(id) ? readJsonFile(fileOf(id)) : null;
}

/** The form's page, with the address its Send to Claude button posts to. */
export function deciderPage(id) {
  const d = getDecider(id);
  if (!d) return null;
  return d.html.replace(/window\.DECIDER_ENDPOINT\s*=\s*"[^"]*"/, `window.DECIDER_ENDPOINT=${JSON.stringify(`/decide/${id}/answers`)}`);
}

/** Records the answers and hands them to every session waiting on the form. */
export function answerDecider(id, answers, now = Date.now()) {
  const d = getDecider(id);
  if (!d) return false;
  d.answeredAt = now;
  d.answers = String(answers);
  writeJsonFile(fileOf(id), d);
  for (const give of waiters.get(id) || []) give(d.answers);
  waiters.delete(id);
  return true;
}

/** Resolves with the form's answers, or with null after `ms` when it has none yet. */
export function waitForAnswers(id, ms) {
  const d = getDecider(id);
  if (!d) return Promise.reject(new Error("no such decider"));
  if (d.answeredAt) return Promise.resolve(d.answers);
  return new Promise(resolve => {
    const set = waiters.get(id) ?? waiters.set(id, new Set()).get(id);
    const give = answers => { clearTimeout(timer); set.delete(give); resolve(answers); };
    const timer = setTimeout(() => give(null), ms);
    set.add(give);
  });
}

/** The forms still waiting, oldest first, for the page: { id, name, topic, worktree, path, createdAt }. */
export function waitingDeciders(now = Date.now()) {
  const out = [];
  for (const d of all()) {
    const old = d.answeredAt ? now - d.answeredAt > KEEP_ANSWERED_MS : now - d.createdAt > KEEP_WAITING_MS;
    if (old) { try { fs.rmSync(fileOf(d.id)); } catch {} continue; }
    if (!d.answeredAt) out.push({ id: d.id, name: d.name, topic: d.topic, worktree: d.worktree, session: d.session, path: "/decide/" + d.id, createdAt: d.createdAt });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Drops a waiting form whose session has gone: nobody is left to receive its answers. */
export function dropDecider(id) {
  if (validId(id)) try { fs.rmSync(fileOf(id)); } catch {}
  waiters.delete(id);
}
