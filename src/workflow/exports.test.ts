/**
 * Workflow.core-additions-general — Core Additions Are General
 *
 * App.ask, fanout, and ctx.note/AnnotationEvent live in the ADK core and are usable outside
 * workflows. Only the optional file loader may be a separate subpath. ./eval does not import a
 * harness. Importing the core does not pull a provider or harness.
 *
 * Evidence: import-graph/build + unit (non-workflow usage)
 */
import { describe, it, expect } from 'vitest'

import { fanout } from '../agents/fanout'
import { adk } from '../api/app'
import { isAnnotationEvent } from '../types/events'

describe('workflow.core-additions-general', () => {
  it('fanout is usable in a plain async function (no app or workflow required)', async () => {
    // fanout is general — not workflow-specific
    const results = await fanout([async () => 1, async () => 2, async () => 3], { limit: 2 })
    expect(results).toEqual([1, 2, 3])
  })

  it('app.ask is on AdkApp (no workflow factory needed)', () => {
    const app = adk()
    expect(typeof app.ask).toBe('function')
  })

  it('isAnnotationEvent and AnnotationEvent are in the core (not in workflow subpath)', async () => {
    const core = await import('../index')
    expect(typeof core.isAnnotationEvent).toBe('function')
    // fanout is exported from core
    expect(typeof core.fanout).toBe('function')
    // AskOpts type is exported (checked at build time; here we just check the module loads)
    expect(core).toBeDefined()
  })

  it('ctx.note works in a non-workflow app.step', async () => {
    const app = adk()

    const step = app.step({
      name: 'non-workflow-step',
      execute: async (ctx) => {
        ctx.note('not a workflow', { kind: 'mark' })
        ctx.note('just a step')
      },
    })

    const result = await app.run(step, 'go')
    const annotations = result.session.events.filter(isAnnotationEvent)

    expect(annotations.length).toBe(2)
    expect(annotations[0].kind).toBe('mark')
    expect(annotations[1].kind).toBe('log')
  })

  it('core export surface does NOT include runWorkflowFile or TierModelMap', async () => {
    const core = await import('../index')
    expect((core as any).runWorkflowFile).toBeUndefined()
    expect((core as any).TierModelMap).toBeUndefined()
    expect((core as any).NodeRunner).toBeUndefined()
  })
})
