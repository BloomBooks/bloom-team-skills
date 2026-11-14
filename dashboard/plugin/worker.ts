// The Bloom plugin's worker: the link between Orca and the dashboard service on this machine
// (../service/service.mjs). It holds no rule about cards or rows.
//
// - Orca's events (an agent's status changed, a worktree came or went) go to the service, which
//   then reads Orca once for the detail. Without this the service would have to ask Orca every
//   few seconds.
// - The service's state comes back on a request that the service answers when the state changes.
//   Each change is announced to the open panels, which then ask for their own worktree, and the
//   status bar button shows how many cards wait for the developer.
// - The panel's requests ("worktree.state", "action") are passed to the service, since a panel
//   cannot reach the network. What only Orca knows about the focused worktree (its Claude
//   sessions, the selected pane, the transcript's last prompts) is read here, in panel-facts.mjs.
// - The status bar button asks the service to show the dashboard window.
// - A service that does not answer is started (../service/start.mjs); nothing else starts one.
//   Each request for the state names Orca's process (this worker's parent), and the service exits
//   once that process is gone.
//
// The status bar item makes Orca start this worker when the plugin is enabled and keep it running.
// Orca transpiles this file when it loads: no build step. worker-env.mjs comes first: it gives the
// worker the environment that the `orca` CLI needs.
import type { OrcaWorkerApi } from 'orca/worker'
import './worker-env.mjs'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { panelFacts } from './panel-facts.mjs'

const SERVICE = `http://127.0.0.1:${Number(process.env.BLOOM_DASHBOARD_PORT || 47600)}`
const here = dirname(fileURLToPath(import.meta.url))
const LABEL = 'Bloom Dashboard'
// A panel that asked within this long counts as open, which keeps the service polling.
const PANEL_FRESH_MS = 40_000

const key = () => readFileSync(join(homedir(), '.claude', 'bloom-dashboard', 'service.key'), 'utf8').trim()
async function service(path: string, body?: unknown, timeoutMs = 10_000): Promise<any> {
  const r = await fetch(SERVICE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-bloom-key': key() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!r.ok) throw new Error('the dashboard service answered ' + r.status)
  return r.json()
}

export default function activate(orca: OrcaWorkerApi): void {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let panelAskedAt = 0
  const panelOpen = () => Date.now() - panelAskedAt < PANEL_FRESH_MS

  let startedAt = 0
  function startService(): void {
    if (Date.now() - startedAt < 30_000) return
    startedAt = Date.now()
    spawn('node', [join(here, '..', 'service', 'start.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    orca.log('the dashboard service did not answer, so it was started')
  }

  // Orca's events, passed on. The service only needs to know that something changed.
  for (const event of ['agent.status.changed', 'workspace.created', 'workspace.removed'] as const) {
    orca.events.on(event, (payload) => {
      service('/orca', { event, payload, panelOpen: panelOpen() }).catch(() => {})
    })
  }

  // The service's state, asked for again as soon as each answer arrives; the service holds the
  // request until its state changes (or 25 s pass).
  let version = -1
  let failures = 0
  async function follow(): Promise<void> {
    for (;;) {
      try {
        const state = await service(`/state?since=${version}&orca=${process.ppid}${panelOpen() ? '&panel=1' : ''}`, undefined, 40_000)
        failures = 0
        if (state.version === version) continue
        version = state.version
        const waiting = state.deciders.length + [...state.rows, ...state.inReview].filter((r: any) => r.badge).length
        const branch = state.service.code.branch
        // The branch shows when the service runs code from somewhere other than the main branch.
        const from = branch && !['main', 'master'].includes(branch) ? ` [${branch}]` : ''
        orca.host.call('statusBar.update', { id: 'dashboard', text: LABEL + from + (waiting ? ` · ${waiting} waiting for you` : ''), tone: waiting ? 'warning' : 'neutral' }).catch(() => {})
        orca.panels.post('state', { version })
      } catch {
        if (++failures >= 3) { startService(); orca.host.call('statusBar.update', { id: 'dashboard', text: LABEL + ' (starting)' }).catch(() => {}) }
        await sleep(3000)
      }
    }
  }
  void follow()

  orca.commands.register('dashboard.show', async () => {
    try {
      await service('/tell', { kind: 'show' })
      return 'Showing the dashboard.'
    } catch {
      startedAt = 0
      startService()
      for (let i = 0; i < 40; i++) {
        await sleep(500)
        try { await service('/tell', { kind: 'show' }); return 'Started the dashboard.' } catch {}
      }
      throw new Error('the dashboard service did not start; see ~/.claude/bloom-dashboard/service.log')
    }
  })

  // The panel's state: what Orca knows about the focused worktree, then the service's row for it.
  orca.panels.handle('worktree.state', async (input: any) => {
    panelAskedAt = Date.now()
    const facts = await panelFacts(input)
    if (!facts.found) return facts
    try {
      const fromService = await service('/worktree?panel=1&path=' + encodeURIComponent(facts.path))
      return { ...facts, ...fromService, connected: true }
    } catch (e) {
      return { ...facts, row: null, git: null, connected: false, serviceError: e instanceof Error ? e.message : String(e) }
    }
  })

  // The panel's buttons: the same actions as the dashboard page's, on the session the panel shows.
  orca.panels.handle('action', async (input: any) => {
    const answer = await service('/action', input, 90_000)
    orca.log(`action ${JSON.stringify(input)}: ${answer.ok ? answer.message || 'done' : answer.error}`)
    if (!answer.ok) throw new Error(answer.error || 'the dashboard service refused')
    return answer
  })
}
