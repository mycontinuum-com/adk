/**
 * Workflow.ask-isolation-default — Ask Isolation Default
 *
 * Each app.ask runs on a fresh BaseSession; no call observes another's session state. The
 * distinction with ctx.run (shared-session sub-run) is documented: ctx.run mutates the parent
 * session and is therefore NOT the safe default for independent work.
 *
 * Evidence: unit test — two app.ask calls get distinct BaseSessions, contrasted with a ctx.run case
 * that DOES see shared state.
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

describe('workflow.ask-isolation-default', () => {
  it('two app.ask calls do not share session state — each gets a fresh BaseSession', async () => {
    // Each app.ask should get a brand-new BaseSession. We verify this by tracking
    // how many distinct sessions are created during the two calls.
    const mockAdapter = new MockAdapter({
      responses: [{ text: 'response-1' }, { text: 'response-2' }],
    })

    // Track session ids to verify they are distinct
    const sessionIds: string[] = []
    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            sessionIds.push(ctx.session.id)
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    const app = adk({
      name: 'isolation-test',
      adapters: { openai: captureAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const r1 = await app.ask('call 1')
    const r2 = await app.ask('call 2')

    expect(r1).toBe('response-1')
    expect(r2).toBe('response-2')

    // The two calls ran on DIFFERENT sessions (isolation by default)
    expect(sessionIds).toHaveLength(2)
    expect(sessionIds[0]).not.toBe(sessionIds[1])
  })

  it('the MockAdapter step() records calls that are from fresh sessions each time', async () => {
    const mockAdapter = new MockAdapter({
      responses: [{ text: 'a' }, { text: 'b' }],
    })

    const app = adk({
      name: 'isolation-check',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    await app.ask('first')
    await app.ask('second')

    // Both calls used the adapter — each was a separate run
    expect(mockAdapter.stepCalls).toHaveLength(2)

    // The sessions referenced in each step call should be distinct objects
    const session0 = mockAdapter.stepCalls[0]?.ctx.session
    const session1 = mockAdapter.stepCalls[1]?.ctx.session

    expect(session0).toBeDefined()
    expect(session1).toBeDefined()
    expect(session0).not.toBe(session1)
  })

  it('contrasting case: ctx.run shares the parent session — events appear in the same session', async () => {
    // This contrasts with app.ask isolation.
    // ctx.run performs a sub-run on the SAME parent session, so events from the sub-agent
    // appear in the parent session's event stream. This is the deliberate shared-session
    // sub-run path, documented as distinct from app.ask's isolation-by-default.
    //
    // We verify by running a step with ctx.run and a step with app.ask. With ctx.run, the
    // sub-agent's invocation_start event appears in the parent session. With app.ask, each
    // call uses a fresh isolated session and the parent session has no sub-invocation events.
    const mockAdapter = new MockAdapter({
      responses: [{ text: 'sub-result' }],
    })

    const app = adk({
      name: 'ctx-run-contrast',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const subAgent = app.agent({ name: 'sub-agent' })

    const parentStep = app.step({
      name: 'parent-step',
      execute: async (ctx) => {
        // ctx.run runs the sub-agent on the SAME session (shared-session sub-run)
        await ctx.run(subAgent)
      },
    })

    const result = await app.run(parentStep, 'go')

    // The parent session should contain events from BOTH the parent step and the sub-agent
    // (invocation_start for the sub-agent appears in the shared session)
    const invocationStarts = result.session.events.filter((e) => e.type === 'invocation_start')

    // There should be at least 2 invocation_starts: one for the step, one for the sub-agent
    // This proves they share the same session (contrast: app.ask would produce zero sub-invocation
    // events in the parent session because each call uses a fresh isolated session)
    expect(invocationStarts.length).toBeGreaterThanOrEqual(2)

    // The sub-agent's invocation start is in the parent session — shared session confirmed
    const agentNames = invocationStarts.map((e) => (e as any).agentName)
    expect(agentNames).toContain('sub-agent')
  })
})
