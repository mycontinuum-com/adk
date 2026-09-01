/**
 * Workflow.annotation-events — Annotation Events
 *
 * Ctx.note(...) appends an AnnotationEvent (kind 'phase' or 'log') to the StreamEvent stream.
 * AnnotationEvent is the ONLY new event kind.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import type { AnnotationEvent } from './events'

import { adk } from '../api/app'

describe('workflow.annotation-events', () => {
  it('ctx.note(msg, { kind: "phase" }) appends an AnnotationEvent to session events', async () => {
    const app = adk()

    const wf = app.step({
      name: 'annotation-test',
      execute: async (ctx) => {
        ctx.note('Build phase', { kind: 'phase' })
        ctx.note('Starting work')
      },
    })

    const result = await app.run(wf, 'go')

    const emittedEvents = result.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    expect(emittedEvents).toHaveLength(2)
    expect(emittedEvents[0].kind).toBe('phase')
    expect(emittedEvents[0].message).toBe('Build phase')
    expect(emittedEvents[1].kind).toBe('log')
    expect(emittedEvents[1].message).toBe('Starting work')
  })

  it('AnnotationEvent appears in RunResult events with expected kinds', async () => {
    const app = adk()

    const wf = app.step({
      name: 'ann-result-test',
      execute: async (ctx) => {
        ctx.note('phase1', { kind: 'phase' })
        ctx.note('log1')
      },
    })

    const result = await app.run(wf, 'go')

    const annotations = result.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]
    expect(annotations.length).toBeGreaterThanOrEqual(2)
  })
})
