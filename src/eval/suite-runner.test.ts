import { vi } from 'vitest'

import type { LiveVoiceEvalCase } from './voice/types'

import { adk } from '../api'
import { openai } from '../providers/models'
import { InMemoryStore } from '../session/memory'

const boundary = vi.hoisted(() => ({ run: vi.fn<typeof import('./voice/runner').runVoiceCase>() }))
vi.mock('./voice/runner', () => ({ runVoiceCase: boundary.run }))
vi.mock('./voice/process-pool', () => ({
  isProcessWorker: () => false,
  forkCase: vi.fn<typeof import('./voice/process-pool').forkCase>(),
}))

afterEach(() => vi.resetAllMocks())

describe('a metric that throws', () => {
  const throwing = { name: 'broken', evaluate: () => Promise.reject(new Error('no verdict')) }

  it('makes a text case an error, not a failure', async () => {
    const app = adk({ name: 'metrics' })
    const result = await app.evaluate(
      app.evaluate.case({
        name: 'text',
        input: 'Hello',
        runnable: app.step({ name: 'reply', execute: (ctx) => ctx.output('Hi') }),
        metrics: [throwing],
      }),
    )

    expect(result.results[0].status).toBe('error')
    expect(result.results[0].metrics.broken).toEqual({
      passed: false,
      evidence: ['Metric evaluation failed: no verdict'],
      error: 'no verdict',
    })
  })

  it('makes a voice case an error, not a failure', async () => {
    const store = new InMemoryStore()
    const app = adk({ name: 'metrics', store })
    const live: LiveVoiceEvalCase = {
      name: 'live',
      agent: app.agent({ name: 'voice', model: openai.live('gpt-live-1'), context: [] }),
      backend: app.agent({ name: 'backend', model: openai('mock'), context: [] }),
      userAgent: app.agent({ name: 'caller', model: openai.realtime('gpt-realtime'), context: [] }),
      metrics: [throwing],
    }
    boundary.run.mockImplementation(async () => ({
      status: 'completed',
      startedAtMs: 0,
      session: await app.sessions.create({ sessionId: 'voice' }),
      events: [],
      voiceEvents: [],
      transcript: [],
      timing: {
        responseTimes: [],
        silenceGaps: [],
        interruptions: { count: 0, byAgent: 0, byUser: 0 },
        vadResolutionMs: 0,
      },
      recording: { path: '/synthetic/recording.wav' },
      durationMs: 1,
    }))
    const result = await app.evaluate.voice(live, {
      concurrency: 1,
      room: { url: 'ws://synthetic.invalid' },
    })

    expect(result.results[0].status).toBe('error')
  })
})
