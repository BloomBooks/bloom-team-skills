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

const recordScript = fileURLToPath(new URL("../walkaround/record.mjs", import.meta.url));
const walkaroundRecord = home => {
  const dir = path.join(home, ".claude", "walkaround");
  return path.join(dir, fs.readdirSync(dir)[0]);
};
/** Runs a script on the repo's checkout with the test's home; returns its exit status. */
const exitStatus = (scriptPath, home, args) => {
  try {
    execFileSync(process.execPath, [scriptPath, "--worktree", worktree, ...args],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", stdio: "pipe" });
    return 0;
  } catch (e) { return e.status; }
};
const record = (home, ...args) => exitStatus(recordScript, home, args);
const progress = (home, ...args) => exitStatus(script, home, args);

test("record.mjs refuses a walkaround that does not say whether /simplify ran", () => withHome((run, read, home) => {
  assert.equal(record(home, "nothing to change"), 1);
  assert.equal(record(home, "--simplify", "skipped", "nothing to change"), 1);
  assert.equal(record(home, "--simplify", "not-needed"), 1);
  assert.equal(fs.existsSync(path.join(home, ".claude", "walkaround")), false);
}));

test("record.mjs stores the /simplify status and the reason it was not needed", () => withHome((run, read, home) => {
  assert.equal(record(home, "--simplify", "not-needed", "two small edits since the last pass", "1 change"), 0);
  const saved = JSON.parse(fs.readFileSync(walkaroundRecord(home), "utf8"));
  assert.deepEqual(saved.simplify, { status: "not-needed", reason: "two small edits since the last pass" });
  assert.equal(saved.summary, "1 change");
}));

test("walkaround done takes the record's summary and shows that /simplify ran", () => withHome((run, read, home) => {
  run("start");
  assert.equal(record(home, "--simplify", "ran", "2 changes, 1 proposal"), 0);
  assert.equal(progress(home, "walkaround", "done"), 0);
  assert.equal(read().steps.walkaround.state, "done");
  assert.equal(read().steps.walkaround.note, "2 changes, 1 proposal (/simplify ran)");
}));

test("walkaround done refuses with no walkaround record", () => withHome((run, read, home) => {
  run("start");
  assert.equal(progress(home, "walkaround", "done"), 1);
  assert.equal(read().steps.walkaround, undefined);
}));

test("walkaround done refuses a record with no /simplify status", () => withHome((run, read, home) => {
  run("start");
  assert.equal(record(home, "--simplify", "ran", "nothing to change"), 0);
  const file = walkaroundRecord(home);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  delete saved.simplify;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(progress(home, "walkaround", "done"), 1);
  saved.simplify = { status: "could-not-run" };
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(progress(home, "walkaround", "done"), 1);
  assert.equal(read().steps.walkaround, undefined);
}));

test("record.mjs --check passes only a finished walkaround of the code as it stands", () => withHome((run, read, home) => {
  assert.equal(record(home, "--check"), 1);
  assert.equal(record(home, "--simplify", "ran", "nothing to change"), 0);
  assert.equal(record(home, "--check"), 0);
  const file = walkaroundRecord(home);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  delete saved.simplify;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(record(home, "--check"), 1);
}));

test("record.mjs --check passes after a merge that git made with no hand edits, and only then", () => withHome((run, read, home) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "walkaround-merge-test-"));
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a],
    { encoding: "utf8", stdio: "pipe" }).trim();
  const check = () => {
    try {
      execFileSync(process.execPath, [recordScript, "--worktree", repo, "--check"],
        { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" });
      return 0;
    } catch (e) { return e.status; }
  };
  try {
    git("init", "-q", "-b", "pr");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("branch", "base");
    fs.writeFileSync(path.join(repo, "b.txt"), "the PR's change\n");
    git("add", "-A");
    git("commit", "-q", "-m", "pr");
    execFileSync(process.execPath, [recordScript, "--worktree", repo, "--simplify", "ran", "nothing to change"],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" });
    git("checkout", "-q", "base");
    fs.writeFileSync(path.join(repo, "c.txt"), "the base moved on\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base moves");
    git("checkout", "-q", "pr");
    git("merge", "-q", "--no-edit", "base");
    assert.equal(check(), 0);
    fs.writeFileSync(path.join(repo, "b.txt"), "edited during the merge\n");
    git("add", "-A");
    git("commit", "-q", "--amend", "--no-edit");
    assert.equal(check(), 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));
