// How the dashboard draws a card's row: its links, its Process steps, a preflight run's phases
// and the status chips, and how Orca's live agents change it. board.html and the Worktree panel
// in Orca (worktree-panel/panel.js) both load this file. Each page defines post(path, body),
// refresh(), showNote(text) and `let lastJson`, which the buttons here call.

// The Status pill: "you" when the row's Next is a decision for the developer, "asking" when an
// agent in the worktree is waiting on a question in its terminal, "agent" while an agent works,
// labelled with the skill it was started on when that skill is one of these.
const STATUS = { you: "Needs your decision", asking: "Claude has a question", agent: "Agent working" };
const SKILL_STATUS = { "preflight": "Preflighting", "request-peer-review": "Requesting peer review", "merge-without-peer-review": "Merging" };
// The skills a row's nextSkill may name, and the button that runs each in the worktree's session.
const SKILL_BUTTON = { "preflight": "Preflight", "request-peer-review": "Request Peer Review", "merge-without-peer-review": "Merge without Peer Review" };

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v; else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function link(href, text) {
  return el("a", { href, target: "_blank", rel: "noopener" }, text);
}

// The keys of the requests still running, e.g. "open:D:/x". The rows are redrawn every few seconds,
// so a button drawn while its request runs takes the busy look from here.
const pending = new Set();
function setBusy(key, on) {
  for (const b of document.querySelectorAll("[data-busy-key]")) {
    if (b.dataset.busyKey !== key) continue;
    b.classList.toggle("busy", on);
    b.setAttribute("aria-busy", String(on));
  }
}
// Gives a button made by action() a new class, keeping its busy look.
function restyle(b, cls) {
  b.className = cls;
  if (pending.has(b.dataset.busyKey)) b.classList.add("busy");
}
// A button whose click runs onClick once at a time per `key` (by default its class, title and text).
function action(cls, title, text, onClick, key) {
  const b = el("button", { type: "button", class: cls, title }, text);
  key ??= cls + "|" + title + "|" + text;
  b.dataset.busyKey = key;
  if (pending.has(key)) { b.classList.add("busy"); b.setAttribute("aria-busy", "true"); }
  b.addEventListener("click", async () => {
    if (pending.has(key)) return;
    pending.add(key);
    setBusy(key, true);
    try { await onClick(); } finally { pending.delete(key); setBusy(key, false); }
  });
  return b;
}
// Orca's own logo (resources/logo.svg in Orca's install), drawn in the button's colour, in a
// viewBox cropped to the logo so that the button centres it. With `isNew`, a sparkle over the
// button's upper right corner says that the button makes the worktree first.
const ORCA_PATH = "m 177.81311,248.33334 c 23.82304,-41.29793 40.54045,-66.84626 49.51207,-75.66667 6.81685,-6.70196 10.07373,-8.7374 20.07265,-12.54475 34.57822,-13.16655 61.04674,-26.78733 72.37222,-37.24295 9.62924,-8.88966 9.34286,-9.01142 -23.43671,-9.964 -35.71756,-1.03796 -43.72989,0.42119 -62.17546,11.323 -16.72118,9.88265 -34.20103,30.11225 -42.74704,49.47157 -2.57353,5.82985 -14.81294,44.3056 -27.96399,87.90747 -2.86036,9.48343 -3.02466,11.71633 -0.86213,11.71633 0.44382,0 7.29659,-11.25 15.22839,-25 z m -65.14644,-8.32267 C 120,239.3326 130.5,237.50979 136,235.95998 c 5.5,-1.5498 12.25,-3.13783 15,-3.52895 2.75,-0.39111 5,-0.95485 5,-1.25275 0,-0.29789 2.15135,-7.58487 4.78078,-16.19328 8.49209,-27.80201 12.21334,-40.41629 21.13747,-71.65166 4.81891,-16.86667 11.23502,-39.185 14.25802,-49.596301 5.12803,-17.66103 5.74763,-23.07037 2.64253,-23.07037 -1.84887,0 -4.07048,6.908293 -16.72243,52.000001 -21.78975,77.65896 -20.80806,74.74393 -26.84794,79.72251 -7.5925,6.25838 -25.03916,14.82524 -36.10856,17.73044 -17.0947,4.48656 -33.410599,3.86724 -53.116765,-2.01622 -18.569242,-5.54403 -23.142662,-5.80284 -33.639754,-1.9037 -5.875424,2.18242 -9.864152,5.04363 -16.716684,11.99127 -4.95,5.0187 -9.0000001,10.02884 -9.0000001,11.13364 0,1.75174 5.9276921,2.00299 46.3333351,1.96383 25.483334,-0.0247 52.333338,-0.59969 59.666668,-1.27777 z M 252.69513,104.63708 c 12.18267,-3.48651 15.77304,-7.895503 9.63821,-11.835773 -10.19296,-6.546726 -36.19849,-1.77301 -41.19436,7.561863 -1.2556,2.3461 -0.98698,3.2037 1.68353,5.375 2.69471,2.19098 4.59991,2.47691 12.53928,1.88189 5.14899,-0.3859 12.94899,-1.72824 17.33334,-2.98298 z";
function orcaIcon(isNew) {
  const sparkle = isNew ? '<svg class="sparkle" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 0 Q11.4 8.6 20 10 Q11.4 11.4 10 20 Q8.6 11.4 0 10 Q8.6 8.6 10 0 Z"/></svg>' : "";
  return `<svg viewBox="6.67 88 318.6 186" width="36" height="21" aria-hidden="true"><path fill="currentColor" d="${ORCA_PATH}"/></svg>${sparkle}`;
}
// The row's Orca button: opens its worktree, or makes one first when it has none.
function orcaButton(d) {
  const b = rowLink(d);
  if (!b) return null;
  restyle(b, "orca-icon");
  b.setAttribute("aria-label", b.title);
  b.innerHTML = orcaIcon(!d.worktree);
  return b;
}
function orcaLink(path, text) {
  return action("orca", "Show this worktree in Orca", text || "Open in Orca", () => post("/api/open", { path }), "open:" + path);
}
// A card with no worktree gets a button that makes one and starts Claude in it.
function createLink(d, text) {
  return action("orca", d.pr ? "Make a worktree on this PR's branch and start Claude in it" : "Make a worktree on a new branch for this card and start Claude in it",
    text || "Create & Open Orca Worktree", () => post("/api/create", { card: d.card, title: d.title || "", pr: d.pr || "" }), "create:" + d.card);
}
// The link for a row: open its worktree, or create one when the row is a single card without one.
function rowLink(d, text) {
  if (d.worktree) return orcaLink(d.worktree, text);
  if (/^BL-\d+$/.test(d.card || "")) return createLink(d, text);
  return null;
}
// The Status pill opens the row's worktree whenever there is one.
function statusPill(d) {
  if (!STATUS[d.who]) return null;
  const cls = "chip " + d.who;
  const text = (d.who === "agent" && SKILL_STATUS[d.skill]) || STATUS[d.who];
  const a = rowLink(d, text);
  if (!a) return withIcon(el("span", { class: cls }, text), STATUS_ICON[d.who]);
  restyle(a, cls + " pill-link");
  return withIcon(a, STATUS_ICON[d.who]);
}
// The Process column: the steps of Bloom's development process, in order. Code; Preflight; the
// developer's own review of the PR (files not yet marked Viewed in GitHub or reviewed in
// Reviewable); Request Peer Review, which squashes and checks the PR, with Merge without Peer
// Review beside it when the card has the "Approved Plan" tag; then the peer review itself.
// A step is finished when what comes after it has started: Code once there is a PR or the session
// names a next skill; Preflight once the session names request-peer-review, the PR is neither
// conflicting nor failing CI, and the code has not changed since the last preflight run ended
// (`codeChanged`: a new commit, or uncommitted changes to tracked files); the review once every
// file is reviewed. The first unfinished step is
// the only enabled button. An agent started on a step's skill shows on that step; any other agent
// shows on Code. A question or decision for the developer shows above the steps and disables them.
function processCell(d) {
  const blocked = d.who === "asking" || d.who === "you";
  const working = d.who === "agent";
  const broken = d.prMergeable === "CONFLICTING" || d.prChecks === "FAILURE";
  const r = d.ownReview;
  const left = r ? r.files - r.reviewed : null;
  const codeDone = !!(d.pr || d.nextSkill);
  const preflightDone = d.nextSkill === "request-peer-review" && !broken && !d.codeChanged;
  const reviewDone = preflightDone && left === 0;
  const done = [codeDone, preflightDone, reviewDone, false, false];
  let now = done.indexOf(false);
  // When the review cannot be read, the review and Request Peer Review are both offered.
  const reviewUnknown = preflightDone && !r;

  const skillButton = (s, enabled) => {
    const b = d.worktree ? action("orca skill", "Run /" + s + " in this worktree's Claude session", SKILL_BUTTON[s],
      async () => { if (await post("/api/run-skill", { path: d.worktree, skill: s })) { launched.set(normPath(d.worktree), { skill: s, at: Date.now() }); lastJson = ""; refresh(); } }, "skill:" + d.worktree) : el("button", { type: "button", class: "orca skill", title: "This card has no worktree yet" }, SKILL_BUTTON[s]);
    if (!enabled || !d.worktree) b.disabled = true;
    return b;
  };
  const label = text => el("span", { class: "lbl" }, text);
  // The running step: its name, how long the agent has worked, and what it is doing now.
  // A preflight run's own start time, when progress.mjs recorded one, beats the server's.
  const since = (activeRun(d) && new Date(d.progress.startedAt).getTime()) || d.since;
  const runningLabel = text => el("span", { class: "lbl" }, text,
    since ? el("span", { class: "elapsed", "data-since": String(since) }, elapsedText(since)) : null,
    d.tool ? el("small", { title: d.tool }, d.tool) : null);
  const running = SKILL_STATUS[d.skill] ? Object.keys(SKILL_STATUS).indexOf(d.skill) : -1;
  // The step an agent is working on: preflight is step 1; the two review-request skills step 3.
  const agentStep = !working ? -1 : running === 0 ? 1 : running > 0 ? 3 : 0;

  const steps = [];
  // 0. Code
  {
    let body;
    if (agentStep === 0) body = runningLabel("Agent working");
    else if (now === 0) {
      body = rowLink(d, d.worktree ? "Code" : "Start coding") || label("Code");
      if (body.tagName === "BUTTON") { restyle(body, "orca skill"); body.disabled = blocked || working; }
    } else body = label("Code");
    steps.push(body);
  }
  // 1. Preflight
  // Preflight, with a "report" link to its right when there is a report, in the developer's colour
  // when the report lists decisions waiting on them.
  {
    const n = d.reportDecisions;
    let body;
    if (agentStep === 1) body = runningLabel("Preflighting");
    else {
      body = now === 1 ? skillButton("preflight", !blocked && !working) : label(broken && d.pr ? "Preflight (conflict or CI failing)" : "Preflight");
      if (d.report) {
        // While Preflight is the next step, the report is from an earlier run that no longer
        // covers the code: "old report". A report with decisions waiting is the current one:
        // preflight stopped on them.
        const old = now === 1 && !(n > 0);
        const a = link(d.report, (old ? "old report" : "report") + (n > 0 && !old ? ` (${n} decision${n > 1 ? "s" : ""})` : ""));
        a.className = "report" + (n > 0 && !old ? " you" : "");
        a.title = old ? "Open the report of an earlier preflight, from before the latest changes" : "Open the preflight report";
        body = el("span", { class: "alts" }, body, a);
      }
    }
    steps.push(body);
  }
  // 2. Your review
  {
    const text = r ? (left ? `Your review (${left} of ${r.files} files left)` : "Your review") : "Your review";
    let body = label(text);
    if (now === 2 && d.pr) {
      body = link(reviewableUrl(d.pr) || d.pr.replace(/\/$/, "") + "/files", text);
      body.className = "btn work";
      if (r) body.title = "Not yet marked Viewed in GitHub or reviewed in Reviewable:\n" + r.left.join("\n");
      if (blocked || working) { body.removeAttribute("href"); body.style.opacity = "0.45"; }
    }
    steps.push(body);
  }
  // 3. Request Peer Review (squash and checks), or merge
  {
    const enabled = (now === 3 || reviewUnknown) && !blocked && !working;
    if (agentStep === 3) steps.push(runningLabel(SKILL_STATUS[d.skill]));
    else if (now === 3 || reviewUnknown) steps.push(el("span", { class: "alts" }, skillButton("request-peer-review", enabled), d.approvedPlan ? skillButton("merge-without-peer-review", enabled) : null));
    else steps.push(label(d.approvedPlan ? "Request Peer Review, or Merge" : "Request Peer Review"));
  }
  // 4. Peer review, done by a teammate; orange when it came back with comments.
  steps.push(label(d.ytState === "Has Comments" ? "Peer review: comments back" : "Peer review"));

  const ol = el("ol", { class: "steps" });
  steps.forEach((body, i) => {
    let cls = i === agentStep ? "running" : done[i] ? "done" : i === now || (i === 3 && reviewUnknown) ? "now" : "later";
    if (i === 4 && d.ytState === "Has Comments") cls = "comments";
    const icon = { done: "check", now: "dot", running: "spin", later: "empty", comments: "bubble" }[cls];
    ol.append(withIcon(el("li", { class: cls }, body), icon));
  });
  const badge = blocked ? statusPill(d) : null;
  if (badge) badge.classList.add("process-badge");
  return el("div", {}, badge ? el("div", {}, badge) : null, ol);
}
// A preflight run that progress.mjs is recording in the row's worktree: not ended, and either an
// agent works there or the run wrote within the last 45 minutes (a run whose agent died stops
// showing then). An agent started on request-peer-review or merge-without-peer-review counts only
// when the run wrote after that agent began working: those skills can hand the work back to
// preflight, but a run that a stopped preflight left without an end is older than the agent.
function activeRun(d) {
  const p = d.progress;
  if (!p || p.endedAt || !p.steps) return false;
  if (d.who === "agent" && d.skill && d.skill !== "preflight" && SKILL_STATUS[d.skill]
    && new Date(p.updatedAt).getTime() < (d.since || 0)) return false;
  return d.who === "agent" || Date.now() - new Date(p.updatedAt) < 45 * 60000;
}
// The phases of a preflight run, top to bottom; the parts of the automated reviews and tests run
// at the same time. Preflight also records `ci`, which is left out: on BloomDesktop the PR's
// checks are only pr-automation, which starts Devin, and Reviewable, pending until a person reviews.
const RUN_STEPS = [
  ["discover", "Discover", "Read the card, the PR and the repo's checks"],
  ["local", "Local checks", "Typecheck, lint, fast tests, local review"],
  ["merge", "Merge master", "Bring in the base branch"],
  ["publish", "Push and draft PR", ""],
  ["reviewers", "Automated reviews and tests", "", [["devin", "Devin"], ["bots", "Answering review comments"], ["tests", "Related tests"]]],
  ["report", "Report", "PR description, test ideas, report page"],
];
const RUN_ICON = { done: "check", running: "spin", failed: "alert", skipped: "empty", "": "empty" };
function preflightSteps(p) {
  const s = p.steps || {};
  const stateOf = id => s[id]?.state || "";
  const item = (state, name, note, kids) => {
    const li = el("li", { class: "run-" + (state || "todo") },
      el("span", { class: "lbl" }, name, note ? el("small", {}, note) : null, kids || null));
    return withIcon(li, RUN_ICON[state]);
  };
  const ol = el("ol", { class: "steps run" });
  for (const [id, name, hint, parts] of RUN_STEPS) {
    if (!parts) { ol.append(item(stateOf(id), name, s[id]?.note || (stateOf(id) === "running" ? hint : ""))); continue; }
    const states = parts.map(([k]) => stateOf(k));
    const state = states.includes("failed") ? "failed" : states.includes("running") ? "running"
      : states.every(x => x === "done" || x === "skipped") ? "done" : "";
    const sub = el("ol", { class: "steps sub" }, ...parts.map(([k, n]) => item(stateOf(k), n, s[k]?.note || "")));
    ol.append(item(state, name, "", sub));
  }
  return el("div", { class: "run-box" }, ol);
}
// What the people who asked for changes said, after a speech bubble drawn in the line's colour.
function commentsLine(text) {
  const line = el("span", { class: "comments" }, text);
  line.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg>');
  return line;
}
function cardLabel(d) {
  return d.cardUrl ? toned(d.cardUrl, d.card, CARD_TONE[d.ytState]) : document.createTextNode(d.card || "");
}

const isToday = t => t.toDateString() === new Date().toDateString();
// A row's ISO timestamp as "11-03 14:02", or "today 14:02", in the viewer's own time zone.
function localTime(iso) {
  const t = new Date(iso || "");
  if (isNaN(t)) return "";
  const two = n => String(n).padStart(2, "0");
  const day = isToday(t) ? "today" : `${two(t.getMonth() + 1)}-${two(t.getDate())}`;
  return `${day} ${two(t.getHours())}:${two(t.getMinutes())}`;
}

// The colour class of a card link, by the card's State, and of a PR link, by the PR's state:
// st-work (green) for work the developer still has to do, st-comments (orange) for Has Comments, st-review (purple) for ready for review,
// st-done (blue, --accent) for presumed done. History's Finished icon is the same blue.
const CARD_TONE = { "In Progress": "st-work", "Has Comments": "st-comments", "Ready For Code Review": "st-review", "Ready For UI Review": "st-review", "Ready For Testing": "st-done", "Closed": "st-done" };
const PR_TONE = { draft: "st-work", open: "st-review", merged: "st-done" };
// The icons of the status chips, drawn in the chip's --tone: an empty circle, a half-filled one
// for work under way, a dot for waiting on a reviewer, a tick for done.
const ICON = {
  empty: '<circle cx="12" cy="12" r="9"/>',
  half: '<circle cx="12" cy="12" r="9"/><path class="solid" d="M12 3a9 9 0 0 1 0 18z"/>',
  dot: '<circle cx="12" cy="12" r="9"/><circle class="solid" cx="12" cy="12" r="3.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>',
  spin: '<circle cx="12" cy="12" r="9" opacity="0.3"/><path d="M12 3a9 9 0 0 1 9 9"/>',
  bubble: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.4v.4M12 16.5h.01"/>'
};
const TONE_ICON = { "st-work": "half", "st-review": "dot", "st-done": "check" };
const STATUS_ICON = { you: "alert", asking: "question", agent: "half" };
function withIcon(e, name) {
  e.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ICON.empty}</svg>`);
  return e;
}
// A card's State as an icon in the State's colour, put to the left of the card's id; hovering it
// names the State.
function stateIcon(state) {
  if (!state) return null;
  const tone = CARD_TONE[state] || "";
  const s = el("span", { class: "yt-icon " + tone, title: state, role: "img", "aria-label": state });
  return withIcon(s, state === "Has Comments" ? "bubble" : TONE_ICON[tone]);
}
function toned(url, text, tone) {
  const a = link(url, text);
  a.classList.add(tone || "st-plain");
  return a;
}
// A PR's GitHub link and, beside it in the same colour, Reviewable's rabbit linking to the same
// PR in Reviewable (https://reviewable.io/reviews/<owner>/<repo>/<number>).
const REVIEWABLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="9" cy="6" rx="2" ry="4.5" transform="rotate(-15 9 6)"/><ellipse cx="17.5" cy="7.5" rx="1.8" ry="4" transform="rotate(40 17.5 7.5)"/><circle cx="13" cy="15.5" r="6"/><circle cx="11" cy="15" r="2.4"/><path d="M9.6 17l-1.6 5"/></svg>';
// GitHub's merge symbol (Octicons git-merge-16), put inside a merged PR's link before its text;
// hovering it says "Merged".
const MERGED_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>';
function markMerged(a, prState) {
  if (prState !== "merged") return a;
  const icon = el("span", { class: "merged-icon", title: "Merged", role: "img", "aria-label": "Merged" });
  icon.innerHTML = MERGED_ICON;
  a.prepend(icon);
  return a;
}
// The PR's page in Reviewable, or null for a URL that is not a GitHub PR.
function reviewableUrl(url) {
  const m = String(url || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `https://reviewable.io/reviews/${m[1]}/${m[2]}/${m[3]}` : null;
}
function prLinks(url, tone) {
  const pr = toned(url, "PR " + url.split("/").pop(), tone);
  if (tone === PR_TONE.merged) markMerged(pr, "merged");
  const rvUrl = reviewableUrl(url);
  if (!rvUrl) return pr;
  const rv = toned(rvUrl, null, tone);
  rv.classList.add("reviewable");
  rv.title = "Open this PR in Reviewable";
  rv.setAttribute("aria-label", "Open this PR in Reviewable");
  rv.innerHTML = REVIEWABLE_ICON;
  return el("span", { class: "pr-links" }, pr, rv);
}

// Orca's live agent states override the Status that Claude last wrote: a waiting agent means
// Claude has a question in its terminal, a working one means an agent has the card.
// A skill button that was just clicked counts as that skill running for up to a minute, until
// Orca reports the agent working, so the step spins at once.
const launched = new Map();
const normPath = p => (p || "").replace(/\\/g, "/").toLowerCase();
function withLiveAgents(rows, agents) {
  return rows.map(d => {
    const key = normPath(d.worktree);
    const a = d.worktree && agents[key];
    const l = launched.get(key);
    if (l && (Date.now() - l.at > 60000 || a?.working || a?.waiting)) launched.delete(key);
    if (a?.waiting) return { ...d, who: "asking", question: a.question || "" };
    if (a?.working) {
      const r = { ...d, who: "agent", skill: a.skill || "", since: a.since || 0, tool: a.tool || "" };
      // An agent can run preflight without having been started on /preflight (asked in words, or
      // handed on by another skill); a preflight run that progress.mjs is recording says it is.
      if (activeRun(r)) r.skill = "preflight";
      return r;
    }
    if (launched.has(key)) return { ...d, who: "agent", skill: l.skill, since: l.at, tool: "Starting…" };
    return d;
  });
}

// How long an agent has worked, as "for 12 min"; the rows redraw only when the state changes, so
// the running steps' times are updated here.
function elapsedText(since) {
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 1 ? "just started" : m < 60 ? `for ${m} min` : `for ${Math.floor(m / 60)} h ${m % 60} min`;
}
