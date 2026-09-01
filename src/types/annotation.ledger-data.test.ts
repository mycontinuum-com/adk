/**
 * Workflow.annotation-ledger-and-data — Annotation Ledger-Stamps Provenance And Carries Structured
 * Data
 *
 * - Each AnnotationEvent carries a timestamp and invocationId stamped by the event ledger.
 * - Data map round-trips verbatim.
 * - Omitting data yields data absent/undefined.
 * - The opts type does NOT accept a caller timestamp/invocationId.
 *
 * Evidence: unit + type-level (opts surface)
 */
import { describe, it, expect } from 'vitest'

import type { NoteOpts } from '../types/runnables'
import type { AnnotationEvent } from './events'

import { adk } from '../api/app'

describe('workflow.annotation-ledger-and-data', () => {
  it('AnnotationEvent has a ledger-assigned timestamp (not 0)', async () => {
    const app = adk()

    const wf = app.step({
      name: 'ledger-ts',
      execute: async (ctx) => {
        ctx.note('marker')
      },
    })

    const before = Date.now()
    const result = await app.run(wf, 'go')
    const after = Date.now()

    const annotations = result.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    expect(annotations).toHaveLength(1)
    expect(annotations[0].createdAt).toBeGreaterThanOrEqual(before)
    expect(annotations[0].createdAt).toBeLessThanOrEqual(after)
    expect(annotations[0].invocationId).toBeTruthy()
  })

  it('data round-trips verbatim; omitting data yields undefined', async () => {
    const app = adk()

    const wf = app.step({
      name: 'data-test',
      execute: async (ctx) => {
        ctx.note('changed files', { kind: 'mark', data: { count: 3, files: ['a.ts', 'b.ts'] } })
        ctx.note('no data here')
      },
    })

    const result = await app.run(wf, 'go')
    const annotations = result.session.events.filter(
      (e) => e.type === 'annotation',
    ) as AnnotationEvent[]

    expect(annotations).toHaveLength(2)
    expect(annotations[0].data).toEqual({ count: 3, files: ['a.ts', 'b.ts'] })
    expect(annotations[1].data).toBeUndefined()
  })
})

// Type-level: NoteOpts must NOT accept a timestamp or invocationId
type NoteOptsKeys = keyof NoteOpts
// These must NOT be in NoteOpts — the ledger assigns them
type AssertNoTimestamp = 'createdAt' extends NoteOptsKeys ? 'BAD' : 'OK'
type AssertNoInvocationId = 'invocationId' extends NoteOptsKeys ? 'BAD' : 'OK'
const _assertNoTimestamp: AssertNoTimestamp = 'OK'
const _assertNoInvocationId: AssertNoInvocationId = 'OK'
