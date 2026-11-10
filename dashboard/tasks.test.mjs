// Tests for tasks.mjs, the developer's to-do items in History. Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changeTask, readTasks } from "./tasks.mjs";

function withFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-test-"));
  try { fn(path.join(dir, "tasks.json")); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const T1 = new Date("2026-11-10T09:00:00Z"), T2 = new Date("2026-11-10T10:00:00Z");

test("a missing or unreadable file is an empty list", () => withFile(file => {
  assert.deepEqual(readTasks(file), []);
  fs.writeFileSync(file, "{ broken");
  assert.deepEqual(readTasks(file), []);
  fs.writeFileSync(file, "{}");
  assert.deepEqual(readTasks(file), []);
}));

test("create, check, uncheck and delete", () => withFile(file => {
  const [t] = changeTask(file, "create", { text: "  Write the test plan " }, T1);
  assert.deepEqual({ text: t.text, created: t.created, checked: t.checked }, { text: "Write the test plan", created: T1.toISOString(), checked: null });
  assert.equal(changeTask(file, "check", { id: t.id }, T2)[0].checked, T2.toISOString());
  assert.equal(changeTask(file, "uncheck", { id: t.id })[0].checked, null);
  assert.deepEqual(changeTask(file, "delete", { id: t.id }), []);
  assert.deepEqual(readTasks(file), []);
  assert.ok(!fs.existsSync(file + ".tmp"));
}));

test("a request that would change nothing is refused and leaves the file alone", () => withFile(file => {
  changeTask(file, "create", { text: "keep me" });
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => changeTask(file, "create", { text: "   " }), /needs some text/);
  assert.throws(() => changeTask(file, "check", { id: "nope" }), /no such task/);
  assert.throws(() => changeTask(file, "delete", {}), /no such task/);
  assert.throws(() => changeTask(file, "rename", { id: "x" }), /unknown task action/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
}));
