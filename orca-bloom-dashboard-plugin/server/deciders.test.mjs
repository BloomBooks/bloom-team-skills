// Tests for when a waiting decider form counts as abandoned (deciders.mjs, isAbandoned).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dataDir() reads the home folder on each call, so the forms go in a temporary one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "deciders-test-"));
process.env.HOME = process.env.USERPROFILE = home;
const { addDecider, getDecider, isAbandoned, waitForAnswers, answerDecider } = await import("./deciders.mjs");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const MIN = 60_000;

test("a new form is not abandoned; one nobody waited on for over 3 minutes is", () => {
  const { id } = addDecider({ name: "f", html: "<p>x</p>" });
  const d = getDecider(id);
  assert.equal(isAbandoned(d, d.createdAt + 2 * MIN), false);
  assert.equal(isAbandoned(d, d.createdAt + 4 * MIN), true);
});

test("a form with a waiter now is never abandoned, and the clock restarts when the waiter leaves", async () => {
  const { id } = addDecider({ name: "g", html: "<p>x</p>" });
  const d = getDecider(id);
  const waiting = waitForAnswers(id, 60 * MIN);
  assert.equal(isAbandoned(d, Date.now() + 10 * MIN), false);
  answerDecider(id, "answers");
  assert.equal(await waiting, "answers");
  assert.equal(isAbandoned(d, Date.now() + 2 * MIN), false);
  assert.equal(isAbandoned(d, Date.now() + 4 * MIN), true);
});
