/**
 * Workflow.ask-retry-parse-error-only — Ask Retries Only OutputParseError Not Provider Errors
 *
 * Call A: non-OutputParseError on attempt 0 → EXACTLY ONE inner app.run, re-throws immediately.
 * Call B: OutputParseError on attempts 0+1, success on attempt 2 → THREE inner app.run.
 *
 * Evidence: unit test (inner-run spy)
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

const schema = z.object({ v: z.number() })

describe('workflow.ask-retry-parse-error-only', () => {
  it('call A: provider/transport error — exactly 1 inner run, re-throws immediately (not retried)', async () => {
    const providerError = new Error('Connection timeout')
    const mockAdapter = new MockAdapter({
      responses: [
        { error: providerError }, // attempt 0: provider error → should throw immediately, no retry
      ],
    })

    const app = adk({
      name: 'retry-parse-A',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    let thrownError: Error | null = null
    await app.ask('hello', { schema, retries: 2 }).catch((e: Error) => {
      thrownError = e
    })

    // Exactly 1 attempt — provider errors are NOT retried even with retries:2
    expect(mockAdapter.stepCalls).toHaveLength(1)

    // The thrown error should be the original provider error, not an OutputParseError
    expect(thrownError).not.toBeNull()
    expect((thrownError as Error).name).not.toBe('OutputParseError')
    expect((thrownError as Error).message).toBe('Connection timeout')
  })

  it('call B: OutputParseError x2 then success — exactly 3 inner runs', async () => {
    const mockAdapter = new MockAdapter({
      responses: [
        { text: 'bad-json' }, // attempt 0: OutputParseError → retry
        { text: 'bad-json' }, // attempt 1: OutputParseError → retry
        { text: '{"v":7}' }, // attempt 2: valid → return
      ],
    })

    const app = adk({
      name: 'retry-parse-B',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const result = await app.ask('hello', { schema, retries: 2 })

    // Exactly 3 attempts
    expect(mockAdapter.stepCalls).toHaveLength(3)
    expect(result.v).toBe(7)
  })
})
