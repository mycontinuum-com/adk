/**
 * Workflow.fanout-null-at-failed-index — Fanout Places None At The Failed Thunk's Own Index
 *
 * Null marks the EXACT input position of the failed thunk, not appended at end or shifted. Results
 * are index-aligned.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { fanout } from './fanout'

describe('workflow.fanout-null-at-failed-index', () => {
  it('null appears at exactly the failing indices 1 and N-2, all others are success values', async () => {
    const N = 8
    const failIdx1 = 1
    const failIdx2 = N - 2 // = 6

    const thunks = Array.from({ length: N }, (_, i) => async (): Promise<number> => {
      await new Promise<void>((res) => setTimeout(res, Math.random() * 5))
      if (i === failIdx1 || i === failIdx2) throw new Error(`fail at ${i}`)
      return i
    })

    const results = await fanout(thunks, { limit: 4 })

    expect(results).toHaveLength(N)
    expect(results[failIdx1]).toBeNull()
    expect(results[failIdx2]).toBeNull()
    for (let i = 0; i < N; i++) {
      if (i !== failIdx1 && i !== failIdx2) {
        expect(results[i]).toBe(i)
      }
    }
  })

  it('call resolves (never rejects)', async () => {
    const N = 5
    const thunks = Array.from({ length: N }, (_, i) => async () => {
      if (i === 2) throw new Error('fail')
      return i
    })
    await expect(fanout(thunks, { limit: 2 })).resolves.toHaveLength(N)
  })
})
