import { EventEmitter } from 'events'
import { z } from 'zod'

import type { Event, StreamEvent } from '../types/events'
import type { RenderContext, FunctionTool, Agent } from '../types/runnables'
import type { WSConstructor } from './ws-helpers'

import { GeminiRealtimeTextAdapter } from './gemini-realtime'

// --- Mock WebSocket (injected via DI, no module mocking needed) ---

let responseScript: Record<string, unknown>[] = []
let toolResponseScript: Record<string, unknown>[] = []
let lastMockWS: MockWebSocket | null = null
let allMockWSInstances: MockWebSocket[] = []

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
    allMockWSInstances.push(this)

    process.nextTick(() => {
      this.readyState = 1
      this.emit('open')
    })
  }

  send(data: string) {
    const msg = JSON.parse(data)
    this.sentMessages.push(msg)

    if (msg.setup) {
      process.nextTick(() => {
        this.emit('message', JSON.stringify({ setupComplete: {} }))
      })
    }

    if (msg.clientContent) {
      const events = [...responseScript]
      process.nextTick(() => {
        for (const event of events) {
          this.emit('message', JSON.stringify(event))
        }
      })
    }

    if (msg.toolResponse) {
      const events = [...toolResponseScript]
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
  adapter: GeminiRealtimeTextAdapter,
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

describe('GeminiRealtimeTextAdapter', () => {
  const config = { provider: 'gemini' as const, name: 'gemini-2.0-flash-live' }

  beforeEach(() => {
    responseScript = []
    toolResponseScript = []
    lastMockWS = null
    allMockWSInstances = []
  })

  describe('connection and setup', () => {
    test('connects to the correct WebSocket URL with API key in query param', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('test-api-key', MockWS)
      await collectStep(adapter, ctx, config)

      expect(lastMockWS.url).toBe(
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=test-api-key',
      )
      expect(lastMockWS.opts.headers).toEqual({})
    })

    test('sends setup with correct model, responseModalities, and system instruction', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

      const ctx = createMockCtx({
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'You are helpful.',
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

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.model).toBe('models/gemini-2.0-flash-live')
      expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['TEXT'])
      expect(setupMsg.setup.systemInstruction).toEqual({
        parts: [{ text: 'You are helpful.' }],
      })
    })

    test('passes temperature and maxTokens in generationConfig', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, {
        ...config,
        temperature: 0.5,
        maxTokens: 1000,
      })

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.generationConfig.temperature).toBe(0.5)
      expect(setupMsg.setup.generationConfig.maxOutputTokens).toBe(1000)
    })

    test('omits temperature and maxTokens when not set', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.generationConfig.temperature).toBeUndefined()
      expect(setupMsg.setup.generationConfig.maxOutputTokens).toBeUndefined()
    })

    test('sends AUDIO modality and outputAudioTranscription for native-audio models', async () => {
      responseScript = [
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const nativeAudioConfig = {
        provider: 'gemini' as const,
        name: 'gemini-live-2.5-flash-native-audio',
      }

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, nativeAudioConfig)

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['AUDIO'])
      expect(setupMsg.setup.outputAudioTranscription).toEqual({})
    })

    test('sends TEXT modality and no transcription for non-native-audio models', async () => {
      responseScript = [
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['TEXT'])
      expect(setupMsg.setup.outputAudioTranscription).toBeUndefined()
    })

    test('omits systemInstruction when no system events', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

      const ctx = createMockCtx({
        events: [{ id: 'e1', type: 'user', text: 'Hello', createdAt: 1 }] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.systemInstruction).toBeUndefined()
    })
  })

  describe('conversation history replay', () => {
    test('sends conversation turns via clientContent', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const clientContent = lastMockWS.sentMessages.find((m: any) => m.clientContent)
      expect(clientContent).toBeDefined()
      expect(clientContent.clientContent.turnComplete).toBe(true)

      const turns = clientContent.clientContent.turns
      // Gemini serialization merges consecutive same-role turns
      // user, model, user → 3 turns
      expect(turns).toHaveLength(3)
      expect(turns[0].role).toBe('user')
      expect(turns[0].parts[0].text).toBe('Hello')
      expect(turns[1].role).toBe('model')
      expect(turns[1].parts[0].text).toBe('Hi there!')
      expect(turns[2].role).toBe('user')
      expect(turns[2].parts[0].text).toBe('How are you?')
    })

    test('injects synthetic user turn when no conversation history', async () => {
      // Only system event — system goes to systemInstruction, not turns.
      // The Live API requires at least one user turn to trigger generation,
      // so the adapter injects a minimal synthetic user turn.
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const clientContent = lastMockWS.sentMessages.find((m: any) => m.clientContent)
      expect(clientContent).toBeDefined()
      expect(clientContent.clientContent.turnComplete).toBe(true)
      // Should have a synthetic user turn
      expect(clientContent.clientContent.turns).toHaveLength(1)
      expect(clientContent.clientContent.turns[0].role).toBe('user')
    })

    test('replays tool call and result events in conversation turns', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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
          },
        ] as unknown as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const clientContent = lastMockWS.sentMessages.find((m: any) => m.clientContent)
      const turns = clientContent.clientContent.turns

      // Gemini serializes: user, model (functionCall), user (functionResponse)
      expect(turns).toHaveLength(3)
      expect(turns[0].role).toBe('user')
      expect(turns[0].parts[0].text).toBe('Weather?')

      // Tool call becomes a model turn with functionCall part
      expect(turns[1].role).toBe('model')
      expect(turns[1].parts[0].functionCall).toBeDefined()
      expect(turns[1].parts[0].functionCall.name).toBe('get_weather')

      // Tool result becomes a user turn with functionResponse part
      expect(turns[2].role).toBe('user')
      expect(turns[2].parts[0].functionResponse).toBeDefined()
      expect(turns[2].parts[0].functionResponse.name).toBe('get_weather')
    })

    test('strips thoughtSignature and thought from context for Live API', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
          {
            id: 'e3',
            type: 'assistant',
            text: 'Hello!',
            createdAt: 3,
            invocationId: 'inv_test',
            agentName: 'test-agent',
            // These fields get serialized into parts by serializeContext
            // but sanitizeForLiveApi should strip them
          },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const clientContent = lastMockWS.sentMessages.find((m: any) => m.clientContent)
      const turns = clientContent.clientContent.turns

      // Verify no turns contain thoughtSignature or thought properties
      for (const turn of turns) {
        for (const part of turn.parts) {
          expect(part).not.toHaveProperty('thoughtSignature')
          expect(part).not.toHaveProperty('thought')
        }
      }
    })
  })

  describe('text response streaming', () => {
    test('yields assistant_delta events and returns accumulated text', async () => {
      responseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'Hello' }] },
          },
        },
        {
          serverContent: {
            modelTurn: { parts: [{ text: ' world' }] },
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, ctx, config)

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
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, ctx, config)

      expect(events).toHaveLength(0)
      expect(result.terminal).toBe(true)
      expect(result.stepEvents).toHaveLength(0)
      expect(result.toolCalls).toHaveLength(0)
    })

    test('yields deltas from outputTranscription for native audio models', async () => {
      responseScript = [
        {
          serverContent: { outputTranscription: { text: 'Hello! ' } },
        },
        {
          serverContent: {
            modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] },
          },
        },
        {
          serverContent: { outputTranscription: { text: '2 + 2 is 4.' } },
        },
        {
          serverContent: { outputTranscription: { finished: true } },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'What is 2+2?', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, ctx, {
        provider: 'gemini' as const,
        name: 'gemini-live-2.5-flash-native-audio',
      })

      // Should yield 2 transcription deltas (audio inlineData is ignored)
      expect(events).toHaveLength(2)
      expect(events[0].type).toBe('assistant_delta')
      expect((events[0] as any).delta).toBe('Hello! ')
      expect(events[1].type).toBe('assistant_delta')
      expect((events[1] as any).delta).toBe('2 + 2 is 4.')

      // Accumulated text
      expect(result.terminal).toBe(true)
      expect(result.stepEvents).toHaveLength(1)
      expect(result.stepEvents[0].type).toBe('assistant')
      expect((result.stepEvents[0] as any).text).toBe('Hello! 2 + 2 is 4.')
    })

    test('handles multiple text parts in a single serverContent message', async () => {
      responseScript = [
        {
          serverContent: {
            modelTurn: {
              parts: [{ text: 'Part 1' }, { text: ' Part 2' }],
            },
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, ctx, config)

      expect(events).toHaveLength(2)
      expect((events[0] as any).delta).toBe('Part 1')
      expect((events[1] as any).delta).toBe(' Part 2')
      expect((result.stepEvents[0] as any).text).toBe('Part 1 Part 2')
    })
  })

  describe('tool call handling', () => {
    test('parses tool calls from toolCall message', async () => {
      responseScript = [
        {
          toolCall: {
            functionCalls: [
              {
                id: 'fn_1',
                name: 'get_weather',
                args: { location: 'NYC' },
              },
            ],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Weather?', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, ctx, config)

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

    test('handles multiple tool calls in a single message', async () => {
      responseScript = [
        {
          toolCall: {
            functionCalls: [
              { id: 'fn_1', name: 'get_weather', args: { city: 'NYC' } },
              { id: 'fn_2', name: 'get_time', args: { timezone: 'EST' } },
            ],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Weather and time?', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, ctx, config)

      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0].name).toBe('get_weather')
      expect(result.toolCalls[0].args).toEqual({ city: 'NYC' })
      expect(result.toolCalls[1].name).toBe('get_time')
      expect(result.toolCalls[1].args).toEqual({ timezone: 'EST' })
    })

    test('sets gemini-realtime providerContext on tool calls', async () => {
      responseScript = [
        {
          toolCall: {
            functionCalls: [{ id: 'fn_abc', name: 'search', args: {} }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Search', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, ctx, config)

      expect(result.toolCalls[0].providerContext).toEqual({
        provider: 'gemini-realtime',
        data: { functionCallId: 'fn_abc' },
      })
    })

    test('handles mixed text and tool calls', async () => {
      responseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'Let me check...' }] },
          },
        },
        {
          toolCall: {
            functionCalls: [{ id: 'fn_1', name: 'get_weather', args: { city: 'London' } }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Weather?', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { events, result } = await collectStep(adapter, ctx, config)

      // One streaming delta
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('assistant_delta')

      // Result has both assistant text and tool call
      expect(result.terminal).toBe(false)
      expect(result.stepEvents).toHaveLength(2) // assistant + tool_call
      expect(result.toolCalls).toHaveLength(1)
      expect(result.finishReason).toBe('tool_calls')
    })

    test('handles tool call with empty args', async () => {
      responseScript = [
        {
          toolCall: {
            functionCalls: [{ id: 'fn_1', name: 'get_time' }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Time?', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, ctx, config)

      expect(result.toolCalls[0].args).toEqual({})
    })
  })

  describe('stateful tool response flow', () => {
    test('sends toolResponse on same WS after tool call, then receives final response', async () => {
      // Step 1: model returns a tool call
      responseScript = [
        {
          toolCall: {
            functionCalls: [{ id: 'fn_1', name: 'get_weather', args: { city: 'NYC' } }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      // Step 2: after toolResponse, model returns final text
      toolResponseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'The weather in NYC is sunny.' }] },
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)

      // Step 1: initial call
      const ctx1 = createMockCtx({
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          { id: 'e2', type: 'user', text: 'Weather in NYC?', createdAt: 2 },
        ] as Event[],
      })

      const { result: result1 } = await collectStep(adapter, ctx1, config)
      expect(result1.toolCalls).toHaveLength(1)
      expect(result1.terminal).toBe(false)

      const wsAfterStep1 = lastMockWS
      // WS should still be open (kept alive for tool response)
      expect(wsAfterStep1.readyState).toBe(1)

      // Step 2: send tool results on the same invocation
      const toolCallId = result1.toolCalls[0].callId
      const ctx2 = createMockCtx({
        invocationId: 'inv_test', // same invocation
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          { id: 'e2', type: 'user', text: 'Weather in NYC?', createdAt: 2 },
          // tool_call event from step 1
          {
            id: 'e3',
            type: 'tool_call',
            callId: toolCallId,
            name: 'get_weather',
            args: { city: 'NYC' },
            createdAt: 3,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          // tool_result event (runner executed the tool)
          {
            id: 'e4',
            type: 'tool_result',
            callId: toolCallId,
            name: 'get_weather',
            result: { temp: 72, condition: 'sunny' },
            createdAt: 4,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
        ] as unknown as Event[],
      })

      const { events: events2, result: result2 } = await collectStep(adapter, ctx2, config)

      // Should reuse the SAME WebSocket (no new WS created)
      expect(lastMockWS).toBe(wsAfterStep1)
      expect(allMockWSInstances).toHaveLength(1)

      // Should have sent a toolResponse message
      const toolResponseMsg = wsAfterStep1.sentMessages.find((m: any) => m.toolResponse)
      expect(toolResponseMsg).toBeDefined()
      expect(toolResponseMsg.toolResponse.functionResponses).toHaveLength(1)
      expect(toolResponseMsg.toolResponse.functionResponses[0].name).toBe('get_weather')
      expect(toolResponseMsg.toolResponse.functionResponses[0].id).toBe('fn_1')
      expect(toolResponseMsg.toolResponse.functionResponses[0].response).toEqual({
        temp: 72,
        condition: 'sunny',
      })

      // Step 2 result should be the final text response
      expect(result2.terminal).toBe(true)
      expect(result2.toolCalls).toHaveLength(0)
      expect(events2).toHaveLength(1)
      expect((events2[0] as any).delta).toBe('The weather in NYC is sunny.')

      // WS should be closed after terminal response
      expect(wsAfterStep1.readyState).toBe(3)
    })

    test('handles multiple rounds of tool calls on same WS', async () => {
      // Step 1: model returns first tool call
      responseScript = [
        {
          toolCall: {
            functionCalls: [{ id: 'fn_1', name: 'get_weather', args: { city: 'NYC' } }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      // Step 2: after first toolResponse, model returns another tool call
      toolResponseScript = [
        {
          toolCall: {
            functionCalls: [{ id: 'fn_2', name: 'get_forecast', args: { city: 'NYC' } }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)

      // Step 1
      const ctx1 = createMockCtx({
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          { id: 'e2', type: 'user', text: 'Forecast?', createdAt: 2 },
        ] as Event[],
      })

      const { result: result1 } = await collectStep(adapter, ctx1, config)
      expect(result1.toolCalls).toHaveLength(1)
      expect(result1.toolCalls[0].name).toBe('get_weather')

      const singleWS = lastMockWS

      // Step 2: send first tool response, get second tool call
      const callId1 = result1.toolCalls[0].callId
      const ctx2 = createMockCtx({
        invocationId: 'inv_test',
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          { id: 'e2', type: 'user', text: 'Forecast?', createdAt: 2 },
          {
            id: 'e3',
            type: 'tool_call',
            callId: callId1,
            name: 'get_weather',
            args: { city: 'NYC' },
            createdAt: 3,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          {
            id: 'e4',
            type: 'tool_result',
            callId: callId1,
            name: 'get_weather',
            result: { temp: 72 },
            createdAt: 4,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
        ] as unknown as Event[],
      })

      const { result: result2 } = await collectStep(adapter, ctx2, config)
      expect(result2.toolCalls).toHaveLength(1)
      expect(result2.toolCalls[0].name).toBe('get_forecast')
      expect(result2.terminal).toBe(false)

      // Still same WS
      expect(lastMockWS).toBe(singleWS)
      expect(allMockWSInstances).toHaveLength(1)

      // Step 3: send second tool response, get final text
      // Update toolResponseScript for the final response
      toolResponseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'Forecast looks good!' }] },
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      const callId2 = result2.toolCalls[0].callId
      const ctx3 = createMockCtx({
        invocationId: 'inv_test',
        events: [
          ...ctx2.events,
          {
            id: 'e5',
            type: 'tool_call',
            callId: callId2,
            name: 'get_forecast',
            args: { city: 'NYC' },
            createdAt: 5,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          {
            id: 'e6',
            type: 'tool_result',
            callId: callId2,
            name: 'get_forecast',
            result: { forecast: 'sunny' },
            createdAt: 6,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
        ] as unknown as Event[],
      })

      const { result: result3 } = await collectStep(adapter, ctx3, config)
      expect(result3.terminal).toBe(true)
      expect(result3.toolCalls).toHaveLength(0)

      // Still same WS for all 3 steps
      expect(allMockWSInstances).toHaveLength(1)
      // WS closed after terminal
      expect(singleWS.readyState).toBe(3)
    })

    test('sends error tool response when tool_result has error', async () => {
      // Step 1: tool call
      responseScript = [
        {
          toolCall: {
            functionCalls: [{ id: 'fn_1', name: 'search', args: { q: 'test' } }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      // Step 2: model responds after error
      toolResponseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'Sorry, search failed.' }] },
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)

      const ctx1 = createMockCtx({
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          { id: 'e2', type: 'user', text: 'Search', createdAt: 2 },
        ] as Event[],
      })

      const { result: result1 } = await collectStep(adapter, ctx1, config)
      const callId = result1.toolCalls[0].callId

      const ctx2 = createMockCtx({
        invocationId: 'inv_test',
        events: [
          ...ctx1.events,
          {
            id: 'e3',
            type: 'tool_call',
            callId,
            name: 'search',
            args: { q: 'test' },
            createdAt: 3,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          {
            id: 'e4',
            type: 'tool_result',
            callId,
            name: 'search',
            error: 'Connection timeout',
            createdAt: 4,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
        ] as unknown as Event[],
      })

      await collectStep(adapter, ctx2, config)

      const toolResponseMsg = lastMockWS.sentMessages.find((m: any) => m.toolResponse)
      expect(toolResponseMsg.toolResponse.functionResponses[0].response).toEqual({
        error: 'Connection timeout',
      })
    })
  })

  describe('tool serialization', () => {
    test('serializes function tools in setup message', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

      const tools: FunctionTool[] = [
        {
          name: 'get_weather',
          description: 'Get the weather for a location',
          schema: z.object({
            location: z.string().describe('City name'),
          }),
        },
      ]

      const ctx = createMockCtx({
        functionTools: tools,
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_test',
            agentName: 'test-agent',
          },
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.tools).toHaveLength(1)
      expect(setupMsg.setup.tools[0].functionDeclarations).toHaveLength(1)
      expect(setupMsg.setup.tools[0].functionDeclarations[0].name).toBe('get_weather')
      expect(setupMsg.setup.tools[0].functionDeclarations[0].description).toBe(
        'Get the weather for a location',
      )
    })

    test('omits tools when no tools configured', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      await collectStep(adapter, ctx, config)

      const setupMsg = lastMockWS.sentMessages.find((m: any) => m.setup)
      expect(setupMsg.setup.tools).toBeUndefined()
    })
  })

  describe('usage metadata', () => {
    test('returns usage from usageMetadata message', async () => {
      responseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'Hi' }] },
          },
        },
        {
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 50,
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, ctx, config)

      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      })
    })

    test('returns cached and reasoning tokens when present', async () => {
      responseScript = [
        {
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 80,
            cachedContentTokenCount: 60,
            thoughtsTokenCount: 30,
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, ctx, config)

      expect(result.usage).toEqual({
        inputTokens: 200,
        outputTokens: 80,
        cachedTokens: 60,
        reasoningTokens: 30,
      })
    })
  })

  describe('error handling', () => {
    test('throws when no API key is provided', async () => {
      const adapter = new GeminiRealtimeTextAdapter(undefined, MockWS)
      const origGemini = process.env.GEMINI_API_KEY
      delete process.env.GEMINI_API_KEY

      try {
        await expect(collectStep(adapter, createMockCtx(), config)).rejects.toThrow(
          'GEMINI_API_KEY is required',
        )
      } finally {
        if (origGemini) process.env.GEMINI_API_KEY = origGemini
      }
    })

    test('throws when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)

      await expect(
        collectStep(adapter, createMockCtx(), config, controller.signal),
      ).rejects.toThrow('Aborted')
    })

    test('throws when connection closes before turnComplete', async () => {
      // Empty response script — WS will close without turnComplete
      responseScript = []

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)

      // After sending clientContent, the mock sends empty responseScript,
      // then we need to close the WS. Patch to close after sending.
      const origSend = MockWebSocket.prototype.send
      MockWebSocket.prototype.send = function (data: string) {
        origSend.call(this, data)
        const msg = JSON.parse(data)
        if (msg.clientContent) {
          process.nextTick(() => {
            this.readyState = 3
            this.emit('close')
          })
        }
      }

      try {
        await expect(collectStep(adapter, ctx, config)).rejects.toThrow(
          'Gemini Realtime connection closed before response completed',
        )
      } finally {
        MockWebSocket.prototype.send = origSend
      }
    })
  })

  describe('abort handling', () => {
    test('closes WebSocket on abort during response processing', async () => {
      // Script with text but no turnComplete — adapter will wait for more events
      responseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'Hello' }] },
          },
        },
      ]

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
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const controller = new AbortController()
      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const gen = adapter.step(ctx, config, controller.signal)

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

    test('cleans up session on abort between tool call steps', async () => {
      // Step 1: tool call
      responseScript = [
        {
          toolCall: {
            functionCalls: [{ id: 'fn_1', name: 'slow_tool', args: {} }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      const controller = new AbortController()
      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)

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
          { id: 'e2', type: 'user', text: 'Do it', createdAt: 2 },
        ] as Event[],
      })

      const { result: result1 } = await collectStep(adapter, ctx, config, controller.signal)
      expect(result1.toolCalls).toHaveLength(1)

      // WS should be alive between steps
      expect(lastMockWS.readyState).toBe(1)

      // Abort while "runner is executing tool"
      controller.abort()

      // WS should be cleaned up
      expect(lastMockWS.readyState).toBe(3)
    })
  })

  describe('invocation context', () => {
    test('assistant events include correct invocationId and agentName', async () => {
      responseScript = [
        {
          serverContent: {
            modelTurn: { parts: [{ text: 'Hi' }] },
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      const ctx = createMockCtx({
        invocationId: 'inv_123',
        agentName: 'my-agent',
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_123',
            agentName: 'my-agent',
          },
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
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
          toolCall: {
            functionCalls: [{ id: 'fn_1', name: 'fn', args: {} }],
          },
        },
        {
          serverContent: { turnComplete: true },
        },
      ]

      const ctx = createMockCtx({
        invocationId: 'inv_456',
        agentName: 'tool-agent',
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_456',
            agentName: 'tool-agent',
          },
          { id: 'e2', type: 'user', text: 'Do it', createdAt: 2 },
        ] as Event[],
      })

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)
      const { result } = await collectStep(adapter, ctx, config)

      expect(result.toolCalls[0].invocationId).toBe('inv_456')
      expect(result.toolCalls[0].agentName).toBe('tool-agent')
    })
  })

  describe('different invocations get separate sessions', () => {
    test('new invocationId creates a new WS connection', async () => {
      responseScript = [
        {
          serverContent: { modelTurn: { parts: [] }, turnComplete: true },
        },
      ]

      const adapter = new GeminiRealtimeTextAdapter('key', MockWS)

      // First invocation
      const ctx1 = createMockCtx({
        invocationId: 'inv_1',
        events: [
          {
            id: 'e1',
            type: 'system',
            text: 'System',
            createdAt: 1,
            invocationId: 'inv_1',
            agentName: 'test-agent',
          },
          { id: 'e2', type: 'user', text: 'Hi', createdAt: 2 },
        ] as Event[],
      })
      await collectStep(adapter, ctx1, config)

      // Second invocation (different invocationId)
      const ctx2 = createMockCtx({
        invocationId: 'inv_2',
        events: [
          {
            id: 'e3',
            type: 'system',
            text: 'System',
            createdAt: 3,
            invocationId: 'inv_2',
            agentName: 'test-agent',
          },
          { id: 'e4', type: 'user', text: 'Hello', createdAt: 4 },
        ] as Event[],
      })
      await collectStep(adapter, ctx2, config)

      // Should have created 2 separate WS connections
      expect(allMockWSInstances).toHaveLength(2)
    })
  })
})
