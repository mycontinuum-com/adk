import { z } from 'zod';
// @ts-ignore @google/genai is ESM-only but bundler handles it
import type { Content, Part } from '@google/genai';
import type {
  Event,
  SystemEvent,
  UserEvent,
  AssistantEvent,
  ThoughtEvent,
  ToolCallEvent,
  ToolResultEvent,
  Tool,
} from '../types';
import {
  serializeContext,
  parseResponse,
  serializeTools,
  serializeToolConfig,
} from './gemini';
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

function getPart(
  contents: Content[],
  contentIdx: number,
  partIdx: number,
): Part {
  return contents[contentIdx]!.parts![partIdx]!;
}

describe('Gemini serialization', () => {
  describe('serializeContext', () => {
    const mockRenderContext = (events: Event[]) =>
      ({
        events,
        tools: [],
        session: {} as never,
        agent: {} as never,
      }) as never;

    it('should extract system events as systemInstruction', () => {
      const events: Event[] = [
        createEvent<SystemEvent>({ type: 'system', text: 'You are helpful' }),
        createEvent<SystemEvent>({ type: 'system', text: 'Be concise' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result.systemInstruction).toBe('You are helpful\n\nBe concise');
      expect(result.contents).toHaveLength(0);
    });

    it('should serialize user events with role user', () => {
      const events: Event[] = [
        createEvent<UserEvent>({ type: 'user', text: 'Hello' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toEqual({
        role: 'user',
        parts: [{ text: 'Hello' }],
      });
    });

    it('should serialize assistant events with role model', () => {
      const events: Event[] = [
        createEvent<AssistantEvent>({ type: 'assistant', text: 'Hi there' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe('model');
      expect(getPart(result.contents, 0, 0)).toMatchObject({
        text: 'Hi there',
      });
    });

    it('should preserve thoughtSignature from assistant provider context', () => {
      const events: Event[] = [
        createEvent<AssistantEvent>({
          type: 'assistant',
          text: 'Response',
          providerContext: {
            provider: 'gemini',
            data: { thoughtSignature: 'sig_123' },
          },
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(getPart(result.contents, 0, 0)).toMatchObject({
        text: 'Response',
        thoughtSignature: 'sig_123',
      });
    });

    it('should serialize thought events with thoughtSignature', () => {
      const events: Event[] = [
        createEvent<ThoughtEvent>({
          type: 'thought',
          text: 'Thinking...',
          providerContext: {
            provider: 'gemini',
            data: { thoughtSignature: 'sig_abc' },
          },
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result.contents).toHaveLength(1);
      expect(getPart(result.contents, 0, 0)).toMatchObject({
        thought: true,
        text: 'Thinking...',
        thoughtSignature: 'sig_abc',
      });
    });

    it('should serialize thought events without thoughtSignature as text', () => {
      const events: Event[] = [
        createEvent<ThoughtEvent>({ type: 'thought', text: 'No signature' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe('model');
      expect(result.contents[0].parts).toHaveLength(1);
      expect(result.contents[0].parts![0].text).toBe('No signature');
      expect(result.contents[0].parts![0].thought).toBeUndefined();
    });

    it('should serialize tool_call events as functionCall', () => {
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

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe('model');
      expect(getPart(result.contents, 0, 0)).toMatchObject({
        functionCall: { name: 'get_weather', args: { city: 'London' } },
      });
    });

    it('should use provider context functionCall when available', () => {
      const callId = createCallId();
      const events: Event[] = [
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId,
          name: 'get_weather',
          args: { city: 'London' },
          providerContext: {
            provider: 'gemini',
            data: {
              functionCall: { name: 'get_weather', args: { city: 'Paris' } },
              thoughtSignature: 'sig_xyz',
            },
          },
        }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(getPart(result.contents, 0, 0)).toMatchObject({
        functionCall: { name: 'get_weather', args: { city: 'Paris' } },
        thoughtSignature: 'sig_xyz',
      });
    });

    it('should serialize tool_result events as functionResponse', () => {
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

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].role).toBe('user');
      expect(getPart(result.contents, 0, 0)).toMatchObject({
        functionResponse: {
          name: 'get_weather',
          response: { temp: 20, unit: 'C' },
        },
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

      expect(getPart(result.contents, 0, 0)).toMatchObject({
        functionResponse: {
          name: 'get_weather',
          response: { error: 'City not found' },
        },
      });
    });

    it('should group consecutive same-role events', () => {
      const events: Event[] = [
        createEvent<UserEvent>({ type: 'user', text: 'First' }),
        createEvent<UserEvent>({ type: 'user', text: 'Second' }),
        createEvent<AssistantEvent>({ type: 'assistant', text: 'Response' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result.contents).toHaveLength(2);
      expect(result.contents[0].role).toBe('user');
      expect(result.contents[0].parts).toHaveLength(2);
      expect(result.contents[1].role).toBe('model');
    });

    it('should handle mixed conversation flow', () => {
      const callId = createCallId();
      const events: Event[] = [
        createEvent<SystemEvent>({ type: 'system', text: 'System prompt' }),
        createEvent<UserEvent>({ type: 'user', text: 'Question' }),
        createEvent<ToolCallEvent>({
          type: 'tool_call',
          callId,
          name: 'search',
          args: { q: 'test' },
        }),
        createEvent<ToolResultEvent>({
          type: 'tool_result',
          callId,
          name: 'search',
          result: { results: [] },
        }),
        createEvent<AssistantEvent>({ type: 'assistant', text: 'Answer' }),
      ];

      const result = serializeContext(mockRenderContext(events));

      expect(result.systemInstruction).toBe('System prompt');
      expect(result.contents).toHaveLength(4);
      expect(result.contents[0].role).toBe('user');
      expect(result.contents[1].role).toBe('model');
      expect(result.contents[2].role).toBe('user');
      expect(result.contents[3].role).toBe('model');
    });
  });

  describe('parseResponse', () => {
    const testInvocationId = 'test-invocation-id';

    it('should parse text part as assistant event', () => {
      const parts: Part[] = [{ text: 'Hello!' }];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(1);
      expect(result.stepEvents[0]).toMatchObject({
        type: 'assistant',
        text: 'Hello!',
        invocationId: testInvocationId,
      });
      expect(result.stepEvents[0].providerContext).toBeUndefined();
      expect(result.terminal).toBe(true);
    });

    it('should parse thought part as thought event', () => {
      const parts: Part[] = [
        { thought: true, text: 'Thinking...', thoughtSignature: 'sig_123' },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(1);
      expect(result.stepEvents[0]).toMatchObject({
        type: 'thought',
        text: 'Thinking...',
        invocationId: testInvocationId,
      });
      expect(result.stepEvents[0].providerContext?.data).toMatchObject({
        thoughtSignature: 'sig_123',
      });
    });

    it('should parse functionCall as tool_call event', () => {
      const parts: Part[] = [
        {
          functionCall: { name: 'get_weather', args: { city: 'London' } },
        },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
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

    it('should handle empty args in functionCall', () => {
      const parts: Part[] = [
        { functionCall: { name: 'get_time', args: undefined } },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.toolCalls[0].args).toEqual({});
    });

    it('should parse multiple parts', () => {
      const parts: Part[] = [
        { thought: true, text: 'Let me think', thoughtSignature: 'sig_1' },
        { functionCall: { name: 'search', args: { q: 'test' } } },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(2);
      expect(result.stepEvents[0].type).toBe('thought');
      expect(result.stepEvents[1].type).toBe('tool_call');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.terminal).toBe(false);
    });

    it('should preserve thoughtSignature in providerContext', () => {
      const parts: Part[] = [{ text: 'Response', thoughtSignature: 'sig_abc' }];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents[0].providerContext?.data).toMatchObject({
        thoughtSignature: 'sig_abc',
      });
    });

    it('should aggregate multiple thought chunks into single event', () => {
      const parts: Part[] = [
        { thought: true, text: 'First thought chunk. ' },
        { thought: true, text: 'Second thought chunk. ' },
        { thought: true, text: 'Third thought chunk.' },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      const thoughtEvents = result.stepEvents.filter(
        (e) => e.type === 'thought',
      );
      expect(thoughtEvents).toHaveLength(1);
      expect(thoughtEvents[0].type === 'thought' && thoughtEvents[0].text).toBe(
        'First thought chunk. Second thought chunk. Third thought chunk.',
      );
    });

    it('should aggregate multiple assistant chunks into single event', () => {
      const parts: Part[] = [
        { text: 'Hello, ' },
        { text: 'this is ' },
        { text: 'a complete response.' },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      const assistantEvents = result.stepEvents.filter(
        (e) => e.type === 'assistant',
      );
      expect(assistantEvents).toHaveLength(1);
      expect(
        assistantEvents[0].type === 'assistant' && assistantEvents[0].text,
      ).toBe('Hello, this is a complete response.');
    });

    it('should handle interleaved chunks with function calls', () => {
      const parts: Part[] = [
        { thought: true, text: 'Let me think... ' },
        { thought: true, text: 'I should call a function.' },
        { functionCall: { name: 'search', args: { q: 'test' } } },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(2);
      expect(result.stepEvents[0].type).toBe('thought');
      expect(
        result.stepEvents[0].type === 'thought' && result.stepEvents[0].text,
      ).toBe('Let me think... I should call a function.');
      expect(result.stepEvents[1].type).toBe('tool_call');
    });

    it('should preserve thoughtSignature from any chunk when aggregating', () => {
      const parts: Part[] = [
        { thought: true, text: 'Part 1. ' },
        { thought: true, text: 'Part 2.', thoughtSignature: 'sig_found' },
        { thought: true, text: ' Part 3.' },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents[0].providerContext?.data).toMatchObject({
        thoughtSignature: 'sig_found',
      });
    });

    it('should handle empty parts array', () => {
      const result = parseResponse(
        [],
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(0);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.terminal).toBe(true);
    });

    it('should propagate signature from FC to thought (parallel FC pattern)', () => {
      const parts: Part[] = [
        { thought: true, text: 'Thinking...' },
        {
          functionCall: { name: 'search', args: {} },
          thoughtSignature: 'sig_on_fc',
        },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents[0].type).toBe('thought');
      expect(result.stepEvents[0].providerContext?.data).toMatchObject({
        thoughtSignature: 'sig_on_fc',
      });
      expect(result.stepEvents[1].type).toBe('tool_call');
      expect(result.toolCalls[0].providerContext?.data).toMatchObject({
        thoughtSignature: 'sig_on_fc',
      });
    });

    it('should not propagate signature to second parallel FC', () => {
      const parts: Part[] = [
        {
          functionCall: { name: 'tool_a', args: {} },
          thoughtSignature: 'sig_first',
        },
        { functionCall: { name: 'tool_b', args: {} } },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].providerContext?.data).toMatchObject({
        thoughtSignature: 'sig_first',
      });
      expect(result.toolCalls[1].providerContext?.data).not.toHaveProperty(
        'thoughtSignature',
      );
    });

    it('should filter empty text parts', () => {
      const parts: Part[] = [
        { text: '' },
        { thought: true, text: '' },
        { text: 'Actual content' },
      ];

      const result = parseResponse(
        parts,
        undefined,
        undefined,
        testInvocationId,
        'test_agent',
      );

      expect(result.stepEvents).toHaveLength(1);
      expect(result.stepEvents[0].type).toBe('assistant');
      expect(
        result.stepEvents[0].type === 'assistant' && result.stepEvents[0].text,
      ).toBe('Actual content');
    });
  });

  describe('serializeTools', () => {
    it('should return empty array for no tools', () => {
      const result = serializeTools([]);
      expect(result).toEqual([]);
    });

    it('should wrap tools in functionDeclarations', () => {
      const tools: Tool[] = [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          schema: z.object({ city: z.string() }),
          execute: () => ({}),
        },
      ];

      const result = serializeTools(tools);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('functionDeclarations');
      expect(result[0].functionDeclarations).toHaveLength(1);
      expect(result[0].functionDeclarations[0]).toMatchObject({
        name: 'get_weather',
        description: 'Get weather for a city',
      });
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

      expect(result[0].functionDeclarations).toHaveLength(2);
      expect(result[0].functionDeclarations[0].name).toBe('tool_a');
      expect(result[0].functionDeclarations[1].name).toBe('tool_b');
    });
  });

  describe('serializeToolConfig', () => {
    it('returns undefined when no choice or allowedTools', () => {
      expect(serializeToolConfig(undefined, undefined)).toBeUndefined();
    });

    it('serializes none as NONE mode', () => {
      expect(serializeToolConfig('none')).toEqual({
        functionCallingConfig: { mode: 'NONE' },
      });
    });

    it('serializes required as ANY mode', () => {
      expect(serializeToolConfig('required')).toEqual({
        functionCallingConfig: { mode: 'ANY' },
      });
    });

    it('serializes auto as AUTO mode', () => {
      expect(serializeToolConfig('auto')).toEqual({
        functionCallingConfig: { mode: 'AUTO' },
      });
    });

    it('serializes specific function as ANY with allowedFunctionNames', () => {
      expect(serializeToolConfig({ name: 'get_weather' })).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['get_weather'],
        },
      });
    });

    it('serializes allowedTools with AUTO mode by default', () => {
      expect(serializeToolConfig(undefined, ['tool_a', 'tool_b'])).toEqual({
        functionCallingConfig: {
          mode: 'AUTO',
          allowedFunctionNames: ['tool_a', 'tool_b'],
        },
      });
    });

    it('serializes allowedTools with ANY mode when required', () => {
      expect(serializeToolConfig('required', ['tool_a'])).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['tool_a'],
        },
      });
    });
  });
});
