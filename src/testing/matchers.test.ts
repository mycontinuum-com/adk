import { adkMatchers, setupAdkMatchers } from './matchers';
import type {
  Event,
  AssistantEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '../types';
import { createEventId, createCallId } from '../session';

setupAdkMatchers();

const TEST_INVOCATION_ID = 'test-invocation-id';

describe('ADK Jest Matchers', () => {
  const createAssistantEvent = (text: string): AssistantEvent => ({
    id: createEventId(),
    type: 'assistant',
    createdAt: Date.now(),
    invocationId: TEST_INVOCATION_ID,
    agentName: 'test_agent',
    text,
  });

  const createToolCallEvent = (
    name: string,
    args: Record<string, unknown>,
  ): ToolCallEvent => ({
    id: createEventId(),
    type: 'tool_call',
    createdAt: Date.now(),
    invocationId: TEST_INVOCATION_ID,
    agentName: 'test_agent',
    callId: createCallId(),
    name,
    args,
  });

  const createToolResultEvent = (
    name: string,
    result: unknown,
    callId: string,
  ): ToolResultEvent => ({
    id: createEventId(),
    type: 'tool_result',
    createdAt: Date.now(),
    invocationId: TEST_INVOCATION_ID,
    agentName: 'test_agent',
    callId,
    name,
    result,
  });

  describe('toHaveAssistantText', () => {
    test('passes for exact string match', () => {
      const events: Event[] = [createAssistantEvent('Hello world')];
      expect(events).toHaveAssistantText('Hello world');
    });

    test('passes for regex match', () => {
      const events: Event[] = [createAssistantEvent('The answer is 42')];
      expect(events).toHaveAssistantText(/42/);
    });

    test('fails when no assistant event', () => {
      const events: Event[] = [];
      expect(() => {
        expect(events).toHaveAssistantText('anything');
      }).toThrow();
    });

    test('uses last assistant event', () => {
      const events: Event[] = [
        createAssistantEvent('First'),
        createAssistantEvent('Second'),
        createAssistantEvent('Third'),
      ];
      expect(events).toHaveAssistantText('Third');
    });

    test('works with object containing events', () => {
      const obj = {
        events: [createAssistantEvent('Test')] as readonly Event[],
      };
      expect(obj).toHaveAssistantText('Test');
    });
  });

  describe('toHaveToolCall', () => {
    test('passes when tool call exists', () => {
      const events: Event[] = [
        createToolCallEvent('calculate', { a: 1, b: 2 }),
      ];
      expect(events).toHaveToolCall('calculate');
    });

    test('passes when tool call has matching args', () => {
      const events: Event[] = [createToolCallEvent('add', { a: 5, b: 10 })];
      expect(events).toHaveToolCall('add', { a: 5, b: 10 });
    });

    test('fails when tool call not found', () => {
      const events: Event[] = [createToolCallEvent('other', {})];
      expect(() => {
        expect(events).toHaveToolCall('missing');
      }).toThrow();
    });

    test('fails when args do not match', () => {
      const events: Event[] = [createToolCallEvent('add', { a: 1, b: 2 })];
      expect(() => {
        expect(events).toHaveToolCall('add', { a: 100, b: 200 });
      }).toThrow();
    });
  });

  describe('toHaveToolResult', () => {
    test('passes when tool result exists', () => {
      const callId = createCallId();
      const events: Event[] = [
        createToolResultEvent('calculate', { sum: 5 }, callId),
      ];
      expect(events).toHaveToolResult('calculate');
    });

    test('passes when result matches', () => {
      const callId = createCallId();
      const events: Event[] = [
        createToolResultEvent('add', { sum: 15 }, callId),
      ];
      expect(events).toHaveToolResult('add', { sum: 15 });
    });

    test('fails when result does not exist', () => {
      const events: Event[] = [];
      expect(() => {
        expect(events).toHaveToolResult('missing');
      }).toThrow();
    });
  });

  describe('toHaveEventSequence', () => {
    test('passes for correct sequence', () => {
      const events = [
        { type: 'user' as const, id: '1', createdAt: Date.now(), text: 'Hi' },
        createAssistantEvent('Hello'),
      ];
      expect(events).toHaveEventSequence(['user', 'assistant']);
    });

    test('filters to only specified types', () => {
      const callId = createCallId();
      const events = [
        { type: 'user' as const, id: '1', createdAt: Date.now(), text: 'Hi' },
        createToolCallEvent('test', {}),
        createToolResultEvent('test', {}, callId),
        createAssistantEvent('Done'),
      ];
      expect(events).toHaveEventSequence([
        'user',
        'tool_call',
        'tool_result',
        'assistant',
      ]);
    });

    test('fails for incorrect order', () => {
      const events = [
        createAssistantEvent('Hello'),
        { type: 'user' as const, id: '1', createdAt: Date.now(), text: 'Hi' },
      ];
      expect(() => {
        expect(events).toHaveEventSequence(['user', 'assistant']);
      }).toThrow();
    });
  });

  describe('toHaveStatus', () => {
    test('passes for matching status', () => {
      const result = { status: 'completed' };
      expect(result).toHaveStatus('completed');
    });

    test('works with nested result', () => {
      const obj = { result: { status: 'yielded' } };
      expect(obj).toHaveStatus('yielded');
    });

    test('fails for mismatched status', () => {
      const result = { status: 'error' };
      expect(() => {
        expect(result).toHaveStatus('completed');
      }).toThrow();
    });
  });
});
