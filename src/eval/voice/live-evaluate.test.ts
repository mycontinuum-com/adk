import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { z } from 'zod'

import type { LiveVoiceAppContext } from '../../voice/live-handler'
import type { BaseEvalCaseResult } from '../types'
import type { LiveVoiceEvalCase, VoiceRunResult, VoiceRunStatus } from './types'

import { adk } from '../../api'
import { summarizeModelUsage } from '../../core/runner'
import { openai } from '../../providers/models'
import { sumCosts, usageCost } from '../../providers/pricing'
import { InMemoryStore } from '../../session/memory'
import { sessionService } from '../../session/service'
import { TEST_PRICING } from '../../test-support/pricing-registry'
import { LiveVoiceMeter, realtimeTokenUsage } from '../../voice/live-usage'
import { evalCli } from '../cli'
import { stringifyEvidence, voiceEvidence } from '../json'
import { eventCountMetric } from '../metrics/events'
import { stateMetric } from '../metrics/state'
import { generateReport } from '../report'
import { evaluateVoice, serializeWorkerResult } from './evaluate'
import { summarizeLiveEvalUsage } from './live-runner'

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

function costedRun(run: VoiceRunResult<typeof schema>): VoiceRunResult<typeof schema> {
  let clock = 0
  const meter = new LiveVoiceMeter('gpt-live-1', () => clock)
  meter.start()
  clock = 90_000
  meter.stop()
  const backend = summarizeModelUsage(
    [{ provider: 'openai', modelName: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 }],
    TEST_PRICING,
  )
  const caller = realtimeTokenUsage(
    {
      type: 'realtime_model_metrics',
      inputTokens: 0,
      outputTokens: 10_000,
      inputTokenDetails: { audioTokens: 0, textTokens: 0, cachedTokens: 0 },
      outputTokenDetails: { audioTokens: 10_000, textTokens: 0 },
    },
    'gpt-realtime',
  )
  const voice = meter.usage(TEST_PRICING)
  const callBackend = { usage: backend, cost: usageCost(backend) }
  return {
    ...run,
    usage: backend,
    usageScope: 'backend',
    liveUsage: summarizeLiveEvalUsage({
      pricing: TEST_PRICING,
      backend: undefined,
      call: {
        backend: callBackend,
        voice,
        total: sumCosts([callBackend.cost, voice.cost]),
      },
      voiceModel: 'gpt-live-1',
      callerCalls: [caller],
    }),
  }
}

describe('native Live voice eval suite', () => {
  it('writes backend, voice and caller cost with their basis to result.json and report.md', async () => {
    const { app, live } = fixture()
    boundary.run.mockImplementation(async () => costedRun(await completedCall(app, 'costed')))
    const root = await mkdtemp(join(tmpdir(), 'adk-live-cost-'))
    const argv = process.argv
    process.argv = [argv[0]!, 'live-cost-eval', 'run', '--output', root]
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    let code: number
    try {
      code = await evalCli(app, [live], { concurrency: 1, voice: { room: options.room } })
    } finally {
      process.argv = argv
      stdout.mockRestore()
      stderr.mockRestore()
    }
    expect(code).toBe(0)
    const [directory] = await readdir(root)
    const document = JSON.parse(await readFile(join(root, directory!, 'result.json'), 'utf8'))
    const liveUsage = document.results[0].liveUsage
    expect(liveUsage.backend.cost).toEqual({ basis: 'reported', totalCost: 0.15, currency: 'USD' })
    expect(liveUsage.voice).toEqual({
      modelName: 'gpt-live-1',
      seconds: 90,
      cost: { basis: 'estimated', totalCost: 0.075, currency: 'USD' },
    })
    expect(liveUsage.caller.cost.basis).toBe('reported')
    expect(liveUsage.caller.cost.totalCost).toBeCloseTo(0.64, 12)
    expect(liveUsage.total.basis).toBe('estimated')
    expect(liveUsage.total.totalCost).toBeCloseTo(0.865, 12)
    expect(await readFile(join(root, directory!, 'report.md'), 'utf8')).toContain(
      '**Cost:** $0.8650 (estimated) — backend $0.1500 (reported), voice $0.0750 (estimated), caller $0.6400 (reported)',
    )
    const [caseDirectory] = await readdir(join(root, directory!, 'voice'))
    expect(
      await readFile(join(root, directory!, 'voice', caseDirectory!, 'report.md'), 'utf8'),
    ).toContain(
      '**Cost**: $0.8650 (estimated) — backend $0.1500 (reported), voice 90.0s $0.0750 (estimated), caller $0.6400 (reported)',
    )
  })

  it('sums cost across cases and shows the known part when one case is unavailable', async () => {
    const { app, live, context } = fixture()
    let count = 0
    boundary.run.mockImplementation(async () => {
      const run = await completedCall(app, `suite-${++count}`)
      if (count === 1) return costedRun(run)
      return {
        ...run,
        liveUsage: summarizeLiveEvalUsage({
          pricing: TEST_PRICING,
          backend: undefined,
          call: undefined,
          voiceModel: 'gpt-live-1',
          callerCalls: [undefined],
        }),
      }
    })
    const result = await evaluateVoice(live, { ...options, repeat: 2 }, context)
    expect(result.results[1].run.liveUsage?.caller.cost).toEqual({ basis: 'unavailable' })
    expect(app.evaluate.voice.report()(result)).toContain(
      '**Cost:** unavailable ($0.8650 known across 1 of 2 cases) — backend $0.1500 (reported), voice unavailable, caller unavailable',
    )
  })

  it('counts an interrupted non-Live case as unavailable, not free', async () => {
    const { app, live, context } = fixture()
    boundary.run.mockImplementation(async () => costedRun(await completedCall(app, 'mixed-cost')))
    const voice = await evaluateVoice(live, options, context)
    const text: BaseEvalCaseResult = { name: 'text', status: 'timeout', metrics: {}, durationMs: 1 }
    const report = generateReport({ ...voice, results: [...voice.results, text] })
    expect(report).toContain(
      '**Cost:** unavailable ($0.8650 known across 1 of 2 cases) — backend $0.1500 (reported), voice $0.0750 (estimated), caller $0.6400 (reported), other cases unavailable',
    )
  })

  it('rejects malformed Live usage from a voice worker', async () => {
    const { app, live, context } = fixture()
    const run = costedRun(await completedCall(app, 'malformed'))
    const serialized = JSON.parse(
      serializeWorkerResult({ name: live.name, status: 'passed', metrics: {}, durationMs: 1, run }),
    )
    serialized.run.liveUsage.total = { basis: 'unavailable', totalCost: 42 }
    boundary.fork.mockResolvedValue(JSON.stringify(serialized))
    const result = await evaluateVoice(live, { ...options, concurrency: 2 }, context)
    expect(result.results[0].status).toBe('error')
    expect(result.results[0].error?.message).toBe(
      'Voice worker returned an invalid evaluation result',
    )
  })

  it('reports unavailable components instead of a zero total', async () => {
    const { app, live, context } = fixture()
    const run = await completedCall(app, 'uncosted')
    boundary.run.mockResolvedValue({
      ...run,
      liveUsage: summarizeLiveEvalUsage({
        pricing: TEST_PRICING,
        backend: undefined,
        call: undefined,
        voiceModel: 'gpt-live-1',
        callerCalls: [],
      }),
    })
    const result = await evaluateVoice(live, options, context)
    expect(result.results[0].run.liveUsage).toEqual({
      backend: { cost: { basis: 'reported', totalCost: 0, currency: 'USD' } },
      voice: { modelName: 'gpt-live-1', cost: { basis: 'unavailable' } },
      caller: { cost: { basis: 'unavailable' } },
      total: { basis: 'unavailable' },
    })
    expect(app.evaluate.voice.report()(result)).toContain(
      '**Cost:** unavailable ($0.000000 known across 0 of 1 cases) — backend $0.000000 (reported), voice unavailable, caller unavailable',
    )
  })

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
    const run = costedRun(await completedCall(app, 'durable-call-42'))
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
    expect(evidence.liveUsage).toEqual(run.liveUsage)
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
    expect(result.results[0].run.liveUsage).toEqual(run.liveUsage)
  })
})
