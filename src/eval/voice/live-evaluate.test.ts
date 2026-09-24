import { vi } from 'vitest'
import { z } from 'zod'

import type { LiveVoiceAppContext } from '../../voice/live-handler'
import type { LiveVoiceEvalCase, VoiceRunResult, VoiceRunStatus } from './types'

import { adk } from '../../api'
import { openai } from '../../providers/models'
import { InMemoryStore } from '../../session/memory'
import { sessionService } from '../../session/service'
import { stringifyEvidence, voiceEvidence } from '../json'
import { eventCountMetric } from '../metrics/events'
import { stateMetric } from '../metrics/state'
import { evaluateVoice, serializeWorkerResult } from './evaluate'

const boundary = vi.hoisted(() => ({
  run: vi.fn<typeof import('./runner').runVoiceCase>(),
  fork: vi.fn<typeof import('./process-pool').forkCase>(),
}))
vi.mock('./runner', () => ({ runVoiceCase: boundary.run }))
vi.mock('./process-pool', () => ({
  isProcessWorker: () => false,
  forkCase: boundary.fork,
}))

const schema = { session: { lookups: z.number().default(0) } }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.resetAllMocks()
})

function fixture() {
  const store = new InMemoryStore()
  const app = adk({ name: 'live-eval-suite', store, schema })
  cleanups.push(() => app.close())
  const backend = app.agent({ name: 'backend', model: openai('mock'), context: [] })
  const agent = app.agent({ name: 'receptionist', model: openai.live('gpt-live-1'), context: [] })
  const userAgent = app.agent({
    name: 'caller',
    model: openai.realtime('gpt-realtime'),
    context: [],
  })
  const live: LiveVoiceEvalCase<typeof schema> = {
    name: 'practice-information',
    agent,
    backend,
    userAgent,
    hooks: [{ onResult: (ctx) => ctx.voice.appendCommentary(String(ctx.output)) }],
  }
  const context: LiveVoiceAppContext<typeof schema> = {
    app,
    store,
    sessionService: sessionService(store),
  }
  return { app, live, context, userAgent }
}

const options = { concurrency: 1, room: { url: 'ws://synthetic.invalid' }, schema }

async function completedCall(
  app: ReturnType<typeof fixture>['app'],
  id = 'call-one',
  status: VoiceRunStatus = 'completed',
): Promise<VoiceRunResult<typeof schema>> {
  const session = await app.sessions.create({ sessionId: id })
  session.state.update({ lookups: 2 })
  session.input.message('What are the practice hours?')
  await app.sessions.commit(session)
  return {
    status,
    startedAtMs: 1_000,
    session,
    events: session.events,
    voiceEvents: [],
    transcript: [{ role: 'assistant', text: 'Monday to Friday.', turnIndex: 0 }],
    timing: {
      responseTimes: [],
      silenceGaps: [],
      interruptions: { count: 0, byAgent: 0, byUser: 0 },
      vadResolutionMs: 0,
    },
    recording: { path: '/synthetic/recording.wav' },
    durationMs: 10_000,
    ...(status === 'error' && { error: { message: 'Backend persistence failed' } }),
  }
}

describe('native Live voice eval suite', () => {
  it('binds the owning app through app.evaluate.voice', async () => {
    const { app, live } = fixture()
    boundary.run.mockImplementation(async (_case, _options, _writer, _dir, context) => {
      if (context?.app !== app) throw new Error('The owning app was not bound')
      return completedCall(context.app, 'facade-call')
    })
    const result = await app.evaluate.voice(live, options)
    expect(result.summary.passed).toBe(1)
    expect(result.results[0].run.session.id).toBe('session_facade-call')
  })

  it('binds the owning app when mixed evaluation selects a Live case', async () => {
    const { app, live } = fixture()
    boundary.run.mockImplementation(async (_case, _options, _writer, _dir, context) => {
      if (context?.app !== app) throw new Error('The owning app was not bound')
      return completedCall(context.app, 'mixed-live-call')
    })
    const text = app.evaluate.case({
      name: 'text',
      runnable: app.step({ name: 'hello', execute: (ctx) => ctx.output('Hello') }),
    })
    const result = await app.evaluate([text, live], {
      concurrency: 1,
      voice: { room: options.room },
    })
    expect(result.results.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'text', status: 'passed' },
      { name: 'practice-information', status: 'passed' },
    ])
    const liveResult = result.results[1]
    expect('run' in liveResult && liveResult.run.session.state.lookups).toBe(2)
  })

  it('evaluates actual session state and events with the ordinary native metrics', async () => {
    const { app, live, context } = fixture()
    boundary.run.mockImplementation(async (_case, _options, _writer, _dir, suppliedContext) => {
      if (suppliedContext !== context) throw new Error('The owning ADK context was lost')
      return completedCall(app)
    })
    const result = await evaluateVoice(
      {
        ...live,
        metrics: [
          stateMetric({
            name: 'lookups',
            scope: 'session',
            key: 'lookups',
            assertion: (n) => n === 2,
          }),
          eventCountMetric({ name: 'caller-input', eventType: 'user', assertion: (n) => n === 1 }),
        ],
      },
      options,
      context,
    )
    expect(result.summary).toMatchObject({ passed: 1, failed: 0, errors: 0 })
    expect(result.results[0].metrics).toMatchObject({
      lookups: { passed: true },
      'caller-input': { passed: true },
    })
    expect(result.results[0].run.session.id).toBe('session_call-one')
    expect(result.results[0].run.transcript).toEqual([
      { role: 'assistant', text: 'Monday to Friday.', turnIndex: 0 },
    ])
  })

  it('marks a completed call failed when a native metric fails', async () => {
    const { app, live, context } = fixture()
    boundary.run.mockResolvedValue(await completedCall(app))
    const result = await evaluateVoice(
      {
        ...live,
        metrics: [
          stateMetric({
            name: 'lookups',
            scope: 'session',
            key: 'lookups',
            assertion: (n) => n === 3,
          }),
        ],
      },
      options,
      context,
    )
    expect(result.summary).toMatchObject({ passed: 0, failed: 1 })
    expect(result.results[0].metrics.lookups.passed).toBe(false)
  })

  it.each(['error', 'timeout'] as const)(
    'never passes a %s call despite passing metrics',
    async (status) => {
      const { app, live, context } = fixture()
      boundary.run.mockResolvedValue(await completedCall(app, 'failed-call', status))
      const result = await evaluateVoice(
        {
          ...live,
          metrics: [
            stateMetric({
              name: 'lookups',
              scope: 'session',
              key: 'lookups',
              assertion: (n) => n === 2,
            }),
          ],
        },
        options,
        context,
      )
      expect(result.summary.passed).toBe(0)
      expect(result.results[0].status).toBe(status === 'error' ? 'error' : 'terminated')
      expect(result.results[0].run.status).toBe(status)
      expect(result.results[0].metrics.lookups.passed).toBe(true)
    },
  )

  it('repeats a case with independent call sessions and per-run metrics', async () => {
    const { app, live, context } = fixture()
    let count = 0
    boundary.run.mockImplementation(() => completedCall(app, `repeat-${++count}`))
    const result = await evaluateVoice(live, { ...options, repeat: 2 }, context)
    expect(result.summary).toMatchObject({ total: 2, passed: 2 })
    expect(
      result.results.map((item) => ({ id: item.run.session.id, repeat: item.repeatIndex })),
    ).toEqual([
      { id: 'session_repeat-1', repeat: 1 },
      { id: 'session_repeat-2', repeat: 2 },
    ])
  })

  it('retries a transport failure and scores the new call', async () => {
    const { app, live, context } = fixture()
    boundary.run
      .mockResolvedValueOnce(await completedCall(app, 'retry-first', 'error'))
      .mockResolvedValueOnce(await completedCall(app, 'retry-second'))
    const result = await evaluateVoice({ ...live, retries: 1 }, options, context)
    expect(result.summary.passed).toBe(1)
    expect(result.results[0].attempts).toBe(2)
    expect(result.results[0].run.session.id).toBe('session_retry-second')
  })

  it('keeps the existing Realtime case form working in the same suite', async () => {
    const { app, live, userAgent, context } = fixture()
    let count = 0
    boundary.run.mockImplementation(() => completedCall(app, `mixed-${++count}`))
    const result = await evaluateVoice(
      [live, { name: 'realtime', agent: userAgent, userAgent }],
      options,
      context,
    )
    expect(result.results.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'practice-information', status: 'passed' },
      { name: 'realtime', status: 'passed' },
    ])
  })

  it('preserves call identity, state, ledger order and observed-event order across the process boundary', async () => {
    const { app, live, context } = fixture()
    const run = await completedCall(app, 'durable-call-42')
    run.usageScope = 'backend'
    run.liveTranscript = {
      callId: run.session.id,
      receivedThrough: 0,
      observations: [],
      fragments: [],
      status: 'usable',
      duplicates: 0,
      conflicts: [],
      diagnostics: [],
    }
    const evidence = JSON.parse(stringifyEvidence(voiceEvidence(run)))
    expect(evidence.sessionId).toBe(run.session.id)
    expect(evidence.sessionEvents).toEqual(run.session.events)
    expect(evidence.liveTranscript).toEqual(run.liveTranscript)
    expect(evidence.usageScope).toBe('backend')
    const originalIds = run.events.map((event) => event.id)
    const observedEvents = run.events.toReversed()
    boundary.fork.mockResolvedValue(
      serializeWorkerResult({
        name: live.name,
        status: 'passed',
        metrics: { lookups: { passed: true, evidence: ['two lookups'] } },
        durationMs: 10_000,
        run: { ...run, events: observedEvents },
      }),
    )
    const result = await evaluateVoice(live, { ...options, concurrency: 2 }, context)
    expect(result.summary.passed).toBe(1)
    expect(result.results[0].run.session.id).toBe('session_durable-call-42')
    expect(result.results[0].run.session.state.lookups).toBe(2)
    expect(result.results[0].run.session.events.map((event) => event.id)).toEqual(originalIds)
    expect(result.results[0].run.events.map((event) => event.id)).toEqual(originalIds.toReversed())
    expect(result.results[0].run.recording.path).toBe('/synthetic/recording.wav')
    expect(result.results[0].run.liveTranscript).toEqual(run.liveTranscript)
    expect(result.results[0].run.usageScope).toBe('backend')
  })
})
