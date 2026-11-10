// Tests for progress.mjs. Run: node --test "dashboard/*.test.mjs"
// Each test points the home folder at a temporary one, so the real dashboard's files are untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./progress.mjs", import.meta.url));
const worktree = fileURLToPath(new URL("..", import.meta.url));

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "progress-test-"));
  const run = (...args) => execFileSync(process.execPath, [script, "--worktree", worktree, ...args],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
  const read = () => {
    const dir = path.join(home, ".claude", "bloom-dashboard", "progress");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return files.length ? JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")) : null;
  };
  try { fn(run, read, home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test("end closes a run that has no end", () => withHome((run, read) => {
  run("start");
  run("discover", "running");
  run("end");
  assert.ok(read().endedAt);
}));

test("a second end leaves the first end's time alone", () => withHome((run, read) => {
  run("start");
  run("end");
  const first = read().endedAt;
  run("end");
  assert.equal(read().endedAt, first);
}));

test("end with no run recorded writes nothing", () => withHome((run, read) => {
  run("end");
  assert.equal(read(), null);
}));

test("end records the commit and the tree the run ended on", () => withHome((run, read) => {
  run("start");
  run("end");
  const git = (...a) => execFileSync("git", ["-C", worktree, ...a], { encoding: "utf8" }).trim();
  assert.equal(read().head, git("rev-parse", "HEAD"));
  assert.equal(read().tree, git("rev-parse", "HEAD^{tree}"));
}));

test("a step records its state and note; start forgets the last run's steps", () => withHome((run, read) => {
  run("start");
  run("bots", "running", "round", "2", "of", "4");
  assert.deepEqual({ state: read().steps.bots.state, note: read().steps.bots.note }, { state: "running", note: "round 2 of 4" });
  run("start");
  assert.deepEqual(read().steps, {});
}));

test("an unknown step or state warns, changes nothing and still exits 0", () => withHome((run, read) => {
  run("start");
  const before = read();
  run("lint", "running");
  run("discover", "finished");
  assert.deepEqual(read(), before);
}));

test("the worktree's path is one key however it is spelled", () => withHome((run, read, home) => {
  run("start");
  execFileSync(process.execPath, [script, "--worktree", worktree.replace(/[\\/]$/, "").toUpperCase() + "\\", "discover", "done"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
  assert.equal(read().steps.discover.state, "done");
  assert.equal(fs.readdirSync(path.join(home, ".claude", "bloom-dashboard", "progress")).length, 1);
}));
