import { z } from 'zod'

import type {
  Event,
  SystemEvent,
  UserEvent,
  AssistantEvent,
  ThoughtEvent,
  ToolCallEvent,
  ToolResultEvent,
  FunctionTool,
  RenderContext,
} from '../types'

import { createEventId } from '../session'
import {
  serializeContext,
  parseResponse,
  serializeTools,
  serializeToolChoice,
  ClaudeAdapter,
} from './claude'

const TEST_INV_ID = 'test-invocation-id'
const TEST_AGENT = 'test_agent'

function createEvent<T extends Event>(
  partial: Omit<T, 'id' | 'createdAt' | 'invocationId' | 'agentName'> & {
    invocationId?: string
    agentName?: string
  },
): T {
  return {
    id: createEventId(),
    createdAt: Date.now(),
    invocationId: partial.invocationId ?? TEST_INV_ID,
    agentName: partial.agentName ?? TEST_AGENT,
    ...partial,
  } as T
}

function mockRenderContext(events: Event[], functionTools: FunctionTool[] = []): RenderContext {
  return {
    events,
    functionTools,
    providerTools: [],
    invocationId: TEST_INV_ID,
    agentName: TEST_AGENT,
    session: {} as never,
    state: {} as never,
    agent: { toolChoice: 'auto' } as never,
  }
}

describe('Claude provider', () => {
  describe('serializeContext', () => {
    it('should extract system events as system string when caching disabled', () => {
      const events: Event[] = [
        createEvent<SystemEvent>({ type: 'system', text: 'You are helpful' }),
        createEvent<SystemEvent>({ type: 'system', text: 'Be concise' }),
      ]

      const result = serializeContext(mockRenderContext(events), {
        promptCache: { enabled: false, ttl: '5m', system: 'all' },
      })

      expect(result.system).toBe('You are helpful\n\nBe concise')
      expect(result.messages).toHaveLength(0)
    })

    it('should serialize system events as system blocks when caching enabled', () => {
      const events: Event[] = [
        createEvent<SystemEvent>({ type: 'system', text: 'You are helpful' }),
        createEvent<SystemEvent>({ type: 'system', text: 'Be concise' }),
      ]

      const result = serializeContext(mockRenderContext(events), {
        promptCache: { enabled: true, ttl: '1h', system: 'all' },
      })

      expect(Array.isArray(result.system)).toBe(true)
      expect(result.system).toEqual([
        {
          type: 'text',
          text: 'You are helpful',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
        {
          type: 'text',
          text: 'Be concise',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ])
      expect(result.messages).toHaveLength(0)
    })

    it('should serialize user events with role user', () => {
      const events: Event[] = [createEvent<UserEvent>({ type: 'user', text: 'Hello' })]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('user')
      expect(result.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }])
    })

    it('should serialize assistant events with role assistant', () => {
      const events: Event[] = [createEvent<AssistantEvent>({ type: 'assistant', text: 'Hi there' })]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('assistant')
      expect(result.messages[0].content).toEqual([{ type: 'text', text: 'Hi there' }])
    })

    it('should serialize tool_call events as tool_use blocks', () => {
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'internal-123',
          name: 'get_weather',
          args: { city: 'London' },
          providerContext: {
            provider: 'claude',
            data: { id: 'toolu_abc123' },
          },
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('assistant')
      expect(result.messages[0].content).toEqual([
        {
          type: 'tool_use',
          id: 'toolu_abc123',
          name: 'get_weather',
          input: { city: 'London' },
        },
      ])
    })

    it('should serialize tool_result events with correct tool_use_id from map', () => {
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'internal-123',
          name: 'get_weather',
          args: { city: 'London' },
          providerContext: {
            provider: 'claude',
            data: { id: 'toolu_abc123' },
          },
        }),
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId: 'internal-123',
          name: 'get_weather',
          result: { temp: 20 },
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(2)
      expect(result.messages[1].role).toBe('user')
      expect(result.messages[1].content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123',
          content: '{"temp":20}',
        },
      ])
    })

    it('should set is_error flag on tool_result when error is present', () => {
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'internal-123',
          name: 'get_weather',
          args: { city: 'London' },
          providerContext: {
            provider: 'claude',
            data: { id: 'toolu_abc123' },
          },
        }),
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId: 'internal-123',
          name: 'get_weather',
          error: 'City not found',
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages[1].content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123',
          content: 'City not found',
          is_error: true,
        },
      ])
    })

    it('should serialize tool_result with base64 images in content array', () => {
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'internal-123',
          name: 'take_screenshot',
          args: { url: 'https://example.com' },
          providerContext: {
            provider: 'claude',
            data: { id: 'toolu_abc123' },
          },
        }),
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId: 'internal-123',
          name: 'take_screenshot',
          result: { success: true, width: 800, height: 600 },
          media: [
            {
              type: 'image',
              source: {
                type: 'base64',
                mimeType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUg==',
              },
            },
          ],
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages[1].content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_abc123',
          content: [
            { type: 'text', text: '{"success":true,"width":800,"height":600}' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUg==',
              },
            },
          ],
        },
      ])
    })

    it('should serialize tool_result with URL images in content array', () => {
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'internal-456',
          name: 'capture_image',
          args: { url: 'https://example.com/photo.jpg' },
          providerContext: {
            provider: 'claude',
            data: { id: 'toolu_def456' },
          },
        }),
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId: 'internal-456',
          name: 'capture_image',
          result: { success: true },
          media: [
            {
              type: 'image',
              source: {
                type: 'url',
                url: 'https://example.com/photo.jpg',
              },
            },
          ],
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      const content = result.messages[1].content as Array<{ type: string; content?: unknown }>
      expect(content).toHaveLength(1)
      const toolResult = content[0]
      expect(toolResult.type).toBe('tool_result')
      const inner = toolResult.content as Array<{ type: string }>
      expect(inner).toHaveLength(2)
      expect(inner[0].type).toBe('text')
      expect(inner[1]).toMatchObject({
        type: 'image',
        source: { type: 'url', url: 'https://example.com/photo.jpg' },
      })
    })

    it('should serialize tool_result with multiple images', () => {
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'internal-789',
          name: 'get_screenshots',
          args: {},
          providerContext: {
            provider: 'claude',
            data: { id: 'toolu_ghi789' },
          },
        }),
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId: 'internal-789',
          name: 'get_screenshots',
          result: { count: 2 },
          media: [
            {
              type: 'image',
              source: {
                type: 'base64',
                mimeType: 'image/png',
                data: 'image1data==',
              },
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                mimeType: 'image/jpeg',
                data: 'image2data==',
              },
            },
          ],
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      const content = result.messages[1].content as Array<{ type: string; content?: unknown }>
      const toolResult = content[0]
      const inner = toolResult.content as Array<{ type: string }>
      expect(inner).toHaveLength(3)
      expect(inner[0].type).toBe('text')
      expect(inner[1].type).toBe('image')
      expect(inner[2].type).toBe('image')
    })

    it('should serialize thought events as thinking blocks with signature', () => {
      const events: Event[] = [
        createEvent<ThoughtEvent>({
          type: 'thought',
          text: 'Let me think about this...',
          providerContext: {
            provider: 'claude',
            data: { signature: 'sig123' },
          },
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('assistant')
      expect(result.messages[0].content).toEqual([
        {
          type: 'thinking',
          thinking: 'Let me think about this...',
          signature: 'sig123',
        },
      ])
    })

    it('should serialize redacted thought events as redacted_thinking blocks', () => {
      const events: Event[] = [
        createEvent<ThoughtEvent>({
          type: 'thought',
          text: '[redacted]',
          providerContext: {
            provider: 'claude',
            data: { redacted: true, data: 'encrypted_data_here' },
          },
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].content).toEqual([
        {
          type: 'redacted_thinking',
          data: 'encrypted_data_here',
        },
      ])
    })

    it('should group consecutive same-role messages', () => {
      const events: Event[] = [
        createEvent<AssistantEvent>({ type: 'assistant', text: 'First' }),
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'call-1',
          name: 'tool1',
          args: {},
          providerContext: { provider: 'claude', data: { id: 'toolu_1' } },
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('assistant')
      expect(result.messages[0].content).toHaveLength(2)
    })

    it('should preserve order of text and tool_use in assistant message', () => {
      const events: Event[] = [
        createEvent<AssistantEvent>({
          type: 'assistant',
          text: 'I will use a tool',
        }),
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId: 'call-1',
          name: 'calculator',
          args: { a: 1, b: 2 },
          providerContext: { provider: 'claude', data: { id: 'toolu_calc' } },
        }),
      ]

      const result = serializeContext(mockRenderContext(events))

      expect(result.messages).toHaveLength(1)
      const content = result.messages[0].content as Array<{ type: string }>
      expect(content[0].type).toBe('text')
      expect(content[1].type).toBe('tool_use')
    })
  })

  describe('parseResponse', () => {
    it('should parse text blocks as assistant events', () => {
      const blocks = [{ type: 'text' as const, text: 'Hello!' }]

      const result = parseResponse(
        blocks,
        { inputTokens: 10, outputTokens: 5 },
        'end_turn',
        TEST_INV_ID,
        TEST_AGENT,
      )

      expect(result.stepEvents).toHaveLength(1)
      expect(result.stepEvents[0].type).toBe('assistant')
      expect((result.stepEvents[0] as AssistantEvent).text).toBe('Hello!')
      expect(result.terminal).toBe(true)
    })

    it('should parse tool_use blocks as tool_call events with providerContext', () => {
      const blocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_xyz789',
          name: 'get_weather',
          inputJson: '{"city":"Paris"}',
        },
      ]

      const result = parseResponse(
        blocks,
        { inputTokens: 10, outputTokens: 5 },
        'tool_use',
        TEST_INV_ID,
        TEST_AGENT,
      )

      expect(result.stepEvents).toHaveLength(1)
      expect(result.toolCalls).toHaveLength(1)
      const toolCall = result.stepEvents[0] as ToolCallEvent
      expect(toolCall.type).toBe('tool_call')
      expect(toolCall.name).toBe('get_weather')
      expect(toolCall.args).toEqual({ city: 'Paris' })
      expect(toolCall.providerContext).toEqual({
        provider: 'claude',
        data: { id: 'toolu_xyz789' },
      })
      expect(result.terminal).toBe(false)
    })

    it('should parse thinking blocks as thought events with signature', () => {
      const blocks = [
        {
          type: 'thinking' as const,
          thinking: 'Let me analyze this...',
          signature: 'signature_abc',
        },
      ]

      const result = parseResponse(
        blocks,
        { inputTokens: 10, outputTokens: 5 },
        'end_turn',
        TEST_INV_ID,
        TEST_AGENT,
      )

      expect(result.stepEvents).toHaveLength(1)
      const thought = result.stepEvents[0] as ThoughtEvent
      expect(thought.type).toBe('thought')
      expect(thought.text).toBe('Let me analyze this...')
      expect(thought.providerContext).toEqual({
        provider: 'claude',
        data: { signature: 'signature_abc' },
      })
    })

    it('should parse redacted_thinking blocks as thought events with redacted flag', () => {
      const blocks = [
        {
          type: 'redacted_thinking' as const,
          data: 'encrypted_content',
        },
      ]

      const result = parseResponse(
        blocks,
        { inputTokens: 10, outputTokens: 5 },
        'end_turn',
        TEST_INV_ID,
        TEST_AGENT,
      )

      expect(result.stepEvents).toHaveLength(1)
      const thought = result.stepEvents[0] as ThoughtEvent
      expect(thought.type).toBe('thought')
      expect(thought.text).toBe('[redacted]')
      expect(thought.providerContext).toEqual({
        provider: 'claude',
        data: { redacted: true, data: 'encrypted_content' },
      })
    })

    it('should preserve block order in stepEvents', () => {
      const blocks = [
        { type: 'text' as const, text: 'First I will think' },
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'calc',
          inputJson: '{}',
        },
      ]

      const result = parseResponse(
        blocks,
        { inputTokens: 10, outputTokens: 5 },
        'tool_use',
        TEST_INV_ID,
        TEST_AGENT,
      )

      expect(result.stepEvents).toHaveLength(2)
      expect(result.stepEvents[0].type).toBe('assistant')
      expect(result.stepEvents[1].type).toBe('tool_call')
    })

    it('should map finish reasons correctly', () => {
      expect(
        parseResponse([], { inputTokens: 0, outputTokens: 0 }, 'end_turn', TEST_INV_ID, TEST_AGENT)
          .finishReason,
      ).toBe('stop')
      expect(
        parseResponse(
          [],
          { inputTokens: 0, outputTokens: 0 },
          'max_tokens',
          TEST_INV_ID,
          TEST_AGENT,
        ).finishReason,
      ).toBe('length')
      expect(
        parseResponse(
          [],
          { inputTokens: 0, outputTokens: 0 },
          'stop_sequence',
          TEST_INV_ID,
          TEST_AGENT,
        ).finishReason,
      ).toBe('stop')

      const toolBlocks = [{ type: 'tool_use' as const, id: 't1', name: 'test', inputJson: '{}' }]
      expect(
        parseResponse(
          toolBlocks,
          { inputTokens: 0, outputTokens: 0 },
          'tool_use',
          TEST_INV_ID,
          TEST_AGENT,
        ).finishReason,
      ).toBe('tool_calls')
    })
  })

  describe('serializeTools', () => {
    it('should serialize tools with input_schema', () => {
      const tools: FunctionTool[] = [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          schema: z.object({
            city: z.string().describe('The city name'),
            unit: z.enum(['celsius', 'fahrenheit']),
          }),
        },
      ]

      const result = serializeTools(tools)

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('get_weather')
      expect(result[0].description).toBe('Get weather for a city')
      expect(result[0].input_schema.type).toBe('object')
      expect(result[0].input_schema.properties).toHaveProperty('city')
      expect(result[0].input_schema.properties).toHaveProperty('unit')
      expect(result[0].input_schema.required).toContain('city')
      expect(result[0].input_schema.required).toContain('unit')
    })
  })

  describe('serializeToolChoice', () => {
    it('should map auto to { type: auto }', () => {
      expect(serializeToolChoice('auto')).toEqual({ type: 'auto' })
      expect(serializeToolChoice(undefined)).toEqual({ type: 'auto' })
    })

    it('should map none to { type: none }', () => {
      expect(serializeToolChoice('none')).toEqual({ type: 'none' })
    })

    it('should map required to { type: any }', () => {
      expect(serializeToolChoice('required')).toEqual({ type: 'any' })
    })

    it('should map specific tool name to { type: tool, name }', () => {
      expect(serializeToolChoice({ name: 'get_weather' })).toEqual({
        type: 'tool',
        name: 'get_weather',
      })
    })

    it('should use single allowed tool when provided', () => {
      expect(serializeToolChoice('auto', ['specific_tool'])).toEqual({
        type: 'tool',
        name: 'specific_tool',
      })
    })
  })

  type CapturedClaudeRequest = { temperature?: number; thinking?: unknown }

  /**
   * Drives the adapter far enough to capture the request it builds. The request is assembled before
   * the response stream is read, so a stub that captures it and then throws a sentinel avoids
   * mocking Anthropic's event stream entirely.
   */
  async function captureClaudeRequest(config: {
    temperature?: number
    thinking?: { budgetTokens?: number }
  }): Promise<CapturedClaudeRequest> {
    const adapter = new ClaudeAdapter()
    let captured: CapturedClaudeRequest = {}
    const SENTINEL = '__captured__'
    // @ts-expect-error replacing the private client factory so no network call happens
    adapter.getClient = () => ({
      messages: {
        create: (request: CapturedClaudeRequest) => {
          captured = request
          throw new Error(SENTINEL)
        },
      },
    })

    const ctx = {
      events: [{ type: 'user', text: 'hi' }],
      functionTools: [],
      invocationId: TEST_INV_ID,
      agentName: TEST_AGENT,
      agent: {},
      session: {},
    } as unknown as RenderContext

    const stream = adapter.step(ctx, {
      provider: 'claude',
      name: 'claude-sonnet-4',
      vertex: { project: 'p', location: 'l' },
      ...config,
    } as never)
    try {
      let next = await stream.next()
      while (!next.done) next = await stream.next()
    } catch (error) {
      if (!(error instanceof Error) || error.message !== SENTINEL) throw error
    }
    return captured
  }

  describe('Claude temperature and extended thinking', () => {
    it('forwards temperature when thinking is off', async () => {
      const request = await captureClaudeRequest({ temperature: 0.2 })
      expect(request.temperature).toBe(0.2)
    })

    it('drops temperature when thinking is on, which Anthropic requires', async () => {
      const request = await captureClaudeRequest({
        temperature: 0.2,
        thinking: { budgetTokens: 1024 },
      })
      // Anthropic rejects a non-default temperature alongside extended thinking,
      // so the adapter must omit it rather than fail the request.
      expect(request.thinking).toBeDefined()
      expect(request).not.toHaveProperty('temperature')
    })
  })
})
