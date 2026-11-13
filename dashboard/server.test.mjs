// Tests for what server.mjs prints for the session that started it (SKILL.md, step 1), how it
// guards the page's buttons, and what it tells the session about the rows it wrote.
// Run: node --test "dashboard/**/*.test.mjs"
//
// Each server runs on a free port with a temporary home folder, --no-window and --keep-sessions,
// so a test touches neither the developer's own dashboard nor any Claude session. ORCA_CLI_COMMAND
// names a command that does not exist, so the server finds no Orca, as on CI: an orca command it
// started would outlive it and hold the home folder open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./server.mjs", import.meta.url));

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
  const data = path.join(home, ".claude", "bloom-dashboard");
  fs.mkdirSync(path.join(data, "rows"), { recursive: true });
  return { home, data, cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

// Starts a server and resolves once it prints its first line. `lines` collects everything it
// prints; `exit` resolves to its exit code.
function start(home, port) {
  const child = spawn(process.execPath, [script, "--port", String(port), "--no-window", "--keep-sessions", "--gather-minutes", "600"],
    { env: { ...process.env, HOME: home, USERPROFILE: home, ORCA_CLI_COMMAND: "no-orca-for-tests" }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let firstLine;
  const first = new Promise(r => { firstLine = r; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", d => { for (const l of d.split(/\r?\n/).filter(Boolean)) { lines.push(l); firstLine(l); } });
  const exit = new Promise(r => child.on("exit", code => r(code)));
  return { child, lines, first, exit };
}

const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timed out waiting for " + what)), ms))]);
const tokenOf = async base => (await (await fetch(base + "/")).text()).match(/DASHBOARD_TOKEN="([0-9a-f]+)"/)[1];
const postJson = (base, p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the server prints its URL, serves the page with a token, and refuses buttons without it", async () => {
  const { home, data, cleanup } = makeHome();
  fs.writeFileSync(path.join(data, "rows", "BL-1.json"), JSON.stringify({ card: "BL-1", group: "near", who: "idle" }));
  const port = await freePort();
  const s = start(home, port);
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal(await within(s.first, 15000, "DASHBOARD_URL"), `DASHBOARD_URL ${base}/`);
    const health = await (await fetch(base + "/api/health")).json();
    assert.equal(health.dashboard, true);
    const state = await (await fetch(base + "/api/state")).json();
    assert.deepEqual(state.rows.map(r => r.card), ["BL-1"]);
    assert.deepEqual(state.problems, []);
    assert.equal((await postJson(base, "/api/open", { path: "D:/x" })).status, 403);
    assert.equal((await postJson(base, "/api/handover", {})).status, 403);
    const token = await tokenOf(base);
    const created = await (await postJson(base, "/api/task/create", { text: "Try it by hand" }, { "x-dashboard-token": token })).json();
    assert.equal(created.ok, true);
    assert.deepEqual(created.tasks.map(t => t.text), ["Try it by hand"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "tasks.json"), "utf8")).length, 1);
    const unknown = await postJson(base, "/api/nothing", {}, { "x-dashboard-token": token });
    assert.equal(unknown.status, 404);
  } finally {
    s.child.kill();
    await s.exit;
    cleanup();
  }
});

test("a row the session wrote wrongly reaches the page, and events.log once", async () => {
  const { home, data, cleanup } = makeHome();
  fs.writeFileSync(path.join(data, "rows", "BL-2.json"), JSON.stringify({ card: "BL-2", group: "nearly" }));
  const port = await freePort();
  const s = start(home, port);
  try {
    const base = `http://127.0.0.1:${port}`;
    await within(s.first, 15000, "DASHBOARD_URL");
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(state.problems.length, 1);
    assert.match(state.problems[0].problem, /group "nearly"/);
    await fetch(base + "/api/state");
    const told = fs.readFileSync(path.join(data, "events.log"), "utf8").split("\n").filter(l => l.includes(" row: "));
    assert.equal(told.length, 1);
    assert.match(told[0], /^BL-2 row: has group "nearly".*\(rows\/BL-2\.json\)$/);
  } finally {
    s.child.kill();
    await s.exit;
    cleanup();
  }
});

test("Remove refuses a worktree the facts don't list, and one that gained uncommitted files", async () => {
  const { home, data, cleanup } = makeHome();
  // A real checkout with a file git has not seen, which the facts said nothing about.
  const wt = path.join(home, "wt");
  fs.mkdirSync(wt);
  spawnSync("git", ["init", "-q", wt]);
  fs.writeFileSync(path.join(wt, "new.txt"), "x");
  const stale = { card: "BL-3", title: "Done", state: "Closed", path: wt.replace(/\\/g, "/"), warnings: [] };
  fs.writeFileSync(path.join(data, "facts.json"), JSON.stringify({ cards: [], prs: [], worktrees: [], staleWorktrees: [stale] }));
  const port = await freePort();
  const s = start(home, port);
  try {
    const base = `http://127.0.0.1:${port}`;
    await within(s.first, 15000, "DASHBOARD_URL");
    assert.deepEqual((await (await fetch(base + "/api/state")).json()).staleWorktrees.map(w => w.card), ["BL-3"]);
    const token = await tokenOf(base);
    const remove = async body => (await postJson(base, "/api/remove-worktree", body, { "x-dashboard-token": token })).json();
    const unlisted = await remove({ path: "D:/elsewhere", confirmed: [] });
    assert.equal(unlisted.ok, false);
    assert.match(unlisted.error, /does not list/);
    const dirty = await remove({ path: stale.path, confirmed: [] });
    assert.equal(dirty.ok, false);
    assert.match(dirty.error, /now has 1 uncommitted file; nothing was removed/);
    assert.ok(fs.existsSync(path.join(wt, "new.txt")));
  } finally {
    s.child.kill();
    await s.exit;
    cleanup();
  }
});

test("a second server takes the port over, and the first prints REPLACED and exits 0", async () => {
  const { home, data, cleanup } = makeHome();
  const port = await freePort();
  const a = start(home, port);
  let b;
  try {
    await within(a.first, 15000, "the first server");
    b = start(home, port);
    assert.equal(await within(b.first, 20000, "the second server"), `DASHBOARD_URL http://127.0.0.1:${port}/`);
    assert.equal(await within(a.exit, 5000, "the first server to exit"), 0);
    assert.ok(a.lines.some(l => l.startsWith("REPLACED")), a.lines.join("\n"));
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.pid, b.child.pid);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "running.json"), "utf8")).pid, b.child.pid);
  } finally {
    a.child.kill();
    b?.child.kill();
    await Promise.all([a.exit, b?.exit]);
    cleanup();
  }
});

test("a killed server leaves running.json with its pid, for the Orca plugin to revive", async () => {
  const { home, data, cleanup } = makeHome();
  const port = await freePort();
  const s = start(home, port);
  try {
    await within(s.first, 15000, "DASHBOARD_URL");
    s.child.kill();
    await s.exit;
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "running.json"), "utf8")).pid, s.child.pid);
  } finally {
    s.child.kill();
    await s.exit;
    cleanup();
  }
});

test("closing the window stops the server with WINDOW_CLOSED, and removes running.json", async () => {
  const { home, data, cleanup } = makeHome();
  const port = await freePort();
  const s = start(home, port);
  try {
    const base = `http://127.0.0.1:${port}`;
    await within(s.first, 15000, "DASHBOARD_URL");
    assert.ok(fs.existsSync(path.join(data, "running.json")));
    await fetch(base + "/api/state");
    assert.equal((await fetch(base + "/api/closing", { method: "POST", body: "wrong" })).status, 403);
    assert.equal((await fetch(base + "/api/closing", { method: "POST", body: await tokenOf(base) })).status, 200);
    assert.equal(await within(s.exit, 10000, "the server to exit"), 0);
    assert.ok(s.lines.some(l => l.startsWith("WINDOW_CLOSED")), s.lines.join("\n"));
    assert.ok(!fs.existsSync(path.join(data, "running.json")));
  } finally {
    s.child.kill();
    await s.exit;
    cleanup();
  }
});

test("a port that something else holds is PORT_TAKEN, exit 4", async () => {
  const { home, cleanup } = makeHome();
  const other = net.createServer(c => c.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"));
  await new Promise(r => other.listen(0, "127.0.0.1", r));
  const s = start(home, other.address().port);
  try {
    assert.match(await within(s.first, 20000, "PORT_TAKEN"), /^PORT_TAKEN/);
    assert.equal(await within(s.exit, 5000, "the server to exit"), 4);
  } finally {
    s.child.kill();
    other.close();
    cleanup();
  }
});
