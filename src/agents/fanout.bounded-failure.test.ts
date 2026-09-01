/**
 * Workflow.fanout-bounded-and-failure — Fanout Bounded And Failure Isolated
 *
 * No more than `limit` thunks concurrently; results in input order; failed thunk → null, call never
 * rejects.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { fanout } from './fanout'

describe('workflow.fanout-bounded-and-failure', () => {
  it('never exceeds limit; failed thunk → null; result length = N', async () => {
    const N = 10
    const LIMIT = 3
    let peakConcurrency = 0
    let current = 0

    const thunks = Array.from({ length: N }, (_, i) => async (): Promise<number> => {
      current++
      if (current > peakConcurrency) peakConcurrency = current
      await new Promise<void>((res) => setTimeout(res, 5))
      current--
      if (i === 4) throw new Error('simulated failure')
      return i
    })

    const results = await fanout(thunks, { limit: LIMIT })

    expect(peakConcurrency).toBeLessThanOrEqual(LIMIT)
    expect(results).toHaveLength(N)
    expect(results[4]).toBeNull()
    for (let i = 0; i < N; i++) {
      if (i !== 4) expect(results[i]).toBe(i)
    }
  })

  it('call does not reject even when a thunk fails', async () => {
    const thunks = [
      async () => {
        throw new Error('boom')
      },
      async () => 1,
    ]
    await expect(fanout(thunks, { limit: 1 })).resolves.toBeDefined()
  })
})
