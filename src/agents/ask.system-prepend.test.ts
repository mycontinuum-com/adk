/**
 * Workflow.ask-system-prepend — Ask Honors System Prompt
 *
 * When system is set, the ephemeral agent's context is [system(opts.system), history()]. When
 * system is omitted, the context is [history()] with no synthetic system entry.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

describe('workflow.ask-system-prepend', () => {
  it('when system is set, a system event appears in the rendered context', async () => {
    const mockAdapter = new MockAdapter({ responses: [] })
    const renderedContextEvents: string[][] = []

    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            // Capture the event types rendered to the model
            renderedContextEvents.push(ctx.events.map((e: any) => e.type))
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    mockAdapter.setResponses([{ text: 'hello' }, { text: 'world' }])

    const app = adk({
      name: 'system-prepend-test',
      adapters: { openai: captureAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    // Call 1: with system prompt
    await app.ask('hello', { system: 'You are a test agent — be concise' })

    // Call 2: without system prompt
    await app.ask('hello')

    // Call 1 should have a 'system' event in its context
    const call1Events = renderedContextEvents[0] ?? []
    expect(call1Events).toContain('system')

    // Call 2 should NOT have a 'system' event
    const call2Events = renderedContextEvents[1] ?? []
    expect(call2Events).not.toContain('system')
  })

  it('system prompt does not persist from one app.ask call to the next', async () => {
    const mockAdapter = new MockAdapter({ responses: [] })
    const renderedContextEvents: string[][] = []

    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            renderedContextEvents.push(ctx.events.map((e: any) => e.type))
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    mockAdapter.setResponses([{ text: 'first' }, { text: 'second' }])

    const app = adk({
      name: 'system-no-persist',
      adapters: { openai: captureAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    // First call has system prompt
    await app.ask('msg', { system: 'Be terse' })
    // Second call has NO system prompt
    await app.ask('msg')

    // First call: has system
    expect(renderedContextEvents[0]).toContain('system')
    // Second call: NO system (not leaked from first)
    expect(renderedContextEvents[1]).not.toContain('system')
  })
})
