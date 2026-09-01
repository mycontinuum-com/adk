/**
 * Workflow.ask-no-tools-call — Ask Is A No-Tools One-Shot Call
 *
 * The ephemeral agent built by app.ask is a NO-TOOLS call: constructed with only
 * model/context/output, exposes no tools or handlers to the model.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

describe('workflow.ask-no-tools-call', () => {
  it('app.ask constructs an agent with no tools — no tool_call events in the stream', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'the answer is 42' }] })

    const app = adk({
      name: 'no-tools-test',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const events: string[] = []
    const wf = app.step({
      name: 'ask-step',
      execute: async () => {
        await app.ask('what is 2+2?')
      },
    })

    const stream = app.run(wf, 'go')
    for await (const e of stream) {
      events.push(e.type)
    }
    await stream

    // No tool_call events should appear — app.ask is a no-tools call
    expect(events.filter((t) => t === 'tool_call')).toHaveLength(0)
  })

  it('the agent built by app.ask carries an empty tools array', async () => {
    const mockAdapter = new MockAdapter({ responses: [] })
    let capturedTools: unknown[] = ['not-captured']

    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            // Capture the tools the agent was constructed with
            capturedTools = ctx.agent.tools ?? []
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    mockAdapter.setResponses([{ text: 'answer' }])

    const app = adk({
      name: 'no-tools-check',
      adapters: { openai: captureAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    await app.ask('test')

    // The ephemeral agent must have no tools
    expect(capturedTools).toEqual([])
  })
})
