/**
 * Workflow.annotation-kinds-and-wrappers — Annotation Default Kind, Mark Kind, And Wrapper Identity
 *
 * - Ctx.note('msg') → kind === 'log' (default, not undefined)
 * - Ctx.note('msg', { kind: 'mark' }) → kind === 'mark' (first-class, not coerced)
 * - Phase('Build') is field-for-field identical to note('Build', { kind: 'phase' })
 * - Log('done') is field-for-field identical to note('done') (default log)
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import type { AnnotationEvent } from './events'

import { phase as wrapPhase, log as wrapLog } from '../agents/annotations'
import { adk } from '../api/app'

describe('workflow.annotation-kinds-and-wrappers', () => {
  it('ctx.note with no opts defaults to kind "log"', async () => {
    const app = adk()

    const wf = app.step({
      name: 'default-kind',
      execute: async (ctx) => {
        ctx.note('working')
      },
    })

    const result = await app.run(wf, 'go')
    const annotations = result.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    expect(annotations).toHaveLength(1)
    expect(annotations[0].kind).toBe('log') // MUST be 'log', not undefined
  })

  it('ctx.note with kind "mark" emits kind "mark"', async () => {
    const app = adk()

    const wf = app.step({
      name: 'mark-kind',
      execute: async (ctx) => {
        ctx.note('checkpoint', { kind: 'mark' })
      },
    })

    const result = await app.run(wf, 'go')
    const annotations = result.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    expect(annotations).toHaveLength(1)
    expect(annotations[0].kind).toBe('mark')
  })

  it('all three kinds are emittable: phase, log, mark', async () => {
    const app = adk()

    const wf = app.step({
      name: 'all-kinds',
      execute: async (ctx) => {
        ctx.note('a', { kind: 'phase' })
        ctx.note('b') // default log
        ctx.note('c', { kind: 'mark' })
      },
    })

    const result = await app.run(wf, 'go')
    const kinds = result.session.events
      .filter((e) => e.type === 'annotation')
      .map((e) => (e as AnnotationEvent).kind)

    expect(kinds).toContain('phase')
    expect(kinds).toContain('log')
    expect(kinds).toContain('mark')
  })

  it('wrapper identity: phase(ctx, title) is field-for-field equal to note(title, { kind: "phase" })', async () => {
    const app = adk()

    // Run with the wrapper
    const wfWrapper = app.step({
      name: 'wrapper-phase',
      execute: async (ctx) => {
        wrapPhase(ctx, 'Build')
      },
    })
    const wrapperResult = await app.run(wfWrapper, 'go')
    const wrapperEvents = wrapperResult.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    // Run with explicit ctx.note control
    const wfControl = app.step({
      name: 'control-phase',
      execute: async (ctx) => {
        ctx.note('Build', { kind: 'phase' })
      },
    })
    const controlResult = await app.run(wfControl, 'go')
    const controlEvents = controlResult.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    expect(wrapperEvents).toHaveLength(1)
    expect(controlEvents).toHaveLength(1)

    // Field-by-field equality on the four scenario-pinned fields (kind, label, message, data)
    // id/createdAt/invocationId are ledger-assigned and will differ between runs — excluded per spec
    expect(wrapperEvents[0].kind).toBe(controlEvents[0].kind)
    expect(wrapperEvents[0].label).toBe(controlEvents[0].label)
    expect(wrapperEvents[0].message).toBe(controlEvents[0].message)
    expect(wrapperEvents[0].data).toEqual(controlEvents[0].data)

    // Pinned values
    expect(wrapperEvents[0].kind).toBe('phase')
    expect(wrapperEvents[0].message).toBe('Build')
  })

  it('wrapper identity: log(ctx, msg) is field-for-field equal to note(msg) (default log)', async () => {
    const app = adk()

    // Run with the wrapper
    const wfWrapper = app.step({
      name: 'wrapper-log',
      execute: async (ctx) => {
        wrapLog(ctx, 'done')
      },
    })
    const wrapperResult = await app.run(wfWrapper, 'go')
    const wrapperEvents = wrapperResult.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    // Run with explicit ctx.note control (default kind = log)
    const wfControl = app.step({
      name: 'control-log',
      execute: async (ctx) => {
        ctx.note('done')
      },
    })
    const controlResult = await app.run(wfControl, 'go')
    const controlEvents = controlResult.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    expect(wrapperEvents).toHaveLength(1)
    expect(controlEvents).toHaveLength(1)

    // Field-by-field equality on kind, label, message, data
    expect(wrapperEvents[0].kind).toBe(controlEvents[0].kind)
    expect(wrapperEvents[0].label).toBe(controlEvents[0].label)
    expect(wrapperEvents[0].message).toBe(controlEvents[0].message)
    expect(wrapperEvents[0].data).toEqual(controlEvents[0].data)

    // Pinned values
    expect(wrapperEvents[0].kind).toBe('log')
    expect(wrapperEvents[0].message).toBe('done')
  })
})
