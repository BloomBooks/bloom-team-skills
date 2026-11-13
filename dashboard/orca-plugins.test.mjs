// Tests for how orca-plugins.mjs reads Orca's replies. Run: node --test "dashboard/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PLUGINS, describe, readLoadReply } from "./orca-plugins.mjs";

test("a plugin that Orca loaded is running", () => {
  assert.deepEqual(readLoadReply({ ok: true, result: { approval: "already-approved", plugin: { status: "running" } } }), { state: "running" });
});

test("a plugin that Orca has not approved gives its fingerprint and the access to show", () => {
  const reply = {
    ok: false,
    error: {
      code: "approval_required",
      message: "Bloom Worktree needs approval",
      data: {
        approvalFingerprint: "ap1-abc",
        grants: {
          executionDescription: "Runs its own code in a separate Node.js process.",
          capabilities: [{ kind: "workspace:read", description: "Read your focused workspace" }, { kind: "agent:read" }],
          contributions: [{ kind: "panels", name: "Worktree" }],
        },
      },
    },
  };
  assert.deepEqual(readLoadReply(reply), {
    state: "needs-approval",
    fingerprint: "ap1-abc",
    access: ["Runs its own code in a separate Node.js process.", "Read your focused workspace", "agent:read", 'Adds to Orca: panels "Worktree"'],
  });
});

test("an approval that a pull made stale also waits for approval", () => {
  const reply = { ok: false, error: { code: "approval_stale", message: "changed", data: { approvalFingerprint: "ap1-new" } } };
  assert.equal(readLoadReply(reply).state, "needs-approval");
});

test("any other refusal is an error that carries Orca's code and message", () => {
  assert.deepEqual(readLoadReply({ ok: false, error: { code: "plugin_system_disabled", message: "Plugins are off" } }),
    { state: "error", message: "plugin_system_disabled: Plugins are off" });
});

test("each plugin's folder holds an Orca manifest whose id matches its key", () => {
  for (const plugin of PLUGINS) {
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin.dir, "orca-plugin.json"), "utf8"));
    assert.equal("local." + manifest.id, plugin.key);
  }
});

test("the report has a line per plugin, or one line when orca is missing", () => {
  assert.deepEqual(describe({ orca: false, plugins: [] }), ["orca is not installed, so its plugins were not loaded"]);
  assert.deepEqual(
    describe({ orca: true, plugins: [{ name: "A", state: "running", approved: true }, { name: "B", state: "needs-approval" }, { name: "C", state: "error", message: "x: y" }] }),
    ["A: approved and running", "B: waiting for approval", "C: x: y"],
  );
});
