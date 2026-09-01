/**
 * Workflow.fanout-all-fail-resolves — Fanout All-Fail Still Resolves
 *
 * Case A: every thunk throws → [null, null, ...], call resolves (never rejects). Case B: subset
 * fails → null at failed positions, success elsewhere; call resolves.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { fanout } from './fanout'

describe('workflow.fanout-all-fail-resolves', () => {
  it('case A: all thunks fail → all-null array, call resolves not rejects', async () => {
    const N = 5
    const thunks = Array.from({ length: N }, () => async () => {
      throw new Error('always fails')
    })

    const result = await fanout(thunks, { limit: 2 })
    expect(result).toEqual(Array.from({ length: N }, () => null))
  })

  it('case B: some thunks fail → null at failed positions, success elsewhere', async () => {
    const thunks = [
      async () => 0,
      async () => {
        throw new Error('fail')
      },
      async () => 2,
      async () => {
        throw new Error('fail')
      },
      async () => 4,
    ]

    const result = await fanout(thunks, { limit: 3 })
    expect(result).toEqual([0, null, 2, null, 4])
  })

  it('no unhandled rejection fires on all-fail', async () => {
    const rejections: unknown[] = []
    process.once('unhandledRejection', (reason) => rejections.push(reason))

    const thunks = Array.from({ length: 4 }, () => async () => {
      throw new Error('fail')
    })
    await fanout(thunks, { limit: 2 })

    // Give microtasks a tick to surface any unhandledRejection
    await new Promise<void>((res) => setTimeout(res, 10))
    expect(rejections).toHaveLength(0)
  })
})
