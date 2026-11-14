// How the dashboard draws a card's row. board.html and the Worktree panel in Orca
// (plugin/panel.js) both load this file. It holds no rule about Bloom's process: the service
// computes each row (service/rows.mjs), with every step's state, every button's enabled state and
// the reasons, and this file draws what it is given.
//
// Each page defines act(body), which posts an action to the service and resolves to its answer or
// null after showing why it failed, and FRONT, whether Orca's window should come to the front
// after an action (true on the dashboard page, false inside Orca).
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

// A button that the service described: { id, label, enabled, reason }. `body` is what it posts.
function serviceButton(b, body, cls, text, key) {
  const btn = action(cls, b.enabled ? "" : b.reason, text ?? b.label, () => act(body), key ?? b.id + ":" + (body.path || body.card || ""));
  if (!b.enabled) btn.disabled = true;
  return btn;
}
const bodyOf = (d, id) => id === "create" ? { action: "create", card: d.card, front: FRONT } : { action: id, path: d.worktree, front: FRONT };
// The row's Orca button: opens its worktree, or makes one first when it has none (the sparkle).
function orcaButton(d) {
  const b = d.worktree ? d.actions.open : d.actions.create;
  if (!d.worktree && !/^BL-\d+$/.test(d.card || "")) return null;
  const btn = serviceButton(b, bodyOf(d, b.id), "orca-icon", "");
  btn.title = b.enabled ? (d.worktree ? "Show this worktree in Orca" : "Make a worktree for this card and start Claude in it") : b.reason;
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = orcaIcon(!d.worktree);
  return btn;
}
// The worktree's folder, which opens in VS Code.
function folderButton(d) {
  return serviceButton(d.actions.vscode, { action: "vscode", path: d.worktree }, "orca wt", d.worktree, "vscode:" + d.worktree);
}
// "Claude has a question" or "Needs your decision", above the steps. The first opens the
// worktree's terminal; the second opens the decider form or the report that holds the decisions.
function badgeOf(d) {
  if (!d.badge) return null;
  const cls = "chip " + d.badge.kind + " process-badge";
  let e;
  if (d.badge.url) { e = link(d.badge.url, d.badge.text); e.className = cls + " pill-link"; }
  else if (d.worktree) e = serviceButton(d.actions.open, bodyOf(d, "open"), cls + " pill-link", d.badge.text, "badge:" + d.worktree);
  else e = el("span", { class: cls }, d.badge.text);
  return withIcon(e, d.badge.kind === "asking" ? "question" : "alert");
}
// The Process column: the steps the service gave, in order. A finished step is muted with a tick,
// a step with buttons is the one on offer, and a running step shows how long its agent has worked.
function processCell(d) {
  const label = text => el("span", { class: "lbl" }, text);
  const withNote = (body, text) => el("span", { class: "noted" }, body, el("small", {}, text));
  const ol = el("ol", { class: "steps" });
  const icon = { done: "check", now: "dot", running: "spin", later: "empty", comments: "bubble" };
  for (const s of d.steps) {
    let body;
    if (s.state === "running") {
      body = el("span", { class: "lbl" }, s.label,
        s.since ? el("span", { class: "elapsed", "data-since": String(s.since) }, elapsedText(s.since)) : null,
        s.runningNote ? el("small", {}, s.runningNote) : null);
    } else if (s.buttons?.length) {
      const bs = s.buttons.map(b => serviceButton(b, bodyOf(d, b.id), "orca skill", b.label, "step:" + b.id + ":" + (d.worktree || d.card)));
      body = bs.length > 1 ? el("span", { class: "alts" }, ...bs) : bs[0];
    } else if (s.link) {
      const rvUrl = reviewableUrl(s.link);
      body = link(rvUrl || s.link.replace(/\/$/, "") + "/files", s.label);
      body.className = "btn work";
      if (rvUrl) { const i = el("span", { class: "rv-icon", "aria-hidden": "true" }); i.innerHTML = REVIEWABLE_ICON; body.prepend(i); }
      if (s.files) body.title = (s.reviewable ? "" : "Couldn't read your marks in Reviewable, so only files marked Viewed in GitHub count.\n\n")
        + "Not yet marked Viewed in GitHub or reviewed in Reviewable:\n" + s.files.join("\n");
      if (!s.linkEnabled) { body.removeAttribute("href"); body.style.opacity = "0.45"; }
    } else body = label(s.label);
    if (s.id === "preflight" && d.report && s.state !== "running") {
      const n = d.report.decisions;
      const a = link(d.report.url, (d.report.old ? "old report" : "report") + (n > 0 ? ` (${n} decision${n > 1 ? "s" : ""})` : ""));
      a.className = "report" + (n > 0 ? " you" : "");
      a.title = d.report.old ? "Open the report of an earlier preflight, from before the latest changes" : "Open the preflight report";
      body = el("span", { class: "alts" }, body, a);
    }
    if (s.id === "peer" && s.state === "comments" && d.pr) body = el("span", { class: "pr-links" }, body, reviewableLink(d.pr));
    if (s.note) body = withNote(body, s.note);
    ol.append(withIcon(el("li", { class: s.state + (body.classList.contains("noted") ? " two-line" : "") }, body), icon[s.state]));
  }
  const badge = badgeOf(d);
  return el("div", {}, badge ? el("div", {}, badge) : null, ol,
    d.failed ? el("p", { class: "failed", role: "alert" }, d.failed) : null);
}
// "Where it stands": a preflight run's phases while one runs; otherwise what the service
// computed, the prose written about it, and what could not be read.
function standsCell(d) {
  const out = el("div", { class: "stands" });
  if (d.run) {
    out.append(preflightSteps({ steps: d.run.phases }));
  } else {
    const p = d.prose;
    if (p?.status) {
      const s = el("span", { class: "prose" + (p.stale ? " stale" : "") }, p.status);
      s.title = `Written by ${p.model} at ${localTime(new Date(p.at).toISOString())}` + (p.stale ? ", before the latest changes; a new one is on its way" : "");
      out.append(s);
    } else out.append(el("span", { class: "computed" }, d.reasons.join(" ")));
    if (d.stopped && Object.keys(d.stopped.phases).length) out.append(preflightSteps({ steps: d.stopped.phases }));
    if (p?.comments && d.ytState === "Has Comments") out.append(commentsLine(p.comments));
    if (d.question) out.append(el("span", { class: "question" }, el("b", {}, "Claude asks: "), d.question));
    if (p?.next) out.append(el("span", { class: "next" }, el("b", {}, "Next: "), p.next));
  }
  for (const u of d.unknown || []) out.append(el("span", { class: "unknown", title: u.error }, `${u.source} could not be read${u.since ? "; showing what it said " + agoText(u.since) : ""}`));
  out.append(whyDetails(d));
  return out;
}
// "Why?": the rule that put the row in its state, each fact with its source and age, and the
// latest events in its worktree.
function agoText(t) {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
}
const openWhy = new Set();   // the rows whose "Why?" is open, kept across redraws
function whyDetails(d) {
  const id = d.card + "|" + (d.worktree || "");
  const box = el("details", { class: "why" }, el("summary", {}, "Why?"));
  box.open = openWhy.has(id);
  box.addEventListener("toggle", () => { box.open ? openWhy.add(id) : openWhy.delete(id); });
  const dl = el("dl", {});
  for (const f of d.why) {
    dl.append(el("dt", {}, f.label), el("dd", {}, f.text, f.source ? el("small", { "data-ago": String(f.at || 0), "data-source": f.source }, ` ${f.source}, read ${agoText(f.at)}`) : null));
  }
  box.append(dl);
  if (d.events?.length) box.append(el("ul", { class: "events" }, ...d.events.slice().reverse().map(e => el("li", {}, el("time", {}, localTime(new Date(e.at).toISOString())), " " + e.text))));
  return box;
}
// The phases of a preflight run, top to bottom; the parts of the automated reviews and tests run
// at the same time. Preflight also records `ci`, which is left out: on BloomDesktop the PR's
// checks are only pr-automation, which starts Devin, and Reviewable, pending until a person reviews.
const RUN_STEPS = [
  ["discover", "Discover", "Read the card, the PR and the repo's checks"],
  ["local", "Local checks", "Typecheck, lint, fast tests, local review"],
  ["walkaround", "Walkaround", "The whole PR: one job in one place, names that fit, nothing left over"],
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
// Reviewable's rabbit, linking to the PR (a GitHub PR URL) in Reviewable, or null for a URL that
// is not a GitHub PR.
function reviewableLink(url, tone) {
  const rvUrl = reviewableUrl(url);
  if (!rvUrl) return null;
  const rv = toned(rvUrl, null, tone);
  rv.classList.add("reviewable");
  rv.title = "Open this PR in Reviewable";
  rv.setAttribute("aria-label", "Open this PR in Reviewable");
  rv.innerHTML = REVIEWABLE_ICON;
  return rv;
}
function prLinks(url, tone) {
  const pr = toned(url, "PR " + url.split("/").pop(), tone);
  if (tone === PR_TONE.merged) markMerged(pr, "merged");
  const rv = reviewableLink(url, tone);
  return rv ? el("span", { class: "pr-links" }, pr, rv) : pr;
}
// How long an agent has worked, as "for 12 min"; the rows redraw only when the state changes, so
// the running steps' times are updated here.
function elapsedText(since) {
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 1 ? "just started" : m < 60 ? `for ${m} min` : `for ${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---- the service indicator -------------------------------------------------------------------
// A dot and "Service", in the dashboard page's top bar and in the upper right of the Worktree
// panel: green when every source answered its last read, amber when one did not or new code does
// not load, red when the page has lost the service. Pressing it lists each source with the age of
// its last read, the code the service runs, the model that writes the prose, and Restart. Each
// page has a button with the id "service" and a hidden element with the id "service-pop".
const SOURCE_NAMES = { developer: "Your logins", orca: "Orca", github: "GitHub", youtrack: "YouTrack", reviewable: "Reviewable" };
function drawService(service, connected, lostAt) {
  const chip = document.getElementById("service"), pop = document.getElementById("service-pop");
  const failing = service ? Object.entries(SOURCE_NAMES).filter(([k]) => service.sources[k].error) : [];
  const tone = !connected ? "down" : service?.codeError || failing.length ? "warn" : "ok";
  chip.className = "service-chip " + tone;
  chip.querySelector(".service-label").textContent = !connected ? "Service not answering" : service?.codeError ? "Service: new code does not load" : failing.length ? "Service: " + failing.map(([, n]) => n).join(", ") + " not read" : "Service";
  if (pop.hidden) return;
  const rows = [];
  const row = (k, v, cls) => rows.push(el("dt", {}, k), el("dd", cls ? { class: cls } : {}, v));
  if (!connected) row("Connection", "lost " + agoText(lostAt) + "; reconnecting", "bad");
  if (service) {
    const s = service;
    row("Running", `since ${localTime(new Date(s.startedAt).toISOString())}, process ${s.pid}`);
    row("Code", `${s.code.branch || "?"} at ${s.code.commit || "?"}` + (s.code.changedAt ? `, files changed ${agoText(s.code.changedAt)}` : ""));
    row("Code folder", s.code.dir);
    if (s.codeError) row("New code", "does not load, so the service still runs the code from before the change: " + s.codeError, "bad");
    for (const [k, name] of Object.entries(SOURCE_NAMES)) {
      const x = s.sources[k];
      row(name, x.error ? `failed: ${x.error}` + (x.at ? ` (last good read ${agoText(x.at)})` : "") : x.at ? "read " + agoText(x.at) : "not read yet", x.error ? "bad" : "");
    }
    row("Claude Code hooks", s.sources.hooks.at ? `${s.sources.hooks.count} since start, the last ${agoText(s.sources.hooks.at)}` : "none received since start", "");
    row("Orca plugin", s.workerConnected ? "connected, pushing agent changes" : "not connected; Orca is asked every 5 s while this window shows", s.workerConnected ? "" : "warn");
    row("Sessions", `${s.sessions} known, ${s.openRuns} with a skill running`);
    const l = s.sources.llm;
    row("Prose model", l.enabled ? `${l.model}: ${l.calls} call${l.calls === 1 ? "" : "s"} today, ${l.inputTokens + l.outputTokens} tokens, $${l.costUsd.toFixed(3)}` + (l.lastError ? `; last failure: ${l.lastError}` : "") : "off (config.json)", l.lastError ? "warn" : "");
    row("Polling", s.visible ? "on: a window or panel is showing" : "off: nothing is showing");
  }
  const restart = action("refresh", "Stop the service and start it again from the same code folder", "Restart service", async () => { await act({ action: "restart" }, "Couldn't restart"); }, "restart");
  pop.replaceChildren(el("dl", { class: "kv" }, ...rows), restart);
}
// Opens and closes the list. `redraw` draws the indicator from what the page knows now.
function wireService(redraw) {
  document.getElementById("service").addEventListener("click", () => { const pop = document.getElementById("service-pop"); pop.hidden = !pop.hidden; redraw(); });
  document.addEventListener("click", e => { if (!e.target.closest("#service, #service-pop")) document.getElementById("service-pop").hidden = true; });
}
