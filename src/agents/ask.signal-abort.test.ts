/**
 * Workflow.ask-signal-aborts-call — Ask Threads Its Abort Signal
 *
 * App.ask threads opts.signal into the inner app.run({ input, signal }), so aborting the signal
 * cancels the in-flight one-shot agent run.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

describe('workflow.ask-signal-aborts-call', () => {
  it('aborting opts.signal before the call settles cancels the in-flight run', async () => {
    // Use a slow response to ensure the abort fires while the request is in-flight
    const mockAdapter = new MockAdapter({
      responses: [{ text: 'too late', delayMs: 500 }],
    })

    const app = adk({
      name: 'signal-test',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const ac = new AbortController()

    const askPromise = app.ask('hello', { signal: ac.signal })

    // Abort immediately — should cancel the slow model call
    ac.abort()

    let settledError: Error | null = null
    await askPromise.catch((e: Error) => {
      settledError = e
    })

    // The promise should have settled with an error (aborted), not the model response
    expect(settledError).not.toBeNull()
    // The error should be abort-related, not "not implemented"
    expect((settledError as Error).message).not.toBe('not implemented')
  })

  it('aborting before call starts also causes rejection', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'response' }] })

    const app = adk({
      name: 'pre-abort-test',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const ac = new AbortController()
    // Abort BEFORE calling app.ask
    ac.abort()

    let settledError: Error | null = null
    await app.ask('hello', { signal: ac.signal }).catch((e: Error) => {
      settledError = e
    })

    // Should have rejected
    expect(settledError).not.toBeNull()
  })
})
