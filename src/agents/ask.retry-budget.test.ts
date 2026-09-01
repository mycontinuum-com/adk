/**
 * Workflow.ask-default-and-explicit-retries — Ask Retry Budget Resolves Per Schema And Override
 *
 * Case A: schema-less with no retries → exactly ONE app.run, no retry loop. Case B: schema +
 * retries: 0 → exactly ONE attempt, throws OutputParseError despite schema. Case C: schema +
 * retries: 4 → exactly FIVE attempts (retries + 1) before throwing.
 *
 * Evidence: unit test (model-call spy)
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

const schema = z.object({ v: z.number() })

describe('workflow.ask-default-and-explicit-retries', () => {
  it('case A: schema-less — exactly 1 inner run, no retry (budget = 0)', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'hello there' }] })

    const app = adk({
      name: 'budget-A',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const result = await app.ask('hello')
    expect(result).toBe('hello there')
    // Only 1 model call — no retry loop for schema-less calls
    expect(mockAdapter.stepCalls).toHaveLength(1)
  })

  it('case A-fail: schema-less error surfaces immediately with no retry', async () => {
    const providerError = new Error('Provider error')
    const mockAdapter = new MockAdapter({ responses: [{ error: providerError }] })

    const app = adk({
      name: 'budget-A-fail',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    await expect(app.ask('hello')).rejects.toThrow('Provider error')
    // Only 1 call — schema-less errors never retry
    expect(mockAdapter.stepCalls).toHaveLength(1)
  })

  it('case B: schema + retries:0 — exactly 1 attempt, throws parse error', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'invalid-json' }] })

    const app = adk({
      name: 'budget-B',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    let thrownError: Error | null = null
    await app.ask('hello', { schema, retries: 0 }).catch((e: Error) => {
      thrownError = e
    })
    expect(thrownError).not.toBeNull()
    expect((thrownError as Error).name).toBe('OutputParseError')
    // Exactly 1 call despite schema being set
    expect(mockAdapter.stepCalls).toHaveLength(1)
  })

  it('case C: schema + retries:4 — exactly 5 attempts (retries+1) before throwing', async () => {
    // Provide 5 invalid responses
    const mockAdapter = new MockAdapter({
      responses: [
        { text: 'bad' },
        { text: 'bad' },
        { text: 'bad' },
        { text: 'bad' },
        { text: 'bad' },
      ],
    })

    const app = adk({
      name: 'budget-C',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    let thrownError: Error | null = null
    await app.ask('hello', { schema, retries: 4 }).catch((e: Error) => {
      thrownError = e
    })
    expect(thrownError).not.toBeNull()
    expect((thrownError as Error).name).toBe('OutputParseError')
    // 5 total attempts = retries + 1
    expect(mockAdapter.stepCalls).toHaveLength(5)
  })

  it('default budget: schema with no retries option uses 2 retries (3 total attempts)', async () => {
    const mockAdapter = new MockAdapter({
      responses: [{ text: 'bad' }, { text: 'bad' }, { text: 'bad' }],
    })

    const app = adk({
      name: 'budget-default',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    let thrownError: Error | null = null
    await app.ask('hello', { schema }).catch((e: Error) => {
      thrownError = e
    })
    expect(thrownError).not.toBeNull()
    expect((thrownError as Error).name).toBe('OutputParseError')
    // Default is retries:2 → 3 total attempts
    expect(mockAdapter.stepCalls).toHaveLength(3)
  })
})
