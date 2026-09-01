import { z } from 'zod'

import type { ErrorHandler } from '../errors'
import type { ModelAdapter, Provider, StreamEvent } from '../types'

import { adk } from '../api'
import { BaseSession } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter, createTestSession, testAgent, getLastAssistantText } from '../testing'
import { BaseRunner } from './index'

const app = adk()
const service = sessionService(inMemoryStore())

describe('BaseRunner', () => {
  let mockAdapter: MockAdapter

  beforeEach(() => {
    mockAdapter = new MockAdapter()
  })

  describe('constructor', () => {
    test('accepts session service, adapters as Map or Record', () => {
      expect(new BaseRunner()).toBeInstanceOf(BaseRunner)
      expect(new BaseRunner({ sessionService: service })).toBeInstanceOf(BaseRunner)
      expect(new BaseRunner({ adapters: new Map([['openai', mockAdapter]]) })).toBeInstanceOf(
        BaseRunner,
      )
      expect(
        new BaseRunner({
          adapters: { openai: mockAdapter, gemini: mockAdapter },
        }),
      ).toBeInstanceOf(BaseRunner)
    })
  })

  describe('run()', () => {
    test('runs agent and returns result', async () => {
      mockAdapter.setResponses([{ text: 'Hello!' }])
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      })
      const session = createTestSession('Hi')

      const result = await runner.run(testAgent(), session)

      expect(result.session).toBe(session)
      expect(result.iterations).toBe(1)
      expect(getLastAssistantText(result.session.events)).toBe('Hello!')
    })

    test('streams events via hooks onEvent callback', async () => {
      mockAdapter.setResponses([{ text: 'Response', streamChunks: true }])
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      })
      const events: StreamEvent[] = []

      await runner.run(testAgent(), createTestSession('Test'), {
        hooks: [{ onEvent: (e) => events.push(e) }],
      })

      expect(events.some((e) => e.type === 'assistant_delta')).toBe(true)
    })

    test('calls onStep hook after each model step', async () => {
      mockAdapter.setResponses([{ toolCalls: [{ name: 't', args: {} }] }, { text: 'Done' }])
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      })
      const myTool = app.tool({
        name: 't',
        description: 'T',
        schema: z.object({}),
        execute: () => ({}),
      })
      const steps: number[] = []

      await runner.run(testAgent({ tools: [myTool] }), createTestSession('Test'), {
        hooks: [{ onStep: (e) => steps.push(e.length) }],
      })

      expect(steps.length).toBeGreaterThanOrEqual(2)
    })

    test('supports timeout', async () => {
      mockAdapter.setResponses([{ text: 'Slow', delayMs: 500 }])
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      })

      await expect(
        runner.run(testAgent(), createTestSession('Test'), { timeout: 100 }),
      ).rejects.toThrow('Timeout')
    })

    test('supports abort', async () => {
      mockAdapter.setResponses([{ text: 'Response', delayMs: 500 }])
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      })
      const stream = runner.run(testAgent(), createTestSession('Test'))

      setTimeout(() => stream.abort(), 50)

      await expect(stream).rejects.toThrow('Aborted')
    })

    test('transfer inherits temp state from the transferring run, not an earlier run', async () => {
      let observedNote: unknown
      const specialist = testAgent({
        name: 'specialist',
        hooks: [
          {
            beforeAgent: (ctx) => {
              observedNote = (ctx.state as { temp: Record<string, unknown> }).temp.handoffNote
            },
          },
        ],
      })
      const noteTool = app.tool({
        name: 'transfer_with_note',
        description: 'Transfer to the specialist with a note',
        schema: z.object({ note: z.string() }),
        execute: (ctx) => {
          ;(ctx.state as { temp: Record<string, unknown> }).temp.handoffNote = ctx.args.note
          return specialist
        },
      })
      const triage = testAgent({ name: 'triage', tools: [noteTool] })

      mockAdapter.setResponses([
        { text: 'First run done' },
        { toolCalls: [{ name: 'transfer_with_note', args: { note: 'run-2-note' } }] },
        { text: 'Specialist here' },
      ])
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      })

      // Temp state is keyed by invocation, so a transfer must resolve the invocation_start of the
      // run it happened in. A session-wide lookup would find the first run's instead.
      const session = createTestSession('First message')
      await runner.run(triage, session)
      session.input.message('Now transfer')
      await runner.run(triage, session)

      expect(observedNote).toBe('run-2-note')
    })
  })

  describe('provider selection', () => {
    test('routes to correct adapter by provider', async () => {
      const openaiAdapter = new MockAdapter({
        defaultResponse: { text: 'OpenAI' },
      })
      const geminiAdapter = new MockAdapter({
        defaultResponse: { text: 'Gemini' },
      })
      const runner = new BaseRunner({
        adapters: { openai: openaiAdapter, gemini: geminiAdapter },
      })

      const result = await runner.run(testAgent(), createTestSession('Test'))

      expect(openaiAdapter.stepCalls).toHaveLength(1)
      expect(geminiAdapter.stepCalls).toHaveLength(0)
      expect(getLastAssistantText(result.session.events)).toBe('OpenAI')
    })

    test('aggregates prompt cache writes in run usage', async () => {
      const usageAdapter: ModelAdapter = {
        async *step(ctx) {
          yield {
            id: 'prompt-cache-usage-stream',
            type: 'assistant_delta',
            createdAt: 0,
            invocationId: ctx.invocationId,
            agentName: ctx.agentName,
            delta: '',
            text: '',
          }
          return {
            stepEvents: [],
            toolCalls: [],
            terminal: true,
            usage: {
              modelName: 'gpt-5.6-luna',
              inputTokens: 2048,
              cachedTokens: 1024,
              cacheWriteTokens: 896,
              outputTokens: 120,
            },
          }
        },
      }
      const runner = new BaseRunner({ adapters: { openai: usageAdapter } })

      const result = await runner.run(testAgent(), createTestSession('Test'))

      expect(result.usage?.totalCacheWriteTokens).toBe(896)
      expect(result.usage?.models).toEqual([
        expect.objectContaining({
          modelName: 'gpt-4o-mini',
          cacheWriteTokens: 896,
        }),
      ])
    })

    test('throws for unsupported provider', async () => {
      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      })
      const myAgent = testAgent({
        model: { provider: 'unknown' as Provider, name: 'test' },
      })

      await expect(runner.run(myAgent, createTestSession('Test'))).rejects.toThrow(
        "No adapter for provider 'unknown'",
      )
    })
  })
})

describe('Integration', () => {
  let mockAdapter: MockAdapter
  let runner: BaseRunner

  beforeEach(() => {
    mockAdapter = new MockAdapter()
    runner = new BaseRunner({
      sessionService: service,
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    })
  })

  test('multi-turn conversation with state tracking', async () => {
    const incTool = app.tool({
      name: 'inc',
      description: 'Inc',
      schema: z.object({}),
      execute: (ctx) => {
        const c = ((ctx.state.c as number) ?? 0) + 1
        ctx.state.c = c
        return { c }
      },
    })

    const session = (await service.createSession('app', {
      scopes: { user: 'user1' },
      sessionId: 's1',
    })) as BaseSession

    mockAdapter.setResponses([{ toolCalls: [{ name: 'inc', args: {} }] }, { text: '1' }])
    session.input.message('Inc')
    await runner.run(testAgent({ tools: [incTool] }), session)
    await service.commitSession(session)
    expect(session.state.c).toBe(1)

    mockAdapter.reset()
    mockAdapter.setResponses([{ toolCalls: [{ name: 'inc', args: {} }] }, { text: '2' }])
    session.input.message('Inc')
    await runner.run(testAgent({ tools: [incTool] }), session)
    await service.commitSession(session)
    expect(session.state.c).toBe(2)
  })

  test('user state persists across sessions', async () => {
    const setTool = app.tool({
      name: 'set',
      description: 'Set',
      schema: z.object({ k: z.string(), v: z.string() }),
      execute: (ctx) => {
        ctx.state.user[ctx.args.k] = ctx.args.v
        return {}
      },
    })

    mockAdapter.setResponses([
      { toolCalls: [{ name: 'set', args: { k: 'theme', v: 'dark' } }] },
      { text: 'Set' },
    ])
    const s1 = (await service.createSession('app', {
      scopes: { user: 'user1' },
    })) as BaseSession
    s1.input.message('Set')
    await runner.run(testAgent({ tools: [setTool] }), s1)
    await service.commitSession(s1)

    const s2 = (await service.createSession('app', {
      scopes: { user: 'user1' },
    })) as BaseSession
    expect(s2.state.user.theme).toBe('dark')
  })

  test('error recovery with errorHandlers', async () => {
    mockAdapter.setResponses([{ error: new Error('Fail') }, { text: 'Recovered' }])
    const errors: Error[] = []

    const errorHandler: ErrorHandler = {
      handle: (ctx) => {
        errors.push(ctx.error)
        return { action: 'skip' }
      },
    }

    const runnerWithHandler = new BaseRunner({
      adapters: new Map([['openai', mockAdapter]]),
      errorHandlers: [errorHandler],
    })

    const result = await runnerWithHandler.run(testAgent(), createTestSession('Test'))

    expect(errors[0].message).toBe('Fail')
    expect(getLastAssistantText(result.session.events)).toBe('Recovered')
  })

  test('context includes tool events after execution', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 't', args: {} }] }, { text: 'Done' }])
    const myTool = app.tool({
      name: 't',
      description: 'T',
      schema: z.object({}),
      execute: () => ({ data: 1 }),
    })

    await runner.run(testAgent({ tools: [myTool] }), createTestSession('Test'))

    const ctx = mockAdapter.stepCalls[1].ctx
    expect(ctx.events.some((e) => e.type === 'tool_call')).toBe(true)
    expect(ctx.events.some((e) => e.type === 'tool_result')).toBe(true)
  })
})
