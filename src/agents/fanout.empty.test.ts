/**
 * Workflow.fanout-empty-input — Fanout Empty Input
 *
 * Fanout([]) resolves to [] immediately, never rejects, starts no work.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { fanout } from './fanout'

describe('workflow.fanout-empty-input', () => {
  it('empty thunks array resolves to [] without error', async () => {
    await expect(fanout([])).resolves.toEqual([])
    await expect(fanout([], { limit: 5 })).resolves.toEqual([])
  })

  it('does not divide by zero or hang when computing default limit with 0 thunks', async () => {
    // This would deadlock or throw if the implementation waits for 'all settled' on an
    // empty pool with incorrect bookkeeping.
    const result = await Promise.race([
      fanout([]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung')), 500)),
    ])
    expect(result).toEqual([])
  })
})
