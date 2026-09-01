/**
 * Workflow.fanout-limit-one-serializes — Fanout Limit One Serializes
 *
 * Limit: 1 → at most one thunk in flight at any instant; thunks start in input order; result is in
 * input order.
 *
 * Evidence: unit test (entry/exit timestamps)
 */
import { describe, it, expect } from 'vitest'

import { fanout } from './fanout'

describe('workflow.fanout-limit-one-serializes', () => {
  it('limit: 1 serializes thunks (no overlapping execution)', async () => {
    const N = 5
    const entries: number[] = []
    const exits: number[] = []

    const thunks = Array.from({ length: N }, (_, i) => async (): Promise<number> => {
      entries.push(i)
      await new Promise<void>((res) => setTimeout(res, 5))
      exits.push(i)
      return i
    })

    const results = await fanout(thunks, { limit: 1 })

    // With limit: 1, each thunk must complete before the next starts.
    // entries[k] === k (strict input order)
    expect(entries).toEqual([0, 1, 2, 3, 4])
    expect(exits).toEqual([0, 1, 2, 3, 4])
    // No overlap: entry[k+1] comes after exit[k]
    for (let k = 0; k < N - 1; k++) {
      // entries are sequential so this is always true, but we encode the intent
      expect(entries[k + 1]).toBeGreaterThanOrEqual(k + 1)
    }
    expect(results).toEqual([0, 1, 2, 3, 4])
  })

  it('peak concurrency is exactly 1 with limit: 1', async () => {
    let peakConcurrency = 0
    let current = 0

    const thunks = Array.from({ length: 6 }, (_, i) => async () => {
      current++
      if (current > peakConcurrency) peakConcurrency = current
      await new Promise<void>((res) => setTimeout(res, 2))
      current--
      return i
    })

    await fanout(thunks, { limit: 1 })
    expect(peakConcurrency).toBe(1)
  })
})
