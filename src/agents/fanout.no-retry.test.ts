/**
 * Workflow.fanout-no-helper-retry — Fanout Does Not Retry Failed Thunks
 *
 * A failing thunk is invoked exactly ONCE. fanout itself performs no retry.
 *
 * Evidence: unit test (invocation count)
 */
import { describe, it, expect } from 'vitest'

import { fanout } from './fanout'

describe('workflow.fanout-no-helper-retry', () => {
  it('failing thunk is invoked exactly once', async () => {
    let failCallCount = 0
    const successCounts = [0, 0, 0]

    const thunks = [
      async () => {
        successCounts[0]++
        return 0
      },
      async () => {
        failCallCount++
        throw new Error('provider error')
      },
      async () => {
        successCounts[1]++
        return 2
      },
      async () => {
        successCounts[2]++
        return 3
      },
    ]

    const results = await fanout(thunks, { limit: 2 })

    expect(failCallCount).toBe(1)
    expect(results[1]).toBeNull()
    // Success thunks also invoked exactly once
    expect(successCounts[0]).toBe(1)
    expect(successCounts[1]).toBe(1)
    expect(successCounts[2]).toBe(1)
  })
})
