import { describe, expect, it } from 'vitest'

import { requestTimeoutMs } from './timeout'

describe('requestTimeoutMs', () => {
  it.each([
    [undefined, 30_000],
    [1, 1],
    [8_000, 8_000],
    [3_600_000, 3_600_000],
  ])('accepts %s as %i ms', (input, expected) => {
    expect(requestTimeoutMs(input)).toBe(expected)
  })

  it.each([0, -1, 1.5, Number.NaN, Infinity, 3_600_001])('rejects %s', (input) => {
    expect(() => requestTimeoutMs(input)).toThrow(
      new RangeError(`timeoutMs must be a whole number from 1 to 3600000, got ${input}`),
    )
  })
})
