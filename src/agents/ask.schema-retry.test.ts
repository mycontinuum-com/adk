/**
 * Workflow.ask-schema-retry — Ask Schema Retry
 *
 * The runtime re-runs on OutputParseError and returns the valid parsed value. With a model that
 * never emits valid output, the call throws after exhausting the budget.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

const schema = z.object({ value: z.number() })

describe('workflow.ask-schema-retry', () => {
  it('re-runs the model on OutputParseError and returns the valid parsed value', async () => {
    const mockAdapter = new MockAdapter({
      responses: [
        { text: 'invalid-not-json' }, // attempt 0: invalid → OutputParseError → retry
        { text: '{"value":42}' }, // attempt 1: valid → return
      ],
    })

    const app = adk({
      name: 'retry-test',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const result = await app.ask('give me a number', { schema, retries: 2 })
    expect(result.value).toBe(42)
    // Two model calls: one invalid, one valid
    expect(mockAdapter.stepCalls).toHaveLength(2)
  })

  it('throws after exhausting retries when model never returns valid output', async () => {
    const mockAdapter = new MockAdapter({
      responses: [
        { text: 'bad' }, // attempt 0
        { text: 'bad' }, // attempt 1
        { text: 'bad' }, // attempt 2
      ],
    })

    const app = adk({
      name: 'retry-exhaust',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    // retries: 2 → 3 total attempts (0, 1, 2)
    // Note: OutputParseError is deserialized through the channel as a plain Error
    // but retains the name 'OutputParseError'
    let thrownError: Error | null = null
    await app.ask('give me a number', { schema, retries: 2 }).catch((e: Error) => {
      thrownError = e
    })
    expect(thrownError).not.toBeNull()
    expect((thrownError as Error).name).toBe('OutputParseError')
    expect(mockAdapter.stepCalls).toHaveLength(3)
  })

  it('with retries:0 makes exactly one attempt and throws on invalid output', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'not-valid-json' }] })

    const app = adk({
      name: 'retry-zero',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    let thrownError: Error | null = null
    await app.ask('give me a number', { schema, retries: 0 }).catch((e: Error) => {
      thrownError = e
    })
    expect(thrownError).not.toBeNull()
    expect((thrownError as Error).name).toBe('OutputParseError')
    // Only 1 call despite the invalid output
    expect(mockAdapter.stepCalls).toHaveLength(1)
  })
})
