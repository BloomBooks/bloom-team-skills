// The Worktree panel's worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. The work is in worktree-facts.mjs, which also runs on
// its own under Node. worker-env.mjs comes first: it fixes the environment that Orca gives the
// worker before anything runs a command.
import type { OrcaWorkerApi } from 'orca/worker'
import './worker-env.mjs'
import { openInVsCode, openSession, runSkill, sendPrompt, worktreeState } from './worktree-facts.mjs'

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('worktree.state', async (input: any) => worktreeState(input))

  // The panel's buttons. Each answers { message } or throws, and writes what it did to the log.
  const action = (name: string, fn: (input: any) => Promise<string>) =>
    orca.panels.handle(name, async (input: any) => {
      try {
        const message = await fn(input)
        orca.log(`${name} ${JSON.stringify(input)}: ${message}`)
        return { message }
      } catch (e) {
        orca.log(`${name} ${JSON.stringify(input)} failed: ${e instanceof Error ? e.message : e}`)
        throw e
      }
    })
  action('worktree.runSkill', runSkill)
  action('worktree.open', openSession)
  action('worktree.vscode', openInVsCode)
  action('worktree.prompt', sendPrompt)
}
