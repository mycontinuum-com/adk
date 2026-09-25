import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { z } from 'zod'

import type { Event } from '../../types/events'
import type { GPTLiveTranscriptFragment } from '../../voice/gpt-live-transcript'
import type { VoiceRunResult } from '../voice/types'

import { adk } from '../../api'
import { summarizeModelUsage } from '../../core/runner'
import { openai } from '../../providers/models'
import { configurePricing } from '../../providers/pricing'
import { InMemoryStore } from '../../session/memory'
import { sessionService } from '../../session/service'
import { TEST_PRICING, useTestPricing } from '../../test-support/pricing-registry'
import { UsageReportingAdapter } from '../../test-support/usage-adapter'
import { MockAdapter } from '../../testing'
import { evalCli } from '../cli'
import { voiceEvidence } from '../json'
import { caseJudgeCost, generateReport } from '../report'
import { buildSummary } from '../suite-runner'
import { liveTranscriptTurns } from './index'

const criteria = { 'asks-to-send': 'Asks whether to send the request to the practice.' }
const verdict = (reason: string, passed: boolean) =>
  JSON.stringify({ 'asks-to-send': { reason, passed } })

function judged(responses: ConstructorParameters<typeof MockAdapter>[0]['responses']) {
  const adapter = new MockAdapter({ responses })
  const app = adk({ name: 'judge', adapters: { openai: adapter } })
  const consent = app.evaluate.judge({ name: 'consent', criteria, model: openai('gpt-4o-mini') })
  const evalCase = app.evaluate.case({
    name: 'consent',
    input: 'Is that everything?',
    runnable: app.step({ name: 'reply', execute: (ctx) => ctx.output('Shall I send it?') }),
    metrics: [consent],
  })
  return { adapter, app, consent, evalCase }
}

function fragment(
  sequence: number,
  speaker: 'caller' | 'agent',
  text: string,
  startMs: number,
  endMs: number,
  connection = 0,
): GPTLiveTranscriptFragment {
  return {
    connection: { id: `conn-${connection}`, index: connection },
    speaker,
    text,
    startMs,
    endMs,
    sequence,
    receivedAt: 10_000 + endMs,
  }
}

function userMessage(adapter: MockAdapter, call = 0): unknown {
  const user = adapter.stepCalls[call]!.ctx.events.find((event) => event.type === 'user')
  return JSON.parse(user && 'text' in user ? user.text : '')
}

afterEach(() => configurePricing(false))

describe('app.evaluate.judge', () => {
  it('passes a case when every criterion passes, with each verdict in data', async () => {
    const { adapter, app, evalCase } = judged([{ text: verdict('Turn 2 asks to send it.', true) }])
    const result = await app.evaluate(evalCase)

    expect(result.results[0].status).toBe('passed')
    expect(result.results[0].metrics.consent).toEqual({
      passed: true,
      evidence: [],
      data: {
        model: 'gpt-4o-mini',
        verdicts: { 'asks-to-send': { reason: 'Turn 2 asks to send it.', passed: true } },
      },
      usage: {
        models: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalCacheWriteTokens: 0,
        totalReasoningTokens: 0,
        totalAudioInputTokens: 0,
        totalAudioOutputTokens: 0,
        modelCalls: 1,
      },
    })
    expect(adapter.stepCalls[0]!.ctx.events[0]).toMatchObject({ type: 'system' })
  })

  it('fails a case with one evidence line per failed criterion', async () => {
    const { app, evalCase } = judged([{ text: verdict('No turn asks whether to send it.', false) }])
    const result = await app.evaluate(evalCase)

    expect(result.results[0].status).toBe('failed')
    expect(result.results[0].metrics.consent.evidence).toEqual([
      'asks-to-send: No turn asks whether to send it.',
    ])
  })

  it('returns a verdict per criterion, passing ones included', async () => {
    const adapter = new MockAdapter({
      responses: [
        {
          text: JSON.stringify({
            summary: { reason: 'Turn 2 summarises the request.', passed: true },
            'asks-to-send': { reason: 'No turn asks to send it.', passed: false },
          }),
        },
      ],
    })
    const app = adk({ name: 'judge', adapters: { openai: adapter } })
    const run = await app.test(
      app.step({ name: 'reply', execute: (ctx) => ctx.output('A fit note for three days.') }),
      { input: 'Hello' },
    )
    const result = await app.evaluate
      .judge({
        name: 'review',
        criteria: { summary: 'Summarises the request.', 'asks-to-send': criteria['asks-to-send'] },
        model: openai('gpt-4o-mini'),
      })
      .evaluate(run)

    expect(result.passed).toBe(false)
    expect(result.evidence).toEqual(['asks-to-send: No turn asks to send it.'])
    expect(result.data).toEqual({
      model: 'gpt-4o-mini',
      verdicts: {
        summary: { reason: 'Turn 2 summarises the request.', passed: true },
        'asks-to-send': { reason: 'No turn asks to send it.', passed: false },
      },
    })
  })

  it('renders a text run verbatim, tool use and final state included', async () => {
    const adapter = new MockAdapter({
      responses: [
        { toolCalls: [{ name: 'record', args: { days: 'pięć dni' } }] },
        { toolCalls: [{ name: 'reply', args: { text: 'Ŵyr a gŵr, ŷd.' } }] },
        { text: verdict('The agent replies.', true) },
      ],
    })
    const app = adk({
      name: 'judge',
      adapters: { openai: adapter },
      schema: { session: { days: z.string().optional() } },
    })
    const record = app.tool({
      name: 'record',
      description: 'Record the days',
      schema: z.object({ days: z.string() }),
      execute: (ctx) => {
        ctx.state.update({ days: ctx.args.days })
        return { recorded: true }
      },
    })
    const reply = app.tool({
      name: 'reply',
      description: 'Reply',
      schema: z.object({ text: z.string() }),
      execute: (ctx) => ctx.output(ctx.args.text),
    })
    const agent = app.agent({
      name: 'backend',
      model: openai('gpt-4o-mini'),
      context: [app.context.history()],
      tools: [record, reply],
    })
    const result = await app.evaluate(
      app.evaluate.case({
        name: 'polish',
        input: 'Czy mam wysłać to zgłoszenie?',
        runnable: agent,
        metrics: [app.evaluate.judge({ name: 'consent', criteria })],
      }),
    )

    expect(result.results[0].status).toBe('passed')
    expect(userMessage(adapter, 2)).toEqual({
      requirements: criteria,
      evidence: {
        status: 'completed',
        timeline: [
          { kind: 'caller', said: 'Czy mam wysłać to zgłoszenie?' },
          { kind: 'tool_call', name: 'record', args: { days: 'pięć dni' } },
          { kind: 'tool_result', name: 'record', result: { recorded: true } },
          { kind: 'tool_call', name: 'reply', args: { text: 'Ŵyr a gŵr, ŷd.' } },
          { kind: 'agent', said: 'Ŵyr a gŵr, ŷd.' },
        ],
        finalState: { days: 'pięć dni' },
      },
    })
  })

  it('renders a Live run from joined transcript turns, tool use, callerHeard and status', async () => {
    const adapter = new MockAdapter({ responses: [{ text: verdict('Heard in full.', true) }] })
    const store = new InMemoryStore()
    const app = adk({
      name: 'judge',
      store,
      adapters: { openai: adapter },
      schema: { session: { outcome: z.string().optional() } },
    })
    const session = await app.sessions.create({ sessionId: 'live' })
    session.state.update({ outcome: 'engaged' })
    const base = { invocationId: 'inv', agentName: 'voice' }
    await sessionService(store).appendEvent(session, {
      ...base,
      id: 'call',
      type: 'tool_call',
      createdAt: 12_100,
      callId: 'c1',
      name: 'end_call',
      args: { reason: 'limit' },
    } satisfies Event)
    await sessionService(store).appendEvent(session, {
      ...base,
      id: 'result',
      type: 'tool_result',
      createdAt: 12_200,
      callId: 'c1',
      name: 'end_call',
      result: { ended: true },
    } satisfies Event)
    const run: VoiceRunResult = {
      status: 'max_duration',
      startedAtMs: 10_000,
      session,
      events: session.events,
      voiceEvents: [],
      transcript: [],
      liveTranscript: {
        callId: 'live',
        receivedThrough: 5,
        observations: [],
        fragments: [
          fragment(1, 'agent', 'Dzień dobry, ', 0, 900),
          fragment(2, 'agent', 'tu przychodnia.', 1_100, 2_000),
          fragment(3, 'agent', 'Czas rozmowy minął.', 3_500, 4_200),
          fragment(4, 'caller', 'Dobrze, dziękuję.', 4_500, 5_200),
          fragment(5, 'caller', ' Do widzenia.', 5_300, 5_800, 1),
        ],
      },
      callerHeard: [
        { text: 'Dzień dobry, tu przychodnia.', atMs: 2_300 },
        { text: 'Czas rozmowy minął.', atMs: 4_400 },
      ],
      timing: {
        responseTimes: [],
        silenceGaps: [],
        interruptions: { count: 0, byAgent: 0, byUser: 0 },
        vadResolutionMs: 0,
      },
      recording: { path: '/synthetic/recording.wav' },
      durationMs: 6_000,
    }

    const result = await app.evaluate
      .judge({ name: 'notice', criteria, model: openai('gpt-4o-mini') })
      .evaluate(run)

    expect(result.passed).toBe(true)
    expect(userMessage(adapter)).toEqual({
      requirements: criteria,
      evidence: {
        status: 'max_duration',
        timeline: [
          { kind: 'agent', said: 'Dzień dobry, tu przychodnia.', fromMs: 0, toMs: 2_000 },
          { kind: 'tool_call', name: 'end_call', args: { reason: 'limit' }, atMs: 2_100 },
          { kind: 'tool_result', name: 'end_call', result: { ended: true }, atMs: 2_200 },
          { kind: 'agent', said: 'Czas rozmowy minął.', fromMs: 3_500, toMs: 4_200 },
          { kind: 'caller', said: 'Dobrze, dziękuję.', fromMs: 4_500, toMs: 5_200 },
          { kind: 'caller', said: ' Do widzenia.', fromMs: 5_300, toMs: 5_800 },
        ],
        callerHeard: [
          { atMs: 2_300, text: 'Dzień dobry, tu przychodnia.' },
          { atMs: 4_400, text: 'Czas rozmowy minął.' },
        ],
        finalState: { outcome: 'engaged' },
      },
    })
    expect(voiceEvidence(run).callerHeard).toEqual([
      { text: 'Dzień dobry, tu przychodnia.', atMs: 2_300 },
      { text: 'Czas rozmowy minął.', atMs: 4_400 },
    ])
    expect(liveTranscriptTurns(run, { pauseMs: 2_000 }).map((turn) => turn.text)).toEqual([
      'Dzień dobry, tu przychodnia.Czas rozmowy minął.',
      'Dobrze, dziękuję.',
      ' Do widzenia.',
    ])
  })

  it('renders a Realtime run from transcript entries merged with tool use', async () => {
    const adapter = new MockAdapter({ responses: [{ text: verdict('Asked.', true) }] })
    const store = new InMemoryStore()
    const app = adk({ name: 'judge', store, adapters: { openai: adapter } })
    const session = await app.sessions.create({ sessionId: 'realtime' })
    const base = { invocationId: 'inv', agentName: 'voice', callId: 'c1', name: 'submit' }
    await sessionService(store).appendEvent(session, {
      ...base,
      id: 'call',
      type: 'tool_call',
      createdAt: 12_000,
      args: { consent: true },
    } satisfies Event)
    await sessionService(store).appendEvent(session, {
      ...base,
      id: 'result',
      type: 'tool_result',
      createdAt: 13_500,
      result: { sent: true },
    } satisfies Event)
    const run: VoiceRunResult = {
      status: 'completed',
      startedAtMs: 10_000,
      session,
      events: session.events,
      voiceEvents: [],
      transcript: [
        {
          role: 'assistant',
          text: 'Czy mam wysłać zgłoszenie?',
          startMs: 0,
          endMs: 900,
          turnIndex: 0,
        },
        { role: 'user', text: 'Tak, proszę.', startMs: 3_000, endMs: 3_400, turnIndex: 1 },
        { role: 'assistant', text: 'Ŵyr a gŵr.', turnIndex: 2 },
      ],
      timing: {
        responseTimes: [],
        silenceGaps: [],
        interruptions: { count: 0, byAgent: 0, byUser: 0 },
        vadResolutionMs: 0,
      },
      recording: { path: '/synthetic/recording.wav' },
      durationMs: 5_000,
    }

    await app.evaluate
      .judge({ name: 'consent', criteria, model: openai('gpt-4o-mini') })
      .evaluate(run)

    expect(userMessage(adapter)).toEqual({
      requirements: criteria,
      evidence: {
        status: 'completed',
        timeline: [
          { kind: 'agent', said: 'Czy mam wysłać zgłoszenie?', fromMs: 0, toMs: 900 },
          { kind: 'tool_call', name: 'submit', args: { consent: true }, atMs: 2_000 },
          { kind: 'caller', said: 'Tak, proszę.', fromMs: 3_000, toMs: 3_400 },
          { kind: 'agent', said: 'Ŵyr a gŵr.' },
          { kind: 'tool_result', name: 'submit', result: { sent: true }, atMs: 3_500 },
        ],
        finalState: {},
      },
    })
  })

  it('places an untimed Realtime reply at its receipt, after tool use that came first', async () => {
    const adapter = new MockAdapter({ responses: [{ text: verdict('Asked.', true) }] })
    const store = new InMemoryStore()
    const app = adk({ name: 'judge', store, adapters: { openai: adapter } })
    const session = await app.sessions.create({ sessionId: 'realtime-untimed' })
    await sessionService(store).appendEvent(session, {
      invocationId: 'inv',
      agentName: 'voice',
      callId: 'c1',
      name: 'submit',
      id: 'call',
      type: 'tool_call',
      createdAt: 12_000,
      args: { consent: true },
    } satisfies Event)
    const run: VoiceRunResult = {
      status: 'completed',
      startedAtMs: 10_000,
      session,
      events: session.events,
      voiceEvents: [],
      transcript: [
        { role: 'assistant', text: 'Wysłać?', startMs: 0, endMs: 900, turnIndex: 0 },
        { role: 'user', text: 'Tak.', endMs: 2_500, turnIndex: 1 },
      ],
      timing: {
        responseTimes: [],
        silenceGaps: [],
        interruptions: { count: 0, byAgent: 0, byUser: 0 },
        vadResolutionMs: 0,
      },
      recording: { path: '/synthetic/recording.wav' },
      durationMs: 3_000,
    }

    await app.evaluate
      .judge({ name: 'consent', criteria, model: openai('gpt-4o-mini') })
      .evaluate(run)

    expect(userMessage(adapter)).toMatchObject({
      evidence: {
        timeline: [
          { kind: 'agent', said: 'Wysłać?', fromMs: 0, toMs: 900 },
          { kind: 'tool_call', name: 'submit', args: { consent: true }, atMs: 2_000 },
          { kind: 'caller', said: 'Tak.', toMs: 2_500 },
        ],
      },
    })
  })

  it('makes the case an error when the verdict stays malformed after parse retries', async () => {
    const missing = { text: JSON.stringify({ other: { reason: 'Unrelated.', passed: true } }) }
    const { adapter, app, evalCase } = judged([missing, missing, missing])
    const result = await app.evaluate(evalCase)

    expect(result.results[0].status).toBe('error')
    expect(result.results[0].metrics.consent.error).toBe(
      'Failed to parse structured output at asks-to-send: Invalid input: expected object, received undefined',
    )
    expect(adapter.stepCalls).toHaveLength(3)
  })

  it('makes the case an error on a provider error, without retrying', async () => {
    const { adapter, app, evalCase } = judged([{ error: new Error('503') }])
    const result = await app.evaluate(evalCase)

    expect(result.results[0].status).toBe('error')
    expect(result.results[0].metrics.consent.error).toBe('503')
    expect(adapter.stepCalls).toHaveLength(1)
  })

  it('makes the case an error when the judge call times out', async () => {
    const adapter = new MockAdapter({ responses: [{ text: verdict('Late.', true), delayMs: 500 }] })
    const app = adk({ name: 'judge', adapters: { openai: adapter } })
    const result = await app.evaluate(
      app.evaluate.case({
        name: 'slow',
        input: 'Hello',
        runnable: app.step({ name: 'reply', execute: (ctx) => ctx.output('Hi') }),
        metrics: [app.evaluate.judge({ name: 'consent', criteria, timeoutMs: 20 })],
      }),
    )

    expect(result.results[0].status).toBe('error')
    expect(result.results[0].metrics.consent.error).toBe('Judge timed out after 20ms')
    expect(caseJudgeCost(result.results[0])).toEqual({ basis: 'unavailable' })
  })

  it('defaults to gpt-5.4-mini at low reasoning effort', async () => {
    const { adapter, app } = judged([{ text: verdict('Asked.', true) }])
    const run = await app.test(
      app.step({ name: 'reply', execute: (ctx) => ctx.output('Shall I send it?') }),
      { input: 'Hello' },
    )
    const result = await app.evaluate.judge({ name: 'consent', criteria }).evaluate(run)

    expect(adapter.stepCalls[0]!.config).toEqual({
      provider: 'openai',
      name: 'gpt-5.4-mini',
      reasoning: { effort: 'low' },
    })
    expect(result.data).toMatchObject({ model: 'gpt-5.4-mini' })
  })

  it('rejects a judge without criteria at construction', () => {
    const app = adk({ name: 'judge' })
    expect(() => app.evaluate.judge({ name: 'empty', criteria: {} })).toThrow(
      '[adk] Judge metric "empty" needs at least one criterion',
    )
  })
})

describe('judge cost', () => {
  it('adds the judge cost to the metric, the case, the suite total and report.md', async () => {
    useTestPricing()
    const adapter = new UsageReportingAdapter({ responses: [{ text: verdict('Asked.', true) }] })
    const app = adk({ name: 'judge', adapters: { openai: adapter } })
    const evalCase = app.evaluate.case({
      name: 'consent',
      input: 'Hello',
      runnable: app.step({ name: 'reply', execute: (ctx) => ctx.output('Shall I send it?') }),
      metrics: [app.evaluate.judge({ name: 'consent', criteria, model: openai('gpt-4o-mini') })],
    })
    const root = await mkdtemp(join(tmpdir(), 'adk-judge-cost-'))
    const argv = process.argv
    process.argv = [argv[0]!, 'judge-cost-eval', 'run', '--output', root]
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    let code: number
    try {
      code = await evalCli(app, [evalCase])
    } finally {
      process.argv = argv
      stdout.mockRestore()
      stderr.mockRestore()
    }

    expect(code).toBe(0)
    const [directory] = await readdir(root)
    const document = JSON.parse(await readFile(join(root, directory!, 'result.json'), 'utf8'))
    expect(document.results[0].metrics.consent.usage.cost).toEqual({
      inputCost: 0.15,
      outputCost: 0,
      totalCost: 0.15,
      currency: 'USD',
    })
    expect(document.results[0].judgeCost).toEqual({
      basis: 'reported',
      totalCost: 0.15,
      currency: 'USD',
    })
    expect(document.cost).toEqual({
      total: { basis: 'reported', totalCost: 0.15, currency: 'USD' },
      cases: { basis: 'reported', totalCost: 0, currency: 'USD' },
      judge: { basis: 'reported', totalCost: 0.15, currency: 'USD' },
    })
    const report = await readFile(join(root, directory!, 'report.md'), 'utf8')
    expect(report).toContain('**Tokens:** 1,000,000 in / 0 out')
    expect(report).toContain(
      '**Cost:** $0.1500 (reported) — cases $0.000000 (reported), judge $0.1500 (reported)',
    )
  })

  it("keeps a run's known cost when a metric errors", async () => {
    useTestPricing()
    const answer = { text: 'Shall I send it?' }
    const asked = { text: verdict('Asked.', true) }
    const adapter = new UsageReportingAdapter({ responses: [answer, asked, answer, asked] })
    const app = adk({ name: 'judge', adapters: { openai: adapter } })
    const reply = app.agent({ name: 'reply', model: openai('gpt-4o-mini'), context: [] })
    const consent = app.evaluate.judge({ name: 'consent', criteria, model: openai('gpt-4o-mini') })
    const broken = app.evaluate.metric({
      name: 'broken',
      evaluate: () => {
        throw new Error('No verdict possible')
      },
    })
    const result = await app.evaluate(
      [
        app.evaluate.case({ name: 'fine', input: 'Hello', runnable: reply, metrics: [consent] }),
        app.evaluate.case({
          name: 'broken',
          input: 'Hello',
          runnable: reply,
          metrics: [broken, consent],
        }),
      ],
      { concurrency: 1 },
    )

    expect(result.results.map((r) => r.status)).toEqual(['passed', 'error'])
    expect(generateReport(result)).toContain(
      '**Cost:** $0.6000 (reported) — cases $0.3000 (reported), judge $0.3000 (reported)',
    )
  })

  it('records what a failed judge spent, and the known part when a call went unrecorded', async () => {
    useTestPricing()
    const missing = { text: JSON.stringify({ other: { reason: 'Unrelated.', passed: true } }) }
    const adapter = new UsageReportingAdapter({
      responses: [missing, missing, missing, { error: new Error('503') }],
    })
    const app = adk({ name: 'judge', adapters: { openai: adapter } })
    const consent = app.evaluate.judge({ name: 'consent', criteria, model: openai('gpt-4o-mini') })
    const reply = app.step({ name: 'reply', execute: (ctx) => ctx.output('Shall I send it?') })
    const result = await app.evaluate(
      [
        app.evaluate.case({
          name: 'malformed',
          input: 'Hello',
          runnable: reply,
          metrics: [consent],
        }),
        app.evaluate.case({
          name: 'provider',
          input: 'Hello',
          runnable: reply,
          metrics: [consent],
        }),
      ],
      { concurrency: 1 },
    )

    expect(result.results.map((r) => r.status)).toEqual(['error', 'error'])
    expect(result.results.map((r) => r.metrics.consent.usage?.modelCalls)).toEqual([3, 1])
    expect(result.results.map(caseJudgeCost)).toEqual([
      { basis: 'reported', totalCost: 0.15 + 0.15 + 0.15, currency: 'USD' },
      { basis: 'unavailable' },
    ])
    expect(generateReport(result)).toContain(
      '**Cost:** unavailable ($0.4500 known across 1 of 2 cases) — cases $0.000000 (reported), judge unavailable',
    )
  })

  it('counts a malformed attempt that a parse retry recovered', async () => {
    useTestPricing()
    const adapter = new UsageReportingAdapter({
      responses: [{ text: 'not json' }, { text: verdict('Asked.', true) }],
    })
    const app = adk({ name: 'judge', adapters: { openai: adapter } })
    const run = await app.test(
      app.step({ name: 'reply', execute: (ctx) => ctx.output('Shall I send it?') }),
      { input: 'Hello' },
    )
    const result = await app.evaluate
      .judge({ name: 'consent', criteria, model: openai('gpt-4o-mini') })
      .evaluate(run)

    expect(result.passed).toBe(true)
    expect(result.usage?.modelCalls).toBe(2)
    expect(result.usage?.cost?.totalCost).toBe(0.3)
  })

  it('adds a judge component to a Live cost line', () => {
    const usage = summarizeModelUsage(
      [{ provider: 'openai', modelName: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 }],
      TEST_PRICING,
    )
    const reported = { basis: 'reported', totalCost: 0.15, currency: 'USD' } as const
    const free = { basis: 'reported', totalCost: 0, currency: 'USD' } as const
    const live = {
      name: 'live',
      status: 'passed' as const,
      durationMs: 1,
      metrics: { consent: { passed: true, usage } },
      run: {
        liveUsage: {
          backend: { cost: reported },
          voice: { modelName: 'gpt-live-1', seconds: 0, cost: free },
          caller: { cost: free },
          total: reported,
        },
      },
    }

    expect(
      generateReport({ summary: buildSummary([live]), durationMs: 1, results: [live] }),
    ).toContain(
      '**Cost:** $0.3000 (reported) — backend $0.1500 (reported), voice $0.000000 (reported), caller $0.000000 (reported), judge $0.1500 (reported)',
    )
  })
})
