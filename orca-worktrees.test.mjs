// Tests for the parts of orca-worktrees.mjs that need no Orca. Run: node --test "*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentState, parsePr, pickAgentTerminal, quote, titleWords } from "./orca-worktrees.mjs";

const term = (tabId, leafId, handle) => ({ tabId, leafId, handle });
const agent = (paneKey, state) => ({ paneKey, state });

test("without a pane named, a waiting agent's terminal comes first, then a working one's", () => {
  const terms = [term("a", "1", "h1"), term("b", "1", "h2"), term("c", "1", "h3")];
  const agents = [agent("a:1", "done"), agent("b:1", "working"), agent("c:1", "waiting")];
  assert.equal(pickAgentTerminal(agents, terms).handle, "h3");
  assert.equal(pickAgentTerminal(agents.slice(0, 2), terms).handle, "h2");
});

test("an agent with no terminal is passed over, and none at all is null", () => {
  assert.equal(pickAgentTerminal([agent("x:1", "waiting"), agent("a:1", "done")], [term("a", "1", "h1")]).handle, "h1");
  assert.equal(pickAgentTerminal([agent("x:1", "waiting")], []), null);
});

test("a named pane is that agent's terminal, or an error when it has closed", () => {
  const terms = [term("a", "1", "h1"), term("b", "1", "h2")];
  const agents = [agent("a:1", "waiting"), agent("b:1", "done")];
  assert.equal(pickAgentTerminal(agents, terms, "b:1").handle, "h2");
  assert.throws(() => pickAgentTerminal(agents, terms, "z:9"), /has closed/);
});

test("an agent waiting on its Monitor counts as done", () => {
  assert.equal(agentState({ state: "working", workingMode: "monitoring" }), "done");
  assert.equal(agentState({ state: "working" }), "working");
});

test("quote refuses what a shell would misread, and quotes spaces", () => {
  assert.equal(quote("D:/BL-1-x"), "D:/BL-1-x");
  assert.equal(quote("D:/My Work"), '"D:/My Work"');
  assert.throws(() => quote('a"b'));
  assert.throws(() => quote("100%"));
});

test("titleWords and parsePr", () => {
  assert.deepEqual(titleWords("[6.5] Fix the Undo button, again"), ["Fix", "the", "Undo"]);
  assert.deepEqual(parsePr("https://github.com/BloomBooks/BloomDesktop/pull/8551"), { repo: "bloombooks/bloomdesktop", number: "8551" });
  assert.equal(parsePr("https://example.com/x"), null);
});
