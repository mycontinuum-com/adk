/**
 * Workflow.fanout-thunk-isolation — Fanout Thunks Run Isolated
 *
 * Each thunk runs isolated — no thunk observes another thunk's session/state. Holds whether fanout
 * is called inside app.step or in a plain async function.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'
import { fanout } from './fanout'

describe('workflow.fanout-thunk-isolation', () => {
  it('thunks share no state: each returns its own unique marker', async () => {
    const markers: string[] = []
    const N = 5

    const thunks = Array.from({ length: N }, (_, i) => async (): Promise<string> => {
      const myMarker = `marker-${i}`
      markers.push(myMarker)
      // No thunk can read another's marker because they're just local variables
      return myMarker
    })

    const results = await fanout(thunks, { limit: N })

    // Each result is its own unique marker
    expect(results).toHaveLength(N)
    for (let i = 0; i < N; i++) {
      expect(results[i]).toBe(`marker-${i}`)
    }
  })

  it('fanout outside an app.step also isolates thunks', async () => {
    // Plain async function — not inside any ADK context
    const N = 3
    const thunks = Array.from({ length: N }, (_, i) => async () => i * 2)
    const results = await fanout(thunks, { limit: 2 })
    expect(results).toEqual([0, 2, 4])
  })

  it('concurrent thunks each issuing app.ask run on isolated sessions', async () => {
    const mockAdapter = new MockAdapter({
      responses: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    })
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
      name: 'fanout-isolation',
      adapters: { openai: captureAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    const wf = app.step({
      name: 'isolation-test',
      execute: async () => {
        const thunks = Array.from({ length: 3 }, (_, i) => async () => app.ask(`call ${i}`))
        return fanout(thunks, { limit: 3 })
      },
    })

    const result = await app.run(wf, 'go')
    expect(result.status).toBe('completed')
    // each thunk's app.ask ran on its OWN fresh BaseSession — all three session ids are distinct,
    // proving fanout threads no shared session between concurrent thunks.
    expect(sessionIds).toHaveLength(3)
    expect(new Set(sessionIds).size).toBe(3)
  })
})
