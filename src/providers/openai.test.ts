import { z } from 'zod';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import type {
  Event,
  SystemEvent,
  UserEvent,
  AssistantEvent,
  ThoughtEvent,
  ToolCallEvent,
  ToolResultEvent,
  Tool,
  StreamEvent,
} from '../types';
import {
  serializeContext,
  parseResponse,
  serializeTools,
  serializeToolChoice,
  OpenAIAdapter,
} from './openai';
import type { OpenAIEndpoint } from './openai-endpoints';
import { createEventId, createCallId } from '../session';

const TEST_INV_ID = 'test-invocation-id';

function createEvent<T extends Event>(
  partial: Omit<T, 'id' | 'createdAt' | 'invocationId' | 'agentName'> & {
    invocationId?: string;
    agentName?: string;
  },
): T {
  return {
    id: createEventId(),
    createdAt: Date.now(),
    invocationId: partial.invocationId ?? TEST_INV_ID,
    agentName: partial.agentName ?? 'test_agent',
    ...partial,
  } as T;
}

describe('OpenAI serialization', () => {
  describe('serializeContext', () => {
    const mockRenderContext = (events: Event[]) =>
      ({
        events,
        tools: [],
        session: {} as never,
        agent: {} as never,
      }) as never;

    it('should serialize system events', () => {
      const events: Event[] = [
        createEvent<SystemEvent>({ type: 'system', text: 'You are helpful' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: 'system', content: 'You are helpful' });
    });

    it('should serialize user events', () => {
      const events: Event[] = [
        createEvent<UserEvent>({ type: 'user', text: 'Hello' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('should serialize assistant events', () => {
      const events: Event[] = [
        createEvent<AssistantEvent>({ type: 'assistant', text: 'Hi there' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hi there' }],
      });
    });

    it('should serialize tool_call events with fallback callId', () => {
      const callId = createCallId();
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId,
          name: 'get_weather',
          args: { city: 'London' },
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'function_call',
        id: callId,
        call_id: callId,
        name: 'get_weather',
        arguments: '{"city":"London"}',
      });
    });

    it('should serialize tool_call events with provider context', () => {
      const callId = createCallId();
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId,
          name: 'get_weather',
          args: { city: 'London' },
          providerContext: {
            provider: 'openai',
            data: { id: 'fc_123', call_id: 'call_abc' },
          },
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result[0]).toMatchObject({
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_abc',
        name: 'get_weather',
      });
    });

    it('should serialize tool_result events', () => {
      const callId = createCallId();
      const events: Event[] = [
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId,
          name: 'get_weather',
          result: { temp: 20, unit: 'C' },
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'function_call_output',
        call_id: callId,
        output: '{"temp":20,"unit":"C"}',
      });
    });

    it('should serialize tool_result error', () => {
      const callId = createCallId();
      const events: Event[] = [
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId,
          name: 'get_weather',
          error: 'City not found',
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result[0]).toMatchObject({
        type: 'function_call_output',
        output: 'City not found',
      });
    });

    it('should skip thought events without encrypted_content', () => {
      const events: Event[] = [
        createEvent<ThoughtEvent>({ type: 'thought', text: 'Thinking...' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(0);
    });

    it('should serialize thought events with encrypted_content', () => {
      const events: Event[] = [
        createEvent<ThoughtEvent>({
          type: 'thought',
          text: 'Thinking...',
          providerContext: {
            provider: 'openai',
            data: {
              type: 'reasoning',
              id: 'r_123',
              summary: [{ type: 'summary_text', text: 'Thinking...' }],
              encrypted_content: 'enc_xyz',
            },
          },
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'reasoning',
        id: 'r_123',
        encrypted_content: 'enc_xyz',
      });
    });

    it('should serialize multiple events in order', () => {
      const events: Event[] = [
        createEvent<SystemEvent>({ type: 'system', text: 'System prompt' }),
        createEvent<UserEvent>({ type: 'user', text: 'Question' }),
        createEvent<AssistantEvent>({ type: 'assistant', text: 'Answer' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ role: 'system' });
      expect(result[1]).toMatchObject({ role: 'user' });
      expect(result[2]).toMatchObject({ role: 'assistant' });
    });

    it('should ignore unknown event types', () => {
      const events = [
        {
          id: '1',
          createdAt: Date.now(),
          type: 'state_change',
          scope: 'session',
          changes: [],
        },
      ] as unknown as Event[];

      const result = serializeContext(mockRenderContext(events));

      expect(result).toHaveLength(0);
    });
  });

  describe('parseResponse', () => {
    const openaiEndpoint: OpenAIEndpoint = { type: 'openai' };
    const azureEndpoint: OpenAIEndpoint = {
      type: 'azure',
      baseUrl: 'https://test.azure.com',
      apiVersion: '2025-01-01',
    };
    const testInvocationId = 'test-invocation-id';

    it('should parse message output', () => {
      const output = [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello!' }],
        },
      ] as ResponseOutputItem[];

      const result = parseResponse(
        { output },
        openaiEndpoint,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(1);
      expect(result.stepEvents[0]).toMatchObject({
        type: 'assistant',
        text: 'Hello!',
        invocationId: testInvocationId,
        providerContext: { provider: 'openai' },
      });
      expect(result.toolCalls).toHaveLength(0);
      expect(result.terminal).toBe(true);
    });

    it('should set provider to azure-openai for azure endpoint', () => {
      const output = [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello!' }],
        },
      ] as ResponseOutputItem[];

      const result = parseResponse(
        { output },
        azureEndpoint,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents[0].providerContext?.provider).toBe(
        'azure-openai',
      );
    });

    it('should parse function_call output', () => {
      const output = [
        {
          type: 'function_call',
          id: 'fc_123',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"London"}',
          status: 'completed',
        },
      ] as ResponseOutputItem[];

      const result = parseResponse(
        { output },
        openaiEndpoint,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(1);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        type: 'tool_call',
        name: 'get_weather',
        args: { city: 'London' },
        invocationId: testInvocationId,
      });
      expect(result.terminal).toBe(false);
    });

    it('should parse reasoning output', () => {
      const output = [
        {
          type: 'reasoning',
          id: 'r_123',
          summary: [
            { type: 'summary_text' as const, text: 'Step 1' },
            { type: 'summary_text' as const, text: 'Step 2' },
          ],
          encrypted_content: 'enc_xyz',
        },
      ] as ResponseOutputItem[];

      const result = parseResponse(
        { output },
        openaiEndpoint,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(1);
      expect(result.stepEvents[0]).toMatchObject({
        type: 'thought',
        text: 'Step 1\nStep 2',
        invocationId: testInvocationId,
      });
    });

    it('should parse multiple output items', () => {
      const output = [
        {
          type: 'reasoning',
          id: 'r_123',
          summary: [{ type: 'summary_text' as const, text: 'Thinking' }],
        },
        {
          type: 'function_call',
          id: 'fc_123',
          call_id: 'call_abc',
          name: 'search',
          arguments: '{"q":"test"}',
          status: 'completed',
        },
      ] as ResponseOutputItem[];

      const result = parseResponse(
        { output },
        openaiEndpoint,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(2);
      expect(result.stepEvents[0].type).toBe('thought');
      expect(result.stepEvents[1].type).toBe('tool_call');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.terminal).toBe(false);
    });

    it('should skip message with empty content', () => {
      const output = [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [],
        },
      ] as ResponseOutputItem[];

      const result = parseResponse(
        { output },
        openaiEndpoint,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(0);
    });
  });

  describe('serializeTools', () => {
    it('should serialize tools with zod schemas', () => {
      const tools: Tool[] = [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          schema: z.object({
            city: z.string().describe('City name'),
            unit: z.enum(['C', 'F']).nullable().optional(),
          }),
          execute: () => ({}),
        },
      ];

      const result = serializeTools(tools);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'function',
        name: 'get_weather',
        description: 'Get weather for a city',
        strict: true,
      });
      expect(result[0].parameters).toHaveProperty('properties');
      expect(result[0].parameters.properties).toHaveProperty('city');
    });

    it('should serialize multiple tools', () => {
      const tools: Tool[] = [
        {
          name: 'tool_a',
          description: 'Tool A',
          schema: z.object({ x: z.number() }),
          execute: () => ({}),
        },
        {
          name: 'tool_b',
          description: 'Tool B',
          schema: z.object({ y: z.string() }),
          execute: () => ({}),
        },
      ];

      const result = serializeTools(tools);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('tool_a');
      expect(result[1].name).toBe('tool_b');
    });

    it('should return empty array for no tools', () => {
      const result = serializeTools([]);
      expect(result).toEqual([]);
    });
  });
});

describe('OpenAIAdapter fallback', () => {
  const azureEndpoint: OpenAIEndpoint = {
    type: 'azure',
    baseUrl: 'https://azure.test',
    apiVersion: '2025-01-01',
  };
  const openaiEndpoint: OpenAIEndpoint = { type: 'openai' };
  const mockCtx = {
    events: [{ id: '1', type: 'user', text: 'Hi', createdAt: Date.now() }],
    tools: [],
    session: {} as never,
    agent: {} as never,
  } as never;
  const mockConfig = { provider: 'openai' as const, name: 'gpt-5-mini' };

  async function consumeStream(adapter: OpenAIAdapter): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of adapter.step(mockCtx, mockConfig)) {
      events.push(event);
      if (events.length > 10) break;
    }
    return events;
  }

  function mockExecuteStep(
    adapter: OpenAIAdapter,
    fn: (endpoint: OpenAIEndpoint) => void,
  ) {
    const originalStep = adapter['executeStep'].bind(adapter);
    const adapterObj = adapter as unknown as Record<string, unknown>;
    adapterObj.executeStep = async function* (
      ctx: never,
      config: never,
      signal: never,
      endpoint: OpenAIEndpoint,
    ) {
      fn(endpoint);
      yield* originalStep(ctx, config, signal, endpoint);
    };
  }

  it('should try next endpoint on retryable error', async () => {
    const endpointCalls: string[] = [];
    const adapter = OpenAIAdapter.withFallback([azureEndpoint, openaiEndpoint]);

    let callCount = 0;
    mockExecuteStep(adapter, (endpoint) => {
      callCount++;
      endpointCalls.push(endpoint.type);
      if (callCount === 1) {
        throw new Error('Rate limit exceeded');
      }
    });

    let events: StreamEvent[] = [];
    try {
      events = await consumeStream(adapter);
    } catch {
      // Expected - no real API
    }

    expect(endpointCalls).toEqual(['azure', 'openai']);
    expect(callCount).toBe(2);
  });

  it('should not fallback on non-retryable error', async () => {
    const adapter = OpenAIAdapter.withFallback([azureEndpoint, openaiEndpoint]);

    let callCount = 0;
    mockExecuteStep(adapter, () => {
      callCount++;
      throw new Error('Invalid API key');
    });

    await expect(consumeStream(adapter)).rejects.toThrow('Invalid API key');
    expect(callCount).toBe(1);
  });

  it('should throw after all endpoints exhausted', async () => {
    const adapter = OpenAIAdapter.withFallback([azureEndpoint, openaiEndpoint]);

    let callCount = 0;
    mockExecuteStep(adapter, () => {
      callCount++;
      throw new Error('Rate limit exceeded');
    });

    await expect(consumeStream(adapter)).rejects.toThrow('Rate limit exceeded');
    expect(callCount).toBe(2);
  });

  it('should work with single endpoint', async () => {
    const adapter = OpenAIAdapter.withFallback([openaiEndpoint]);

    let callCount = 0;
    mockExecuteStep(adapter, () => {
      callCount++;
      throw new Error('Connection refused');
    });

    await expect(consumeStream(adapter)).rejects.toThrow('Connection refused');
    expect(callCount).toBe(1);
  });
});

describe('serializeToolChoice', () => {
  it('returns undefined when no choice or allowedTools', () => {
    expect(serializeToolChoice(undefined)).toBeUndefined();
  });

  it('passes through string options', () => {
    expect(serializeToolChoice('auto')).toBe('auto');
    expect(serializeToolChoice('required')).toBe('required');
    expect(serializeToolChoice('none')).toBe('none');
  });

  it('serializes specific function choice', () => {
    expect(serializeToolChoice({ name: 'get_weather' })).toEqual({
      type: 'function',
      name: 'get_weather',
    });
  });

  it('creates allowed_tools with auto mode by default', () => {
    expect(serializeToolChoice(undefined, ['tool_a', 'tool_b'])).toEqual({
      type: 'allowed_tools',
      mode: 'auto',
      tools: [
        { type: 'function', name: 'tool_a' },
        { type: 'function', name: 'tool_b' },
      ],
    });
  });

  it('creates allowed_tools with required mode when toolChoice is required', () => {
    expect(serializeToolChoice('required', ['tool_a'])).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'function', name: 'tool_a' }],
    });
  });
});
