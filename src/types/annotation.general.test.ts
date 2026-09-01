/**
 * Workflow.annotation-general-non-workflow — Annotation Usable Outside A Workflow
 *
 * Ctx.note is on the ordinary StepContext/OrchestrationContext — not workflow-specific. Calling it
 * from a plain app.step (not a loader workflow) emits the same AnnotationEvent.
 *
 * Evidence: unit + import-graph
 */
import { describe, it, expect } from 'vitest'

import type { StepContext } from './runnables'

import { adk } from '../api/app'
import { isAnnotationEvent } from './events'

describe('workflow.annotation-general-non-workflow', () => {
  it('ctx.note is callable from a plain app.step (not a loader workflow)', async () => {
    const app = adk()

    // This is a plain step — NOT run through any file loader
    const step = app.step({
      name: 'plain-step',
      execute: async (ctx: StepContext) => {
        ctx.note('hello', { kind: 'mark' })
      },
    })

    const result = await app.run(step, 'go')
    const annotations = result.session.events.filter(isAnnotationEvent)

    expect(annotations).toHaveLength(1)
    expect(annotations[0].kind).toBe('mark')
    expect(annotations[0].message).toBe('hello')
  })

  it('AnnotationEvent + ctx.note resolve from the ADK core (import-graph check)', async () => {
    // Import from the core index — NOT from a workflow subpath
    const core = await import('../index')
    expect(typeof core.isAnnotationEvent).toBe('function')
    expect(typeof core.adk).toBe('function')

    // The workflow subpath should NOT re-export isAnnotationEvent or ctx.note
    // (they come from the core). This test asserts the import graph direction.
    const workflow = await import('../workflow/index')
    expect((workflow as any).isAnnotationEvent).toBeUndefined()
    expect((workflow as any).note).toBeUndefined()
  })
})
