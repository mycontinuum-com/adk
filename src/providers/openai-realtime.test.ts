import { EventEmitter } from 'events'
import { z } from 'zod'

import type { Event, StreamEvent } from '../types/events'
import type { RenderContext, FunctionTool, Agent } from '../types/runnables'
import type { WSConstructor } from './ws-helpers'

import { OpenAIRealtimeTextAdapter } from './openai-realtime'

// --- Mock WebSocket (injected via DI, no module mocking needed) ---

let responseScript: Record<string, unknown>[] = []
let lastMockWS: MockWebSocket | null = null

class MockWebSocket extends EventEmitter {
  readyState = 0
  sentMessages: Record<string, unknown>[] = []
  url: string
  opts: Record<string, unknown> | undefined

  constructor(url: string, opts?: Record<string, unknown>) {
    super()
    this.url = url
    this.opts = opts
    // oxlint-disable-next-line typescript-eslint(no-this-alias)
    lastMockWS = this

    process.nextTick(() => {
      this.readyState = 1
      this.emit('open')
    })
  }

  send(data: string) {
    const msg = JSON.parse(data)
    this.sentMessages.push(msg)

    if (msg.type === 'session.update') {
      process.nextTick(() => {
        this.emit('message', JSON.stringify({ type: 'session.updated', session: {} }))
      })
    }

    if (msg.type === 'response.create') {
      const events = [...responseScript]
      process.nextTick(() => {
        for (const event of events) {
          this.emit('message', JSON.stringify(event))
        }
      })
    }
  }

  close() {
    this.readyState = 3
    this.emit('close')
  }
}

const MockWS = MockWebSocket as unknown as WSConstructor

// --- Helpers ---

function createMockCtx(overrides?: Partial<RenderContext>): RenderContext {
  return {
    invocationId: 'inv_test',
    agentName: 'test-agent',
    session: {} as any,
    state: {} as any,
    agent: { name: 'test-agent', kind: 'agent' } as Agent,
    events: [
      {
        id: 'e1',
        type: 'system',
        text: 'You are a helpful assistant.',
        createdAt: Date.now(),
        invocationId: 'inv_test',
        agentName: 'test-agent',
      },
    ] as Event[],
    functionTools: [],
    providerTools: [],
    ...overrides,
  } as RenderContext
}

async function collectStep(
  adapter: OpenAIRealtimeTextAdapter,
  ctx: RenderContext,
  config: any,
  signal?: AbortSignal,
) {
  const gen = adapter.step(ctx, config, signal)
  const events: StreamEvent[] = []
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    result = await gen.next()
  }
  return { events, result: result.value }
}

// --- Tests ---

describe('OpenAIRealtimeTextAdapter', () => {
  const config = { provider: 'openai' as const, name: 'gpt-4o-realtime' }

  beforeEach(() => {
    responseScript = []
    lastMockWS = null
  })

  describe('connection and session setup', () => {
    test('connects to the correct WebSocket URL with auth headers', async () => {
      responseScript = [
        {
          type: 'response.done',
          response: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('test-api-key', MockWS)
      await collectStep(adapter, createMockCtx(), config)

      expect(lastMockWS.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime')
      expect(lastMockWS.opts.headers).toEqual({
        Authorization: 'Bearer test-api-key',
        'OpenAI-Beta': 'realtime=v1',
      })
    })

    test('URL-encodes model names', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, createMockCtx(), {
        ...config,
        name: 'gpt-4o realtime/preview',
      })

      expect(lastMockWS.url).toContain('model=gpt-4o%20realtime%2Fpreview')
    })

    test('sends session.update with text modality and null turn detection', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, createMockCtx(), config)

      const sessionUpdate = lastMockWS.sentMessages.find((m: any) => m.type === 'session.update')
      expect(sessionUpdate.session.modalities).toEqual(['text'])
      expect(sessionUpdate.session.turn_detection).toBeNull()
      expect(sessionUpdate.session.instructions).toBe('You are a helpful assistant.')
    })

    test('passes temperature and maxTokens from model config', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, createMockCtx(), {
        ...config,
        temperature: 0.7,
        maxTokens: 500,
      })

      const sessionUpdate = lastMockWS.sentMessages.find((m: any) => m.type === 'session.update')
      expect(sessionUpdate.session.temperature).toBe(0.7)
      expect(sessionUpdate.session.max_response_output_tokens).toBe(500)
    })

    test('omits temperature and maxTokens when not set', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, createMockCtx(), config)

      const sessionUpdate = lastMockWS.sentMessages.find((m: any) => m.type === 'session.update')
      expect(sessionUpdate.session.temperature).toBeUndefined()
      expect(sessionUpdate.session.max_response_output_tokens).toBeUndefined()
    })
  })

  describe('conversation history replay', () => {
    test('replays user and assistant messages as conversation items', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const ctx = createMockCtx({
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System prompt',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          {
            id: 'e2',
            type: 'user',
            text: 'Hello',
            createdAt: 2,
          },
          {
            id: 'e3',
            type: 'assistant',
            text: 'Hi there!',
            createdAt: 3,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          {
            id: 'e4',
            type: 'user',
            text: 'How are you?',
            createdAt: 4,
          },
        ] as Event[],
      })

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const items = lastMockWS.sentMessages
        .filter((m: any) => m.type === 'conversation.item.create')
        .map((m: any) => m.item)

      // 3 items: user, assistant, user (system goes into instructions)
      expect(items).toHaveLength(3)
      expect(items[0]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      })
      expect(items[1]).toEqual({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there!' }],
      })
      expect(items[2]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'How are you?' }],
      })
    })

    test('replays tool call and result events', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const ctx = createMockCtx({
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          {
            id: 'e2',
            type: 'user',
            text: 'Weather?',
            createdAt: 2,
          },
          {
            id: 'e3',
            type: 'tool_call',
            callId: 'call_1',
            name: 'get_weather',
            args: { city: 'NYC' },
            createdAt: 3,
            invocationId: 'inv_test',
            agentName: 'test-agent',
            providerContext: {
              provider: 'openai-realtime',
              data: { call_id: 'rt_call_1' },
            },
          },
          {
            id: 'e4',
            type: 'tool_result',
            callId: 'call_1',
            name: 'get_weather',
            result: { temp: 72 },
            createdAt: 4,
            invocationId: 'inv_test',
            agentName: 'test-agent',
            providerContext: {
              provider: 'openai-realtime',
              data: { call_id: 'rt_call_1' },
            },
          },
        ] as unknown as Event[],
      })

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const items = lastMockWS.sentMessages
        .filter((m: any) => m.type === 'conversation.item.create')
        .map((m: any) => m.item)

      // 3 items: user, tool_call, tool_result
      expect(items).toHaveLength(3)
      expect(items[1]).toEqual({
        type: 'function_call',
        call_id: 'rt_call_1',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      })
      expect(items[2]).toEqual({
        type: 'function_call_output',
        call_id: 'rt_call_1',
        output: '{"temp":72}',
      })
    })

    test('response.create is sent after all conversation items', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const ctx = createMockCtx({
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          {
            id: 'e2',
            type: 'user',
            text: 'Hi',
            createdAt: 2,
          },
        ] as Event[],
      })

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const types = lastMockWS.sentMessages.map((m: any) => m.type)
      const lastConvIdx = types.lastIndexOf('conversation.item.create')
      const responseIdx = types.indexOf('response.create')

      expect(responseIdx).toBeGreaterThan(lastConvIdx)
    })
  })

  describe('text response streaming', () => {
    test('yields assistant_delta events and returns accumulated text', async () => {
      responseScript = [
        { type: 'response.text.delta', delta: 'Hello' },
        { type: 'response.text.delta', delta: ' world' },
        {
          type: 'response.done',
          response: {
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, createMockCtx(), config)

      // Should yield 2 assistant_delta streaming events
      expect(events).toHaveLength(2)
      expect(events[0].type).toBe('assistant_delta')
      expect((events[0] as any).delta).toBe('Hello')
      expect((events[0] as any).text).toBe('Hello')
      expect(events[1].type).toBe('assistant_delta')
      expect((events[1] as any).delta).toBe(' world')
      expect((events[1] as any).text).toBe('Hello world')

      // Result should have accumulated assistant event
      expect(result.terminal).toBe(true)
      expect(result.toolCalls).toHaveLength(0)
      expect(result.stepEvents).toHaveLength(1)
      expect(result.stepEvents[0].type).toBe('assistant')
      expect((result.stepEvents[0] as any).text).toBe('Hello world')
      expect(result.finishReason).toBe('stop')
    })

    test('empty response returns terminal result with no events', async () => {
      responseScript = [
        {
          type: 'response.done',
          response: { usage: { input_tokens: 5, output_tokens: 0 } },
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, createMockCtx(), config)

      expect(events).toHaveLength(0)
      expect(result.terminal).toBe(true)
      expect(result.stepEvents).toHaveLength(0)
      expect(result.toolCalls).toHaveLength(0)
    })

    test('returns usage from response.done', async () => {
      responseScript = [
        {
          type: 'response.done',
          response: {
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, createMockCtx(), config)

      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      })
    })

    test('returns cached token usage when present', async () => {
      responseScript = [
        {
          type: 'response.done',
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              input_token_details: { cached_tokens: 30 },
            },
          },
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, createMockCtx(), config)

      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 30,
      })
    })
  })

  describe('tool call handling', () => {
    test('parses tool calls from function_call events', async () => {
      responseScript = [
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_1',
            type: 'function_call',
            call_id: 'call_abc',
            name: 'get_weather',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'item_1',
          delta: '{"loc',
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'item_1',
          delta: 'ation":"NYC"}',
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'item_1',
          arguments: '{"location":"NYC"}',
        },
        {
          type: 'response.done',
          response: { usage: { input_tokens: 20, output_tokens: 10 } },
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, createMockCtx(), config)

      // No streaming events for tool calls
      expect(events).toHaveLength(0)

      expect(result.terminal).toBe(false)
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].name).toBe('get_weather')
      expect(result.toolCalls[0].args).toEqual({ location: 'NYC' })
      expect(result.finishReason).toBe('tool_calls')

      // stepEvents should include the tool call
      expect(result.stepEvents).toHaveLength(1)
      expect(result.stepEvents[0].type).toBe('tool_call')
    })

    test('handles multiple tool calls', async () => {
      responseScript = [
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
          },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'item_1',
          arguments: '{"city":"NYC"}',
        },
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_2',
            type: 'function_call',
            call_id: 'call_2',
            name: 'get_time',
          },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'item_2',
          arguments: '{"timezone":"EST"}',
        },
        { type: 'response.done', response: { usage: {} } },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, createMockCtx(), config)

      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0].name).toBe('get_weather')
      expect(result.toolCalls[0].args).toEqual({ city: 'NYC' })
      expect(result.toolCalls[1].name).toBe('get_time')
      expect(result.toolCalls[1].args).toEqual({ timezone: 'EST' })
    })

    test('sets openai-realtime providerContext on tool calls', async () => {
      responseScript = [
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_1',
            type: 'function_call',
            call_id: 'call_abc',
            name: 'search',
          },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'item_1',
          arguments: '{}',
        },
        { type: 'response.done', response: { usage: {} } },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, createMockCtx(), config)

      expect(result.toolCalls[0].providerContext).toEqual({
        provider: 'openai-realtime',
        data: { call_id: 'call_abc', item_id: 'item_1' },
      })
    })

    test('handles mixed text and tool calls', async () => {
      responseScript = [
        { type: 'response.text.delta', delta: 'Let me check...' },
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_fn',
            type: 'function_call',
            call_id: 'call_xyz',
            name: 'get_weather',
          },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'item_fn',
          arguments: '{"city":"London"}',
        },
        { type: 'response.done', response: { usage: {} } },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, createMockCtx(), config)

      // One streaming delta
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('assistant_delta')

      // Result has both assistant text and tool call
      expect(result.terminal).toBe(false)
      expect(result.stepEvents).toHaveLength(2) // assistant + tool_call
      expect(result.toolCalls).toHaveLength(1)
      expect(result.finishReason).toBe('tool_calls')
    })
  })

  describe('tool serialization', () => {
    test('serializes function tools in session.update', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const tools: FunctionTool[] = [
        {
          name: 'get_weather',
          description: 'Get the weather for a location',
          schema: z.object({
            location: z.string().describe('City name'),
          }),
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, createMockCtx({ functionTools: tools }), config)

      const sessionUpdate = lastMockWS.sentMessages.find((m: any) => m.type === 'session.update')
      expect(sessionUpdate.session.tools).toHaveLength(1)
      expect(sessionUpdate.session.tools[0].type).toBe('function')
      expect(sessionUpdate.session.tools[0].name).toBe('get_weather')
      expect(sessionUpdate.session.tools[0].description).toBe('Get the weather for a location')
      expect(sessionUpdate.session.tools[0].parameters).toBeDefined()
      expect(sessionUpdate.session.tools[0].parameters.properties.location).toBeDefined()
    })

    test('sends empty tools array when no tools configured', async () => {
      responseScript = [{ type: 'response.done', response: { usage: {} } }]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, createMockCtx(), config)

      const sessionUpdate = lastMockWS.sentMessages.find((m: any) => m.type === 'session.update')
      expect(sessionUpdate.session.tools).toEqual([])
    })
  })

  describe('error handling', () => {
    test('throws on API error event', async () => {
      responseScript = [
        {
          type: 'error',
          error: { type: 'invalid_request', message: 'Bad request' },
        },
      ]

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)

      await expect(collectStep(adapter, createMockCtx(), config)).rejects.toThrow(
        'OpenAI Realtime API error: Bad request',
      )
    })

    test('throws when no API key is provided', async () => {
      const adapter = new OpenAIRealtimeTextAdapter(undefined, MockWS)
      const origKey = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY

      try {
        await expect(collectStep(adapter, createMockCtx(), config)).rejects.toThrow(
          'OPENAI_API_KEY is required',
        )
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey
      }
    })

    test('throws when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)

      await expect(
        collectStep(adapter, createMockCtx(), config, controller.signal),
      ).rejects.toThrow('Aborted')
    })
  })

  describe('abort handling', () => {
    test('closes WebSocket on abort during response processing', async () => {
      // Script with one delta but no response.done — adapter will wait for more events
      responseScript = [{ type: 'response.text.delta', delta: 'Hello' }]

      const controller = new AbortController()
      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const gen = adapter.step(createMockCtx(), config, controller.signal)

      // Get first streaming event
      const first = await gen.next()
      expect(first.done).toBe(false)
      expect((first.value as any).type).toBe('assistant_delta')

      // Abort
      controller.abort()

      // Next iteration should throw
      await expect(gen.next()).rejects.toThrow('Aborted')

      // WebSocket should be closed
      expect(lastMockWS.readyState).toBe(3) // CLOSED
    })
  })

  describe('invocation context', () => {
    test('assistant events include correct invocationId and agentName', async () => {
      responseScript = [
        { type: 'response.text.delta', delta: 'Hi' },
        { type: 'response.done', response: { usage: {} } },
      ]

      const ctx = createMockCtx({
        invocationId: 'inv_123',
        agentName: 'my-agent',
      })

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, ctx, config)

      // Streaming event
      expect((events[0] as any).invocationId).toBe('inv_123')
      expect((events[0] as any).agentName).toBe('my-agent')

      // Final assistant event
      expect(result.stepEvents[0].invocationId).toBe('inv_123')
      expect(result.stepEvents[0].agentName).toBe('my-agent')
    })

    test('tool call events include correct invocationId and agentName', async () => {
      responseScript = [
        {
          type: 'response.output_item.added',
          item: {
            id: 'item_1',
            type: 'function_call',
            call_id: 'c1',
            name: 'fn',
          },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'item_1',
          arguments: '{}',
        },
        { type: 'response.done', response: { usage: {} } },
      ]

      const ctx = createMockCtx({
        invocationId: 'inv_456',
        agentName: 'tool-agent',
      })

      const adapter = new OpenAIRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, ctx, config)

      expect(result.toolCalls[0].invocationId).toBe('inv_456')
      expect(result.toolCalls[0].agentName).toBe('tool-agent')
    })
  })
})
