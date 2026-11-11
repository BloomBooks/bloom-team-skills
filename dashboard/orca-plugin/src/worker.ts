// The status bar's Bloom Dashboard button, and the end of the session it starts.
//
// A press:
// - the dashboard server answers: ask it to bring its window to the front;
// - the session this button started is under STARTING_MS old: nothing more;
// - otherwise: open a background terminal in the bloom-team-skills checkout running Claude on "Open the
//   dashboard", and start the dashboard server at once, so the window opens within a second or two
//   with the rows from the last session. The session's own server takes the port over when the
//   session gets to it, and the window reloads onto that one.
// The button reads STARTING until a dashboard page is showing.
//
// Closing the window stops the server. Once the server of the session this button started has
// been silent for QUIET_POLLS polls, the plugin types /exit into that session, and Enter to
// confirm stopping its background tasks, so a session that was there only for the dashboard goes
// too; its terminal command then exits the shell. A takeover
// leaves the port silent for about a second, well under that.
//
// The session's prompt has no leading slash: a Git Bash terminal rewrites an argument that starts
// with "/" into a Windows path. Orca's agent.launch starts Claude but has not been typing its
// prompt in, so the prompt goes on Claude's command line.
//
// A server that was killed (Claude Code ends background commands when memory runs short) leaves
// running.json behind with a dead pid, where a stop of its own removes it. The plugin then starts
// another with --revive, and a window still open on the killed one reloads onto it.
// Orca transpiles this file when it loads: no build step.
import type { OrcaWorkerApi } from 'orca/worker'
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVER = 'http://127.0.0.1:47321'
// The main checkout, not the .claude/worktrees/agent-… checkouts that Orca also lists.
const CHECKOUT = /[\\/]bloom-team-skills$/i
// A session younger than this is still starting: Claude loading, then the gather before its server.
const STARTING_MS = 90_000
const POLL_MS = 5_000
const QUIET_POLLS = 2
const LABEL = 'Bloom Dashboard'
const STARTING = 'Loading...'
// The session this button started, kept across worker restarts.
const SESSION_KEY = 'session'
type Session = { terminalId: string; startedAt: number }
type Health = { dashboard: true; pid: number; page?: boolean }
const RUNNING_FILE = join(homedir(), '.claude', 'bloom-dashboard', 'running.json')
// The server rewrites running.json every 5 s; one older than this is from before a restart.
const RUNNING_FRESH_MS = 60_000
// At most this many revives in REVIVE_WINDOW_MS, so a server that dies at start is not restarted forever.
const MAX_REVIVES = 3
const REVIVE_WINDOW_MS = 10 * 60_000

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// True when the last server was running within RUNNING_FRESH_MS and its process is gone without
// stopping on its own.
function serverWasKilled(): boolean {
  try {
    if (Date.now() - statSync(RUNNING_FILE).mtimeMs > RUNNING_FRESH_MS) return false
    const { pid } = JSON.parse(readFileSync(RUNNING_FILE, 'utf8'))
    return typeof pid === 'number' && !isAlive(pid)
  } catch {
    return false
  }
}

async function health(): Promise<Health | null> {
  try {
    const r = await fetch(SERVER + '/api/health', { signal: AbortSignal.timeout(1500) })
    const h = r.ok ? await r.json() : null
    return h?.dashboard === true ? h : null
  } catch {
    return null
  }
}

// The server checks the key that its own handover uses, which only local programs can read.
async function askServerToShowWindow(): Promise<void> {
  const key = readFileSync(join(homedir(), '.claude', 'bloom-dashboard', 'handover.key'), 'utf8').trim()
  const r = await fetch(SERVER + '/api/show', { method: 'POST', headers: { 'x-handover-key': key }, signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error('the dashboard server answered ' + r.status)
}

// Starts dashboard/server.mjs of the checkout on its own, detached from Orca. The worker's
// environment leaves out the user's folders, which Chrome and the gather need.
function startServerNow(checkoutPath: string, args: string[] = []): void {
  const home = homedir()
  const env = {
    ...process.env,
    USERPROFILE: process.env.USERPROFILE || home,
    APPDATA: process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
    ProgramFiles: process.env.ProgramFiles || 'C:/Program Files'
  }
  spawn('node', [join(checkoutPath, 'dashboard', 'server.mjs'), ...args], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
}

export default function activate(orca: OrcaWorkerApi): void {
  const label = (text: string) => orca.host.call('statusBar.update', { id: 'dashboard', text }).catch(() => {})
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Shows STARTING on the button until a dashboard page is showing, or STARTING_MS has passed.
  let loading = false
  async function showLoadingUntilPage(): Promise<void> {
    if (loading) return
    loading = true
    await label(STARTING)
    const until = Date.now() + STARTING_MS
    while (Date.now() < until && !(await health())?.page) await sleep(1000)
    await label(LABEL)
    loading = false
  }

  // Types /exit into the session this button started and forgets it.
  async function endSession(session: Session, why: string): Promise<void> {
    await orca.storage.set(SESSION_KEY, null)
    try {
      await orca.host.call('terminal.sendText', { terminalId: session.terminalId, text: '/exit', enter: true })
      // With background tasks still running (the session's event Monitor), /exit asks whether to
      // stop them; Enter takes its first choice, "Exit and stop tasks". Without the question, the
      // Enter lands on a closed terminal or an empty shell prompt.
      await sleep(2500)
      await orca.host.call('terminal.sendText', { terminalId: session.terminalId, text: '\r', enter: false }).catch(() => {})
      orca.log(`ended the dashboard session ${session.terminalId}: ${why}`)
    } catch (e) {
      orca.log(`the dashboard session ${session.terminalId} was already gone (${e instanceof Error ? e.message : e})`)
    }
  }

  // Ends the session once its server has answered and then gone silent for QUIET_POLLS polls.
  let watching = false
  async function watchSession(): Promise<void> {
    if (watching) return
    watching = true
    let seen = false
    let quiet = 0
    for (;;) {
      const session = (await orca.storage.get(SESSION_KEY)) as Session | null
      if (!session) break
      if (await health()) { seen = true; quiet = 0 }
      // A killed server is about to be revived, and the session still keeps its rows.
      else if (serverWasKilled()) quiet = 0
      else if (seen && ++quiet >= QUIET_POLLS) { await endSession(session, 'its dashboard server stopped'); break }
      else if (!seen && Date.now() - session.startedAt > STARTING_MS) { await endSession(session, 'its dashboard server never started'); break }
      await sleep(POLL_MS)
    }
    watching = false
  }

  async function press(): Promise<string> {
    if (await health()) {
      await askServerToShowWindow()
      orca.log('asked the running dashboard server to show its window')
      void showLoadingUntilPage()
      return 'Showing the dashboard.'
    }

    const { workspaces } = await orca.host.call('workspace.list')
    const checkout = workspaces.find((w) => CHECKOUT.test(w.path.replace(/[\\/]+$/, '')))
    if (!checkout) {
      orca.log('no bloom-team-skills workspace among ' + workspaces.length)
      return 'Orca has no bloom-team-skills workspace. Add the bloom-team-skills checkout to Orca first.'
    }
    const session = (await orca.storage.get(SESSION_KEY)) as Session | null
    if (session && Date.now() - session.startedAt < STARTING_MS) {
      orca.log('the dashboard session is still starting: ' + session.terminalId)
      void showLoadingUntilPage()
      return 'The dashboard is still starting.'
    }
    if (session) await endSession(session, 'replaced by a new one')

    startServerNow(checkout.path)
    const { terminalId } = await orca.host.call('terminal.create', {
      workspaceId: checkout.id,
      title: LABEL,
      command: 'claude "Open the dashboard"; exit'
    })
    await orca.storage.set(SESSION_KEY, { terminalId, startedAt: Date.now() })
    orca.log(`started Claude on the dashboard in ${checkout.path} (${terminalId})`)
    void showLoadingUntilPage()
    void watchSession()
    return 'Starting the dashboard.'
  }

  async function checkoutPath(): Promise<string | null> {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces.find((w) => CHECKOUT.test(w.path.replace(/[\\/]+$/, '')))?.path ?? null
  }

  // Starts a server in place of one that was killed. Runs for as long as Orca does.
  const revives: number[] = []
  async function reviveKilledServers(): Promise<void> {
    for (;;) {
      await sleep(POLL_MS)
      try {
        if (pressing || !serverWasKilled() || (await health())) continue
        const now = Date.now()
        while (revives.length && now - revives[0] > REVIVE_WINDOW_MS) revives.shift()
        if (revives.length >= MAX_REVIVES) continue
        const path = await checkoutPath()
        if (!path) continue
        revives.push(now)
        // --keep-sessions: the session that wrote the rows is still open, and keeps them.
        startServerNow(path, ['--revive', '--keep-sessions'])
        orca.log('revived the dashboard server, which had been killed')
        await sleep(15_000) // time to start listening and rewrite running.json
      } catch (e) {
        orca.log('reviving the dashboard server: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
  }

  // A press while another press is still being handled waits for that one instead of starting again.
  let pressing: Promise<string> | null = null
  orca.commands.register('dashboard.start', async () => {
    if (pressing) return pressing
    pressing = press()
      .catch((e) => {
        orca.log('could not start the dashboard: ' + (e instanceof Error ? e.message : String(e)))
        throw e
      })
      .finally(() => { pressing = null })
    return pressing
  })

  // A worker restarted while a session is open picks up watching it.
  void watchSession()
  void reviveKilledServers()
}
