// The Claude Code sessions on this machine and the runs of Bloom's process skills in them, kept
// from what Claude Code's hooks, the skills' progress records and Orca report. Everything here is a
// plain function of its arguments that changes the `state` it is given, so runs.test.mjs tests it.
//
// A run is one invocation of one of SKILLS in one session. Its states:
//
//   working    the session is in a turn
//   waiting    the turn ended with background tasks or scheduled wake-ups in flight (preflight
//              waiting on reviewers and CI)
//   paused     the turn ended with nothing in flight and the run not finished, or the developer
//              interrupted it, or the API failed; the session is still there
//   finished   preflight recorded its end (progress.mjs end); any other skill's turn ended
//   ended      the session ended, or its process is gone, before the run finished
//
//   (none) -> working                 the skill was invoked: typed, called by the model, or its
//                                     first progress record arrived
//   working -> waiting                Stop hook listing tasks in flight
//   working -> paused                 Stop hook with nothing in flight (preflight only), an
//                                     interrupt that Orca reports, or StopFailure
//   waiting, paused -> working        a new prompt in the session
//   working, waiting, paused -> finished   progress end (preflight); Stop with nothing in flight
//                                          (the other skills)
//   working, waiting, paused -> ended      SessionEnd, the session's process gone, or Orca showing
//                                          no session in the worktree
//
// A session's own record says whether it is in a turn, which is where "working for 12 min" comes
// from: the time of the prompt, not the age of the session.
import { COMMENTS_PROMPT_START } from "../../orca-worktrees.mjs";

export const SKILLS = ["preflight", "request-peer-review", "merge-without-peer-review", "process-pr-comments"];
export const HAND_OFF = ["request-peer-review", "merge-without-peer-review"];
export const OPEN = ["working", "waiting", "paused"];
const KEPT_RUNS = 300;

export const emptyState = () => ({ sessions: {}, runs: [] });
export const isOpen = run => OPEN.includes(run.state);

/** The open run in a worktree (the newest when a hand-off skill handed back to preflight), or null. */
export function openRun(state, worktree) {
  return state.runs.findLast(r => r.worktree === worktree && isOpen(r)) ?? null;
}
/** The newest run of `skill` in a worktree, whatever its state, or null. */
export function latestRun(state, worktree, skill) {
  return state.runs.findLast(r => r.worktree === worktree && r.skill === skill) ?? null;
}
/** The sessions in a worktree that have not ended. */
export function sessionsIn(state, worktree) {
  return Object.values(state.sessions).filter(s => s.worktree === worktree && !s.endedAt);
}

function move(run, to, now, cause = "") {
  if (run.state === to && run.cause === cause) return null;
  const from = run.state;
  run.state = to;
  run.cause = cause;
  run.updatedAt = now;
  if (!isOpen(run)) run.endedAt ??= now;
  return `${run.skill} in ${run.worktree}: ${from} -> ${to}${cause ? " (" + cause + ")" : ""}`;
}

function begin(state, session, skill, signal, now) {
  const changes = [];
  const worktree = session?.worktree ?? null;
  const mine = state.runs.findLast(r => r.session === session.id && r.skill === skill && isOpen(r));
  if (mine) {
    if (!mine.signals.includes(signal)) mine.signals.push(signal);
    const c = move(mine, "working", now);
    return c ? [c] : [];
  }
  // A worktree has one open run: starting a skill there closes what another session, or an earlier
  // skill of this one, left open.
  for (const r of state.runs) {
    if (r.worktree !== worktree || !isOpen(r)) continue;
    const c = move(r, "ended", now, `${skill} began`);
    if (c) changes.push(c);
  }
  const run = { id: `${now}-${state.runs.length}`, skill, worktree, session: session.id, state: "working", cause: "", signals: [signal], startedAt: now, updatedAt: now, endedAt: null, phases: {}, result: null };
  state.runs.push(run);
  if (state.runs.length > KEPT_RUNS) state.runs.splice(0, state.runs.length - KEPT_RUNS);
  changes.push(`${skill} in ${worktree}: began (${signal})`);
  return changes;
}

// The skill that a Skill tool call names, without a leading slash or a plugin's prefix.
const skillNamed = input => String(input?.skill ?? input?.name ?? input?.command ?? "").replace(/^\//, "").split(":").pop().trim();

// One line for each task in flight when a turn ended, for "why is this waiting".
const inFlight = p => [
  ...(p.background_tasks || []).map(t => `${t.type || "task"}: ${String(t.command || t.description || t.name || t.tool || "").slice(0, 120)}`),
  ...(p.session_crons || []).map(c => `scheduled wake-up: ${String(c.prompt || c.description || c.schedule || "").slice(0, 120)}`),
];

/**
 * Applies one Claude Code hook payload. `worktree` is the worktree that the payload's `cwd` is in
 * (the service works that out), `pid` the session's process id when the SessionStart command hook
 * sent one. Returns what changed, as lines for the event log.
 */
export function applyHook(state, p, { worktree = null, pid = null, now = Date.now() } = {}) {
  const id = p.session_id;
  if (!id) return [];
  const changes = [];
  const s = state.sessions[id] ??= { id, cwd: p.cwd || "", worktree, startedAt: now, turn: "idle", promptAt: 0, background: [], asking: null, endedAt: null, pid: null };
  s.seenAt = now;
  if (worktree) s.worktree = worktree;
  if (p.cwd) s.cwd = p.cwd;
  if (p.transcript_path) s.transcript = p.transcript_path;
  if (pid) s.pid = pid;
  const mine = () => state.runs.filter(r => r.session === id && isOpen(r));
  const each = (to, cause) => { for (const r of mine()) { const c = move(r, to, now, cause); if (c) changes.push(c); } };

  switch (p.hook_event_name) {
    case "SessionStart":
      s.endedAt = null;
      if (s.turn === "ended") s.turn = "idle";
      break;
    case "UserPromptSubmit":
      s.turn = "working"; s.promptAt = now; s.promptId = p.prompt_id || ""; s.background = []; s.asking = null; s.endedAt = null;
      each("working", "");
      if (String(p.prompt || "").startsWith(COMMENTS_PROMPT_START)) changes.push(...begin(state, s, "process-pr-comments", "the dashboard's prompt", now));
      break;
    case "UserPromptExpansion":
      if (SKILLS.includes(p.command_name)) changes.push(...begin(state, s, p.command_name, "typed /" + p.command_name, now));
      break;
    case "PreToolUse":
      if (p.tool_name === "Skill" && SKILLS.includes(skillNamed(p.tool_input))) changes.push(...begin(state, s, skillNamed(p.tool_input), "the model called the skill", now));
      if (s.turn !== "working") { s.turn = "working"; s.promptAt ||= now; }
      break;
    case "Stop": {
      const flying = inFlight(p);
      s.turn = flying.length ? "background" : "idle";
      s.background = flying;
      s.lastMessage = String(p.last_assistant_message || "").slice(0, 600);
      s.asking = null;
      for (const r of mine()) {
        const c = flying.length ? move(r, "waiting", now, flying.join("; "))
          : r.skill === "preflight" ? move(r, "paused", now, "the turn ended before preflight recorded its end")
          : move(r, "finished", now, "");
        if (c) changes.push(c);
      }
      break;
    }
    case "StopFailure":
      s.turn = "failed";
      each("paused", "the API failed: " + String(p.error_type || p.error || p.reason || "unknown").slice(0, 80));
      break;
    case "Notification":
      if (["permission_prompt", "agent_needs_input", "elicitation_dialog"].includes(p.notification_type)) s.asking = { type: p.notification_type, message: String(p.message || "").slice(0, 300), at: now };
      break;
    case "SessionEnd":
      s.endedAt = now; s.turn = "ended"; s.asking = null;
      each("ended", "the session ended" + (p.reason ? ` (${p.reason})` : ""));
      break;
  }
  return changes;
}

/**
 * Applies a preflight progress record (the file that progress.mjs writes for a worktree):
 * { worktree, session?, startedAt, updatedAt, steps, endedAt?, head?, tree? }. The first record of
 * a run opens it when no hook did. `end` finishes a run that is still open; a run whose session
 * has gone stays ended, since nothing shows that the work it left was completed.
 */
export function applyProgress(state, file, { now = Date.now() } = {}) {
  if (!file?.worktree || !file.startedAt) return [];
  const changes = [];
  const worktree = file.worktree;
  let run = state.runs.findLast(r => r.worktree === worktree && r.skill === "preflight" && r.record === file.startedAt);
  // A record that is the first news of its run (one from before the service started) may arrive
  // already ended.
  let created = false;
  if (!run) {
    const started = Date.parse(file.startedAt) || now;
    // The hooks opened it a moment before the skill's first record.
    run = state.runs.findLast(r => r.worktree === worktree && r.skill === "preflight" && isOpen(r) && !r.record && r.startedAt <= started + 60_000);
    if (!run) {
      const live = sessionsIn(state, worktree);
      const session = live.find(s => s.id === file.session) ?? live.find(s => s.turn === "working") ?? null;
      run = { id: `${started}-r${state.runs.length}`, skill: "preflight", worktree, session: session?.id ?? file.session ?? null, state: "working", cause: "", signals: ["its progress record"], startedAt: started, updatedAt: now, endedAt: null, phases: {}, result: null };
      state.runs.push(run);
      created = true;
      changes.push(`preflight in ${worktree}: began (its progress record)`);
      if (!file.endedAt && !session) { const c = move(run, "paused", now, "no session is running it"); if (c) changes.push(c); }
    }
    run.record = file.startedAt;
  }
  if (JSON.stringify(run.phases) !== JSON.stringify(file.steps || {})) { run.phases = file.steps || {}; run.updatedAt = now; changes.push(`preflight in ${worktree}: phases updated`); }
  if (file.endedAt && run.state !== "finished" && (isOpen(run) || created)) {
    run.result = { head: file.head || null, tree: file.tree || null, endedAt: file.endedAt };
    run.endedAt = Date.parse(file.endedAt) || now;
    const c = move(run, "finished", now, "");
    if (c) changes.push(c);
  }
  return changes;
}

/** Orca reported that the main agent in a worktree was interrupted: its working runs pause. */
export function applyInterrupt(state, worktree, { now = Date.now() } = {}) {
  const changes = [];
  for (const s of sessionsIn(state, worktree)) if (s.turn === "working") s.turn = "interrupted";
  for (const r of state.runs) {
    if (r.worktree !== worktree || r.state !== "working") continue;
    const c = move(r, "paused", now, "you interrupted it");
    if (c) changes.push(c);
  }
  return changes;
}

/**
 * Ends the sessions whose process is gone, and their open runs. `alive(pid)` says whether a
 * process exists. A session with no known process id (one that began before the hooks were
 * installed) is ended when Orca answers and shows no agent in its worktree: `agentWorktrees` is
 * the set of worktrees with an agent, or null when Orca could not be asked.
 */
export function checkLiveness(state, alive, { agentWorktrees = null, now = Date.now() } = {}) {
  const changes = [];
  for (const s of Object.values(state.sessions)) {
    if (s.endedAt) continue;
    const gone = s.pid ? !alive(s.pid) : !!agentWorktrees && !!s.worktree && !agentWorktrees.has(s.worktree);
    if (!gone) continue;
    s.endedAt = now; s.turn = "ended";
    const cause = s.pid ? "the session's process is gone" : "Orca shows no session in the worktree";
    for (const r of state.runs) {
      if (r.session !== s.id || !isOpen(r)) continue;
      const c = move(r, "ended", now, cause);
      if (c) changes.push(c);
    }
  }
  // An open run that names no known session: one read from a progress record alone.
  if (agentWorktrees) {
    for (const r of state.runs) {
      if (!isOpen(r) || (r.session && state.sessions[r.session]) || agentWorktrees.has(r.worktree)) continue;
      const c = move(r, "ended", now, "Orca shows no session in the worktree");
      if (c) changes.push(c);
    }
  }
  return changes;
}

/** Forgets sessions that ended more than a day ago. */
export function prune(state, now = Date.now()) {
  for (const [id, s] of Object.entries(state.sessions)) if (s.endedAt && now - s.endedAt > 24 * 3600e3) delete state.sessions[id];
}
