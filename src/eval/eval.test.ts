import { z } from 'zod'

import type { AdkApp } from '../api'
import type { SimulateOptions } from '../run/simulate'
import type { ToolResultEvent } from '../types'
import type { Runnable } from '../types/runnables'
import type { RunResult } from '../types/runtime'
import type { StateSchema } from '../types/schema'

import { agent, sequence } from '../agents'
import { adk } from '../api'
import { injectSystemMessage, includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { MockAdapter } from '../testing'

const app = adk()
import type { Hook } from '../hook/types'
import type { Event } from '../types'
import type { ReportOptions } from './report'
import type { EvalResult, EvalCaseResult, EvalOptions, EvalCase } from './types'

import { EvalToolError } from './errors'
import {
  interceptTools,
  withStateChange,
  unwrapStateChange,
  collectStateChanges,
  stateMetric,
  eventCountMetric,
  eventSequenceMetric,
  timingMetric,
  isStateChangeResult,
} from './index'
import { generateReport as report } from './report'
import { createEvalSession } from './session'
import { evaluate } from './simulator'

function minimalOutputToolCtx(args: unknown = {}) {
  return {
    callId: 'c1',
    toolName: 'end_call',
    invocationId: 'inv_1',
    args,
    state: {},
    voice: undefined,
    output: (v: unknown) => v,
    end: () => ({}),
    run: async () => ({}),
  } as any
}

describe('interceptTools', () => {
  describe('tool interception', () => {
    it('should throw for unmocked tools by default', async () => {
      const unmockedTool = app.tool({
        name: 'unmocked_tool',
        description: 'A tool without a mock',
        schema: z.object({ input: z.string() }),
        execute: () => ({ result: 'real' }),
      })

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [unmockedTool],
      })

      const intercepted = interceptTools(testAgent, {})

      const mockAdapter = new MockAdapter({
        responses: [
          {
            toolCalls: [{ name: 'unmocked_tool', args: { input: 'test' } }],
          },
          { text: 'Done' },
        ],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = new BaseSession('test', { id: 'test-1' })
      session.input.message('Hello')

      await runner.run(intercepted, session)

      const toolResult = session.events.find((e): e is ToolResultEvent => e.type === 'tool_result')
      expect(toolResult).toBeDefined()
      expect(toolResult!.error).toContain('unmocked_tool')
      expect(toolResult!.error).toContain('no mock was provided')
    })

    it('should use mock execute when provided', async () => {
      const mockedTool = app.tool({
        name: 'mocked_tool',
        description: 'A tool with a mock',
        schema: z.object({ input: z.string() }),
        execute: () => ({ result: 'real' }),
      })

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [mockedTool],
      })

      const intercepted = interceptTools(testAgent, {
        mocked_tool: { execute: () => ({ result: 'mocked' }) },
      })

      const mockAdapter = new MockAdapter({
        responses: [
          {
            toolCalls: [{ name: 'mocked_tool', args: { input: 'test' } }],
          },
          { text: 'Done' },
        ],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = new BaseSession('test', { id: 'test-2' })
      session.input.message('Hello')

      await runner.run(intercepted, session)

      const toolResult = session.events.find((e): e is ToolResultEvent => e.type === 'tool_result')
      expect(toolResult).toBeDefined()
      expect(toolResult!.result).toEqual({ result: 'mocked' })
    })

    it('should allow real tool passthrough when tool is provided', async () => {
      const realTool = app.tool({
        name: 'real_tool',
        description: 'A real tool',
        schema: z.object({ input: z.string() }),
        execute: (ctx) => ({ echoed: ctx.args.input }),
      })

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [realTool],
      })

      const intercepted = interceptTools(testAgent, {
        real_tool: realTool,
      })

      const mockAdapter = new MockAdapter({
        responses: [
          {
            toolCalls: [{ name: 'real_tool', args: { input: 'passthrough' } }],
          },
          { text: 'Done' },
        ],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = new BaseSession('test', { id: 'test-3' })
      session.input.message('Hello')

      await runner.run(intercepted, session)

      const toolResult = session.events.find((e): e is ToolResultEvent => e.type === 'tool_result')
      expect(toolResult).toBeDefined()
      expect(toolResult!.result).toEqual({ echoed: 'passthrough' })
    })

    it('should allow passthrough when strict is false', async () => {
      const passthroughTool = app.tool({
        name: 'passthrough_tool',
        description: 'A tool that will passthrough',
        schema: z.object({ input: z.string() }),
        execute: (ctx) => ({ echoed: ctx.args.input, source: 'original' }),
      })

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [passthroughTool],
      })

      const intercepted = interceptTools(testAgent, {}, { strict: false })

      const mockAdapter = new MockAdapter({
        responses: [
          {
            toolCalls: [{ name: 'passthrough_tool', args: { input: 'passthrough_test' } }],
          },
          { text: 'Done' },
        ],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = new BaseSession('test', { id: 'test-4' })
      session.input.message('Hello')

      await runner.run(intercepted, session)

      const toolResult = session.events.find((e): e is ToolResultEvent => e.type === 'tool_result')
      expect(toolResult).toBeDefined()
      expect(toolResult!.result).toEqual({
        echoed: 'passthrough_test',
        source: 'original',
      })
    })
  })

  describe('output tool interception', () => {
    it('should throw for unmocked output tool by default', async () => {
      const outputTool = app.tool({
        name: 'end_call',
        description: 'End the call',
        schema: z.object({ summary: z.string() }),
        execute: () => {},
      })

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [],
        output: outputTool,
      })

      const intercepted = interceptTools(testAgent, {}) as any

      await expect(
        intercepted.output.execute(minimalOutputToolCtx({ summary: 'test' })),
      ).rejects.toThrow(EvalToolError)
    })

    it('should use mock execute for output tool', async () => {
      const outputTool = app.tool({
        name: 'end_call',
        description: 'End the call',
        schema: z.object({ summary: z.string() }),
        execute: () => ({ original: true }),
      })

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [],
        output: outputTool,
      })

      const intercepted = interceptTools(testAgent, {
        end_call: { execute: (args: any) => ({ mocked: true, summary: args.summary }) },
      }) as any

      const result = await intercepted.output.execute(minimalOutputToolCtx({ summary: 'done' }))
      expect(result).toEqual({ mocked: true, summary: 'done' })
    })

    it('should allow real tool passthrough for output tool', async () => {
      const outputTool = app.tool({
        name: 'end_call',
        description: 'End the call',
        schema: z.object({ summary: z.string() }),
        execute: (ctx) => ({ echoed: ctx.args.summary }),
      })

      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [],
        output: outputTool,
      })

      const intercepted = interceptTools(testAgent, {
        end_call: outputTool,
      }) as any

      const result = await intercepted.output.execute(
        minimalOutputToolCtx({ summary: 'passthrough' }),
      )
      expect(result).toEqual({ echoed: 'passthrough' })
    })

    it('should not intercept non-tool output config', () => {
      const testAgent = agent({
        name: 'test_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [],
        output: { schema: z.object({ result: z.string() }), mode: 'native' as const },
      })

      const intercepted = interceptTools(testAgent, {}) as any
      expect(intercepted.output).toEqual({
        schema: expect.any(Object),
        mode: 'native',
      })
    })
  })

  describe('nested runnables', () => {
    it('should intercept tools in sequence', async () => {
      const testTool = app.tool({
        name: 'seq_tool',
        description: 'Tool in sequence',
        schema: z.object({ x: z.number() }),
        execute: () => ({ original: true }),
      })

      const testAgent = agent({
        name: 'seq_agent',
        model: openai('gpt-4o-mini'),
        context: [injectSystemMessage('Test'), includeHistory()],
        tools: [testTool],
      })

      const testSequence = sequence({
        name: 'test_seq',
        runnables: [testAgent],
      })

      const intercepted = interceptTools(testSequence, {
        seq_tool: { execute: () => ({ mocked: true }) },
      })

      const mockAdapter = new MockAdapter({
        responses: [{ toolCalls: [{ name: 'seq_tool', args: { x: 1 } }] }, { text: 'Done' }],
      })

      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })

      const session = new BaseSession('test', { id: 'test-5' })
      session.input.message('Hello')

      await runner.run(intercepted, session)

      const toolResult = session.events.find((e): e is ToolResultEvent => e.type === 'tool_result')
      expect(toolResult?.result).toEqual({ mocked: true })
    })
  })
})

describe('createEvalSession', () => {
  it('should create a fresh session', () => {
    const session = createEvalSession()
    expect(session).toBeDefined()
    expect(session.id).toContain('eval-')
  })
})

describe('withStateChange', () => {
  it('should wrap result with state changes', () => {
    const result = withStateChange({ data: 'test' }, { session: { key: 'value' } })

    expect(isStateChangeResult(result)).toBe(true)
    expect(result.result).toEqual({ data: 'test' })
    expect(result.stateChanges).toEqual({ session: { key: 'value' } })
  })
})

function runResultWithEvents(events: Event[]): RunResult {
  const session = new BaseSession('eval', { id: 'eval-test' })
  for (const e of events) (session.events as Event[]).push(e)
  return {
    runnable: {} as Runnable<any>,
    session,
    state: session.state,
    iterations: 1,
    output: { text: 'done', items: [] },
    status: 'completed' as const,
  }
}

describe('metrics', () => {
  describe('stateMetric', () => {
    it('should evaluate final state value', async () => {
      const events = [
        {
          type: 'state_change' as const,
          scope: 'session' as const,
          changes: [{ key: 'count', oldValue: undefined, newValue: 1 }],
        },
        {
          type: 'state_change' as const,
          scope: 'session' as const,
          changes: [{ key: 'count', oldValue: 1, newValue: 2 }],
        },
      ] as Event[]

      const metric = stateMetric({
        name: 'count_check',
        scope: 'session',
        key: 'count',
        assertion: (v) => v === 2,
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(true)
    })
  })

  describe('eventCountMetric', () => {
    it('should count matching events', async () => {
      const events = [
        { type: 'tool_call', name: 'ask' },
        { type: 'tool_call', name: 'ask' },
        { type: 'tool_call', name: 'other' },
      ] as Event[]

      const metric = eventCountMetric({
        name: 'ask_count',
        eventType: 'tool_call',
        filter: (e) => (e as { name?: string }).name === 'ask',
        assertion: (count) => count <= 3,
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(true)
    })
  })
})

describe('state change helpers', () => {
  describe('unwrapStateChange', () => {
    it('should unwrap state change result', () => {
      const wrapped = withStateChange({ data: 'test' }, { session: { key: 'value' } })
      expect(unwrapStateChange(wrapped)).toEqual({ data: 'test' })
    })

    it('should return non-wrapped values unchanged', () => {
      const plain = { data: 'test' }
      expect(unwrapStateChange(plain)).toEqual({ data: 'test' })
    })
  })

  describe('collectStateChanges', () => {
    it('should collect state changes from multiple results', () => {
      const results = [
        withStateChange({ a: 1 }, { session: { key1: 'val1' } }),
        { plainResult: true },
        withStateChange({ b: 2 }, { patient: { condition: 'hypertension' } }),
        withStateChange({ c: 3 }, { session: { key2: 'val2' }, user: { pref: 'dark' } }),
      ]

      const collected = collectStateChanges(results)

      expect(collected.session).toEqual({ key1: 'val1', key2: 'val2' })
      expect(collected.patient).toEqual({ condition: 'hypertension' })
      expect(collected.user).toEqual({ pref: 'dark' })
    })

    it('should return empty object when no state changes', () => {
      const results = [{ plain: 1 }, { plain: 2 }]
      expect(collectStateChanges(results)).toEqual({})
    })
  })

  describe('isStateChangeResult', () => {
    it('should return false for plain objects', () => {
      expect(isStateChangeResult({ data: 'test' })).toBe(false)
      expect(isStateChangeResult(null)).toBe(false)
      expect(isStateChangeResult(undefined)).toBe(false)
      expect(isStateChangeResult('string')).toBe(false)
    })
  })
})

describe('EvalToolError', () => {
  it('should include tool name and args in message', () => {
    const error = new EvalToolError('searchPatients', { query: 'test' })
    expect(error.message).toContain('searchPatients')
    expect(error.message).toContain('no mock was provided')
    expect(error.toolName).toBe('searchPatients')
  })
})

describe('additional metrics', () => {
  describe('stateMetric', () => {
    it('should return passed: false when assertion fails', async () => {
      const events = [
        {
          type: 'state_change' as const,
          scope: 'session' as const,
          changes: [{ key: 'status', oldValue: undefined, newValue: 'pending' }],
        },
      ] as Event[]

      const metric = stateMetric({
        name: 'completed_check',
        scope: 'session',
        key: 'status',
        assertion: (v) => v === 'completed',
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(false)
    })

    it('should handle undefined state values', async () => {
      const events: Event[] = []

      const metric = stateMetric({
        name: 'missing_key',
        scope: 'session',
        key: 'nonexistent',
        assertion: (v) => v === undefined,
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(true)
    })
  })

  describe('eventSequenceMetric', () => {
    it('should verify event sequence exists', async () => {
      const events = [
        { type: 'user', text: 'hello' },
        { type: 'tool_call', name: 'greet' },
        { type: 'tool_result', name: 'greet' },
        { type: 'assistant', text: 'hi' },
      ] as Event[]

      const metric = eventSequenceMetric({
        name: 'greeting_flow',
        sequence: [
          { eventType: 'user' },
          {
            eventType: 'tool_call',
            filter: (e) => (e as { name?: string }).name === 'greet',
          },
          { eventType: 'assistant' },
        ],
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(true)
    })

    it('should fail when sequence is incomplete', async () => {
      const events = [
        { type: 'user', text: 'hello' },
        { type: 'assistant', text: 'hi' },
      ] as Event[]

      const metric = eventSequenceMetric({
        name: 'missing_tool',
        sequence: [{ eventType: 'user' }, { eventType: 'tool_call' }, { eventType: 'assistant' }],
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(false)
    })
  })
})

describe('timing metrics', () => {
  describe('timingMetric', () => {
    it('should compute total duration from events', async () => {
      const now = Date.now()
      const events = [
        { type: 'invocation_start', createdAt: now },
        { type: 'user', text: 'hello', createdAt: now + 10 },
        { type: 'assistant', text: 'hi', createdAt: now + 100 },
        { type: 'invocation_end', createdAt: now + 200 },
      ] as Event[]

      const metric = timingMetric({
        name: 'duration_test',
        measure: 'total_duration',
        assertion: (ms) => ms <= 300,
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(true)
    })

    it('should compute model latency average', async () => {
      const events = [
        { type: 'model_start', createdAt: 0 },
        { type: 'model_end', createdAt: 100, durationMs: 100 },
        { type: 'model_start', createdAt: 200 },
        { type: 'model_end', createdAt: 350, durationMs: 150 },
      ] as Event[]

      const metric = timingMetric({
        name: 'latency_test',
        measure: 'model_latency_average',
        assertion: (avg) => avg <= 150,
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(true)
    })

    it('should return failed when no timestamp data', async () => {
      const events = [
        { type: 'user', text: 'hello' },
        { type: 'assistant', text: 'hi' },
      ] as Event[]

      const metric = timingMetric({
        name: 'missing_data',
        measure: 'total_duration',
        assertion: () => true,
      })

      const result = await metric.evaluate(runResultWithEvents(events))
      expect(result.passed).toBe(false)
      expect(result.evidence?.[0]).toContain('missing timestamp data')
    })
  })

  describe('timingMetric total_duration', () => {
    it('should check if total duration is within limit', async () => {
      const now = Date.now()
      const events = [
        { type: 'invocation_start', createdAt: now },
        { type: 'invocation_end', createdAt: now + 500 },
      ] as Event[]

      const passingMetric = timingMetric({
        name: 'passing_duration',
        measure: 'total_duration',
        assertion: (ms) => ms <= 1000,
      })

      const failingMetric = timingMetric({
        name: 'failing_duration',
        measure: 'total_duration',
        assertion: (ms) => ms <= 100,
      })

      const run = runResultWithEvents(events)
      const passingResult = await passingMetric.evaluate(run)
      const failingResult = await failingMetric.evaluate(run)

      expect(passingResult.passed).toBe(true)
      expect(failingResult.passed).toBe(false)
    })
  })
})

describe('evaluate', () => {
  function mockApp(
    simulateImpl: (runnable: Runnable<any>, opts: SimulateOptions) => Promise<RunResult>,
  ): AdkApp<StateSchema> {
    const evalFn = Object.assign(
      (
        caseOrCases: EvalCase | EvalCase[],
        options?: EvalOptions,
      ): Promise<EvalResult<StateSchema>> => {
        return evaluate(app as AdkApp<StateSchema>, caseOrCases, options)
      },
      {
        report(options?: ReportOptions<StateSchema>) {
          return (result: EvalResult<StateSchema>): string => report(result, options)
        },
      },
    )
    const mockEvalApp = {
      simulate: simulateImpl,
      evaluate: evalFn,
    }
    return mockEvalApp as AdkApp<StateSchema>
  }

  const completedResult = (events: Event[] = []): RunResult => {
    const session = new BaseSession('eval', { id: 'eval-test' })
    for (const e of events) (session.events as Event[]).push(e)
    return {
      runnable: {} as Runnable<any>,
      session,
      state: session.state,
      iterations: 1,
      usage: {
        models: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        totalReasoningTokens: 0,
        totalAudioInputTokens: 0,
        totalAudioOutputTokens: 0,
        modelCalls: 0,
      },
      output: { text: 'done', items: [] },
      status: 'completed' as const,
    }
  }

  const simpleAgent = () =>
    agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

  it('should run a single eval case', async () => {
    const fakeApp = mockApp(async () => completedResult())

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'single-case',
      runnable: testAgent,
    })

    expect(result.summary.total).toBe(1)
    expect(result.results[0].name).toBe('single-case')
    expect(result.results[0].status).toBe('passed')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('should run a suite of eval cases', async () => {
    const fakeApp = mockApp(async () => completedResult())

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, [
      { name: 'case-1', runnable: testAgent },
      { name: 'case-2', runnable: testAgent },
    ])

    expect(result.summary.total).toBe(2)
    expect(result.summary.passed).toBe(2)
    expect(result.results).toHaveLength(2)
    expect(result.results[0].name).toBe('case-1')
    expect(result.results[1].name).toBe('case-2')
  })

  it('should pass hooks through to simulate', async () => {
    let receivedHooks: Hook<any>[] | undefined
    const fakeApp = mockApp(async (_runnable, opts) => {
      receivedHooks = opts.hooks
      return completedResult()
    })

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const hook = { beforeAgent: () => 'short-circuit' }
    await evaluate(fakeApp, { name: 'hooks-test', runnable: testAgent }, { hooks: [hook] })

    expect(receivedHooks).toEqual([hook])
  })

  it('should evaluate metrics on events', async () => {
    const events = [
      {
        type: 'state_change' as const,
        scope: 'session' as const,
        changes: [{ key: 'done', oldValue: undefined, newValue: true }],
      },
    ] as Event[]
    const fakeApp = mockApp(async () => completedResult(events))

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'metrics-test',
      runnable: testAgent,
      metrics: [
        stateMetric({
          name: 'done_check',
          scope: 'session',
          key: 'done',
          assertion: (v) => v === true,
        }),
      ],
    })

    expect(result.results[0].status).toBe('passed')
    expect(result.results[0].metrics.done_check.passed).toBe(true)
  })

  it('should report failed status when metrics fail', async () => {
    const fakeApp = mockApp(async () => completedResult())

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'fail-test',
      runnable: testAgent,
      metrics: [
        stateMetric({
          name: 'missing_state',
          scope: 'session',
          key: 'expected',
          assertion: (v) => v === 'present',
        }),
      ],
    })

    expect(result.results[0].status).toBe('failed')
    expect(result.results[0].metrics.missing_state.passed).toBe(false)
  })

  it('should support stopOnFirstFailure for suites', async () => {
    let callCount = 0
    const fakeApp = mockApp(async () => {
      callCount++
      return completedResult()
    })

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const failingMetric = {
      name: 'always_fails',
      evaluate: async () => ({ passed: false, evidence: ['forced failure'] }),
    }

    const result = await evaluate(
      fakeApp,
      [
        { name: 'case-1', runnable: testAgent, metrics: [failingMetric] },
        { name: 'case-2', runnable: testAgent },
        { name: 'case-3', runnable: testAgent },
      ],
      { stopOnFirstFailure: true, concurrency: 1 },
    )

    expect(result.results).toHaveLength(1)
    expect(result.results[0].status).toBe('failed')
    expect(callCount).toBe(1)
  })

  it('should handle errors from simulate', async () => {
    const fakeApp = mockApp(async () => {
      throw new Error('simulate exploded')
    })

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'error-test',
      runnable: testAgent,
    })

    expect(result.results[0].status).toBe('error')
    expect(result.results[0].error?.message).toContain('simulate exploded')
  })

  it('should apply suite-level metrics to all cases', async () => {
    const events = [
      {
        type: 'state_change' as const,
        scope: 'session' as const,
        changes: [{ key: 'done', oldValue: undefined, newValue: true }],
      },
    ] as Event[]
    const fakeApp = mockApp(async () => completedResult(events))

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const suiteMetric = stateMetric({
      name: 'suite_done',
      scope: 'session',
      key: 'done',
      assertion: (v) => v === true,
    })

    const result = await evaluate(
      fakeApp,
      [
        { name: 'case-1', runnable: testAgent },
        { name: 'case-2', runnable: testAgent },
      ],
      { metrics: [suiteMetric], concurrency: 1 },
    )

    expect(result.results[0].metrics.suite_done).toBeDefined()
    expect(result.results[0].metrics.suite_done.passed).toBe(true)
    expect(result.results[1].metrics.suite_done).toBeDefined()
    expect(result.results[1].metrics.suite_done.passed).toBe(true)
  })

  it('should merge suite-level and case-level metrics', async () => {
    const events = [
      {
        type: 'state_change' as const,
        scope: 'session' as const,
        changes: [
          { key: 'done', oldValue: undefined, newValue: true },
          { key: 'level', oldValue: undefined, newValue: 'urgent' },
        ],
      },
    ] as Event[]
    const fakeApp = mockApp(async () => completedResult(events))

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const suiteMetric = stateMetric({
      name: 'suite_done',
      scope: 'session',
      key: 'done',
      assertion: (v) => v === true,
    })

    const caseMetric = stateMetric({
      name: 'level_check',
      scope: 'session',
      key: 'level',
      assertion: (v) => v === 'urgent',
    })

    const result = await evaluate(
      fakeApp,
      [{ name: 'case-1', runnable: testAgent, metrics: [caseMetric] }],
      { metrics: [suiteMetric], concurrency: 1 },
    )

    expect(result.results[0].metrics.suite_done).toBeDefined()
    expect(result.results[0].metrics.suite_done.passed).toBe(true)
    expect(result.results[0].metrics.level_check).toBeDefined()
    expect(result.results[0].metrics.level_check.passed).toBe(true)
  })

  it('should map aborted run status to aborted eval status', async () => {
    const fakeApp = mockApp(async () => {
      const session = new BaseSession('eval', { id: 'eval-test' })
      return {
        runnable: {} as Runnable<any>,
        session,
        state: session.state,
        iterations: 1,
        output: { text: undefined, items: [] },
        status: 'aborted' as const,
      }
    })

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'aborted-test',
      runnable: testAgent,
    })

    expect(result.results[0].status).toBe('aborted')
    expect(result.summary.aborted).toBe(1)
  })

  it('should retry failed cases when retries is set', async () => {
    let callCount = 0
    const fakeApp = mockApp(async () => {
      callCount++
      return completedResult()
    })

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const failingMetric = {
      name: 'always_fails',
      evaluate: async () => ({ passed: false, evidence: ['nope'] }),
    }

    const result = await evaluate(fakeApp, {
      name: 'retry-test',
      runnable: testAgent,
      metrics: [failingMetric],
      retries: 2,
    })

    expect(callCount).toBe(3)
    expect(result.results[0].status).toBe('failed')
    expect(result.results[0].attempts).toBe(3)
  })

  it('should not retry when case passes on first attempt', async () => {
    let callCount = 0
    const fakeApp = mockApp(async () => {
      callCount++
      return completedResult()
    })

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'no-retry-test',
      runnable: testAgent,
      retries: 2,
    })

    expect(callCount).toBe(1)
    expect(result.results[0].status).toBe('passed')
    expect(result.results[0].attempts).toBe(1)
  })

  it('should timeout when case exceeds timeout', async () => {
    const fakeApp = mockApp(async () => {
      await new Promise((r) => setTimeout(r, 500))
      return completedResult()
    })

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'timeout-test',
      runnable: testAgent,
      timeout: 50,
    })

    expect(result.results[0].status).toBe('timeout')
    expect(result.results[0].error?.message).toContain('timed out')
    expect(result.summary.timedOut).toBe(1)
  })

  it('should call onCaseComplete for each case', async () => {
    const fakeApp = mockApp(async () => completedResult())

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const completed: Array<{ name: string; index: number; total: number }> = []

    await evaluate(
      fakeApp,
      [
        { name: 'case-1', runnable: testAgent },
        { name: 'case-2', runnable: testAgent },
      ],
      {
        concurrency: 1,
        onCase: (result, index, total) => {
          completed.push({ name: result.name, index, total })
        },
      },
    )

    expect(completed).toHaveLength(2)
    expect(completed[0]).toEqual({ name: 'case-1', index: 1, total: 2 })
    expect(completed[1]).toEqual({ name: 'case-2', index: 2, total: 2 })
  })

  it('should expose run on each result', async () => {
    const events = [
      {
        type: 'state_change' as const,
        scope: 'session' as const,
        changes: [{ key: 'x', oldValue: undefined, newValue: 42 }],
      },
    ] as Event[]
    const fakeApp = mockApp(async () => completedResult(events))

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-5-mini'),
      context: [includeHistory()],
    })

    const result = await evaluate(fakeApp, {
      name: 'run-check',
      runnable: testAgent,
    })

    expect(result.results[0].run).toBeDefined()
    expect(result.results[0].run.session.events).toHaveLength(1)
    expect(result.results[0].run.status).toBe('completed')
  })

  it('should repeat each case N times with metadata', async () => {
    let callCount = 0
    const fakeApp = mockApp(async () => {
      callCount++
      return completedResult()
    })

    const testAgent = simpleAgent()

    const result = await evaluate(
      fakeApp,
      [
        { name: 'case-a', runnable: testAgent },
        { name: 'case-b', runnable: testAgent },
      ],
      { repeat: 3, concurrency: 1 },
    )

    expect(callCount).toBe(6)
    expect(result.summary.total).toBe(6)
    expect(result.results).toHaveLength(6)

    const caseAResults = result.results.filter((r) => r.name === 'case-a')
    expect(caseAResults).toHaveLength(3)
    expect(caseAResults[0].repeatIndex).toBe(1)
    expect(caseAResults[0].repeatTotal).toBe(3)
    expect(caseAResults[2].repeatIndex).toBe(3)
  })

  it('should have correct counts with repeat and failing metric', async () => {
    let callCount = 0
    const fakeApp = mockApp(async () => {
      callCount++
      return completedResult()
    })

    const testAgent = simpleAgent()

    const failingMetric = {
      name: 'always_fails',
      evaluate: async () => ({ passed: false, evidence: ['nope'] }),
    }

    const result = await evaluate(
      fakeApp,
      [{ name: 'flaky', runnable: testAgent, metrics: [failingMetric] }],
      { repeat: 3, concurrency: 1 },
    )

    expect(callCount).toBe(3)
    expect(result.summary.total).toBe(3)
    expect(result.summary.failed).toBe(3)
    expect(result.results.every((r) => r.repeatIndex != null)).toBe(true)
  })

  it('should not set repeat metadata without repeat option', async () => {
    const fakeApp = mockApp(async () => completedResult())

    const result = await evaluate(fakeApp, {
      name: 'no-repeat',
      runnable: simpleAgent(),
    })

    expect(result.results[0].repeatIndex).toBeUndefined()
    expect(result.results[0].repeatTotal).toBeUndefined()
  })

  it('should treat repeat: 1 the same as no repeat option', async () => {
    const fakeApp = mockApp(async () => completedResult())

    const result = await evaluate(fakeApp, [{ name: 'single', runnable: simpleAgent() }], {
      repeat: 1,
      concurrency: 1,
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0].repeatIndex).toBeUndefined()
    expect(result.results[0].repeatTotal).toBeUndefined()
  })

  it('should stop early with repeat and stopOnFirstFailure', async () => {
    let callCount = 0
    const fakeApp = mockApp(async () => {
      callCount++
      return completedResult()
    })

    const testAgent = simpleAgent()

    const failingMetric = {
      name: 'always_fails',
      evaluate: async () => ({ passed: false, evidence: ['nope'] }),
    }

    const result = await evaluate(
      fakeApp,
      [
        { name: 'case-a', runnable: testAgent, metrics: [failingMetric] },
        { name: 'case-b', runnable: testAgent },
      ],
      { repeat: 3, stopOnFirstFailure: true, concurrency: 1 },
    )

    // First run of case-a fails, so we stop — only 1 result
    expect(callCount).toBe(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('case-a')
    expect(result.results[0].status).toBe('failed')
  })
})

describe('report', () => {
  function minimalResult(
    overrides: Partial<{
      total: number
      passed: number
      failed: number
      errors: number
      terminated: number
      aborted: number
      timedOut: number
    }> = {},
  ): EvalResult<StateSchema> {
    const session = new BaseSession('eval', { id: 'r' })
    const runA: RunResult = {
      runnable: {} as Runnable<any>,
      session,
      state: session.state,
      iterations: 1,
      output: { text: 'ok', items: [] },
      status: 'completed',
    }
    const runB: RunResult = {
      ...runA,
      output: { text: 'nope', items: [] },
    }
    const results: EvalCaseResult<StateSchema>[] = [
      {
        name: 'case-a',
        status: 'passed',
        metrics: { m1: { passed: true } },
        run: runA,
        events: runA.session.events,
        usage: runA.usage,
        turns: 0,
        durationMs: 100,
      },
      {
        name: 'case-b',
        status: 'failed',
        metrics: { m1: { passed: false, evidence: ['expected 2, got 1'] } },
        run: runB,
        events: runB.session.events,
        usage: runB.usage,
        turns: 0,
        durationMs: 200,
      },
    ]
    return {
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        errors: 0,
        terminated: 0,
        aborted: 0,
        timedOut: 0,
        ...overrides,
      },
      results,
      durationMs: 300,
    }
  }

  it('should include summary and metrics', () => {
    const result = minimalResult()
    const md = report(result)
    expect(md).toContain('# Eval Report')
    expect(md).toContain('**Pass Rate:** 50.000% (1/2)')
    expect(md).toContain('**Failed:** 1')
    expect(md).toContain('## Metrics')
    expect(md).toContain('## Cases')
  })

  it('should render failures with evidence by default', () => {
    const result = minimalResult()
    const md = report(result)
    expect(md).toContain('case-b')
    expect(md).toContain('failed')
    expect(md).toContain('expected 2, got 1')
  })

  it('should accept title and footer options', () => {
    const result = minimalResult()
    const md = report(result, {
      title: 'My Eval',
      footer: 'n=2',
    })
    expect(md).toContain('# My Eval')
    expect(md).toContain('_n=2_')
  })

  it('should accept footer as function', () => {
    const result = minimalResult()
    const md = report(result, {
      footer: (r) => `total=${r.summary.total}`,
    })
    expect(md).toContain('_total=2_')
  })

  it('should include custom sections', () => {
    const result = minimalResult()
    const md = report(result, {
      sections: [{ title: 'Custom', content: (r) => `Passed: ${r.summary.passed}` }],
    })
    expect(md).toContain('## Custom')
    expect(md).toContain('Passed: 1')
  })

  it('should show all-passed message when no failures', () => {
    const session = new BaseSession('eval', { id: 'r' })
    const run: RunResult = {
      runnable: {} as Runnable<any>,
      session,
      state: session.state,
      iterations: 1,
      output: { text: 'ok', items: [] },
      status: 'completed',
    }
    const result: EvalResult<StateSchema> = {
      summary: {
        total: 2,
        passed: 2,
        failed: 0,
        errors: 0,
        terminated: 0,
        aborted: 0,
        timedOut: 0,
      },
      results: [
        {
          name: 'a',
          status: 'passed',
          metrics: {},
          run,
          events: run.session.events,
          usage: run.usage,
          turns: 0,
          durationMs: 50,
        },
        {
          name: 'b',
          status: 'passed',
          metrics: {},
          run,
          events: run.session.events,
          usage: run.usage,
          turns: 0,
          durationMs: 60,
        },
      ],
      durationMs: 110,
    }
    const md = report(result)
    expect(md).toContain('All 2 cases passed.')
    expect(md).not.toContain('###')
  })

  it('should call renderCase when provided', () => {
    const result = minimalResult()
    const md = report(result, {
      renderCase: (r) => `### ${r.name}: ${r.status}`,
    })
    expect(md).toContain('### case-a: passed')
    expect(md).toContain('### case-b: failed')
  })

  it('should group repeated cases with aggregate stats', () => {
    const session = new BaseSession('eval', { id: 'r' })
    const run: RunResult = {
      runnable: {} as Runnable<any>,
      session,
      state: session.state,
      iterations: 1,
      output: { text: 'ok', items: [] },
      status: 'completed',
    }

    const results: EvalCaseResult<StateSchema>[] = [
      {
        name: 'greet',
        status: 'passed',
        metrics: { m1: { passed: true } },
        run,
        events: [],
        usage: run.usage,
        turns: 0,
        durationMs: 100,
        repeatIndex: 1,
        repeatTotal: 3,
      },
      {
        name: 'greet',
        status: 'failed',
        metrics: { m1: { passed: false, evidence: ['wrong'] } },
        run,
        events: [],
        usage: run.usage,
        turns: 0,
        durationMs: 200,
        repeatIndex: 2,
        repeatTotal: 3,
      },
      {
        name: 'greet',
        status: 'passed',
        metrics: { m1: { passed: true } },
        run,
        events: [],
        usage: run.usage,
        turns: 0,
        durationMs: 150,
        repeatIndex: 3,
        repeatTotal: 3,
      },
    ]

    const evalResult: EvalResult<StateSchema> = {
      summary: {
        total: 3,
        passed: 2,
        failed: 1,
        errors: 0,
        terminated: 0,
        aborted: 0,
        timedOut: 0,
      },
      results,
      durationMs: 450,
    }

    const md = report(evalResult)
    expect(md).toContain('### greet — MIXED (2/3, 66.7%)')
    expect(md).toContain('mean=150ms')
    expect(md).toContain('min=100ms')
    expect(md).toContain('max=200ms')
    expect(md).toContain('**m1:** 2/3 passed')
    expect(md).toContain('run 2 (failed)')
  })

  it('should show PASS for all-passing repeated cases', () => {
    const session = new BaseSession('eval', { id: 'r' })
    const run: RunResult = {
      runnable: {} as Runnable<any>,
      session,
      state: session.state,
      iterations: 1,
      output: { text: 'ok', items: [] },
      status: 'completed',
    }

    const results: EvalCaseResult<StateSchema>[] = [
      {
        name: 'task',
        status: 'passed',
        metrics: {},
        run,
        events: [],
        usage: run.usage,
        turns: 0,
        durationMs: 80,
        repeatIndex: 1,
        repeatTotal: 2,
      },
      {
        name: 'task',
        status: 'passed',
        metrics: {},
        run,
        events: [],
        usage: run.usage,
        turns: 0,
        durationMs: 120,
        repeatIndex: 2,
        repeatTotal: 2,
      },
    ]

    const evalResult: EvalResult<StateSchema> = {
      summary: {
        total: 2,
        passed: 2,
        failed: 0,
        errors: 0,
        terminated: 0,
        aborted: 0,
        timedOut: 0,
      },
      results,
      durationMs: 200,
    }

    const md = report(evalResult)
    expect(md).toContain('### task — PASS (2/2, 100.0%)')
    expect(md).not.toContain('Failures')
  })
})
