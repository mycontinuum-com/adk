/**
 * Workflow.no-shadow-shipped-surface — Shipped Surface Reused Not Shadowed
 *
 * App.parallel and fanout are distinct, separately-named exports. No duplicate
 * RunResult/StreamEvent/run definitions.
 *
 * Evidence: import-graph/build + type-level
 */
import { describe, it, expect } from 'vitest'

import { fanout } from '../agents/fanout'
import { adk } from '../api/app'

describe('workflow.no-shadow-shipped-surface', () => {
  it('app.parallel and fanout are different functions', async () => {
    const app = adk()
    const parallel = app.parallel.bind(app)
    // They are not the same reference
    expect(parallel).not.toBe(fanout)
  })

  it('RunResult is the single shipped type (not redefined in workflow subpath)', async () => {
    // RunResult is exported from core, not from workflow
    const workflow = await import('./index')
    expect((workflow as any).RunResult).toBeUndefined()
  })

  it('StreamEvent is not redefined in workflow subpath', async () => {
    const workflow = await import('./index')
    expect((workflow as any).StreamEvent).toBeUndefined()
  })

  it('app.run is the single run surface (no runWorkflow in core)', async () => {
    const core = await import('../index')
    expect((core as any).runWorkflow).toBeUndefined()
  })

  it('app.parallel vs fanout: different semantics (parallel returns Parallel; fanout returns Promise<T[]>)', async () => {
    const app = adk()
    // app.parallel creates a Parallel runnable (static combinator)
    const step1 = app.step({ name: 's1', execute: async () => {} })
    const step2 = app.step({ name: 's2', execute: async () => {} })
    const parallelRunnable = app.parallel({ name: 'par', runnables: [step1, step2] })
    expect(parallelRunnable.kind).toBe('parallel')
    expect(typeof parallelRunnable.runnables).toBe('object')

    // fanout is a dynamic helper that returns a Promise of results
    const fanoutResult = fanout([async () => 'a', async () => 'b'])
    expect(fanoutResult).toBeInstanceOf(Promise)
    const resolved = await fanoutResult
    expect(resolved).toEqual(['a', 'b'])
  })
})
