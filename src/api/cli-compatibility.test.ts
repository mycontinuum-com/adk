import { describe, expect, it } from 'vitest'

import { adk, cliHook, consoleHook, type CliHookOptions } from '../index'
import { cli, terminal } from '../terminal'

describe('0.6.0 CLI compatibility', () => {
  it('retains the terminal function aliases', async () => {
    const app = adk()
    expect(app.cli).toBe(app.terminal)
    expect(cli).toBe(terminal)
    await app.close()
  })

  it('retains the console hook factory and options', async () => {
    const app = adk()
    const options: CliHookOptions = { showThoughts: false }
    expect(cliHook).toBe(consoleHook)
    expect(Object.keys(app.hook.cli(options))).toEqual(Object.keys(app.hook.console(options)))
    await app.close()
  })
})
