/**
 * Index.hooks-surface — Built-in hooks are usable from the Core barrel
 *
 * The hook implementations (composeHooks, loggingHook, metricsHook, cliHook) live in src/hook/*,
 * but the Core entry previously re-exported only their option _types_ — a consumer importing from
 * `@animahealth/adk` had no way to construct a built-in hook at all. This asserts each
 * implementation is exported from './index' and produces a working Hook.
 *
 * Evidence: import-graph/build
 */
import { describe, expect, it } from 'vitest'

import * as core from './index'

describe('index hooks surface', () => {
  it('exports composeHooks as a callable that composes an empty Hook', () => {
    expect(typeof core.composeHooks).toBe('function')
    expect(core.composeHooks([])).toEqual({})
  })

  it('exports loggingHook as a callable that builds a named Hook', () => {
    expect(typeof core.loggingHook).toBe('function')
    const hook = core.loggingHook()
    expect(hook.name).toBe('logging')
    expect(typeof hook.beforeAgent).toBe('function')
    expect(typeof hook.afterAgent).toBe('function')
  })

  it('exports metricsHook as a callable that builds a named Hook', () => {
    expect(typeof core.metricsHook).toBe('function')
    const hook = core.metricsHook({})
    expect(hook.name).toBe('metrics')
    expect(typeof hook.onEvent).toBe('function')
  })

  it('exports cliHook as a callable that builds a named Hook', () => {
    expect(typeof core.cliHook).toBe('function')
    const hook = core.cliHook()
    expect(hook.name).toBe('cli')
    expect(typeof hook.onEvent).toBe('function')
  })

  it('composeHooks combines built-in hooks into one usable Hook', async () => {
    const seen: string[] = []
    const composed = core.composeHooks([
      core.loggingHook({ onLog: (level, msg) => seen.push(`${level}:${msg}`) }),
      core.metricsHook({ onToolCall: (name) => seen.push(`tool:${name}`) }),
    ])

    await composed.beforeAgent?.({ runnable: { name: 'test' } } as any)
    expect(seen).toContain('info:Agent starting: test')
  })
})
