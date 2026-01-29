import { z } from 'zod';
import { BaseRunner, tool } from './index';
import { MockAdapter, createTestSession, testAgent } from '../testing';
import type { StreamEvent } from '../types';

describe('Event Consistency', () => {
  let mockAdapter: MockAdapter;
  let runner: BaseRunner;

  beforeEach(() => {
    mockAdapter = new MockAdapter();
    runner = new BaseRunner({
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    });
  });

  const collectEvents = async (
    responses: Parameters<MockAdapter['setResponses']>[0],
    options?: { tools?: ReturnType<typeof tool>[] },
  ) => {
    mockAdapter.setResponses(responses);
    const events: StreamEvent[] = [];
    const session = createTestSession('Test');

    for await (const event of runner.run(
      testAgent({ tools: options?.tools }),
      session,
    )) {
      events.push(event);
    }

    return { events, session };
  };

  describe('1. Uniqueness - each event emitted exactly once', () => {
    test('thought events: exactly one per reasoning segment', async () => {
      const { events } = await collectEvents([
        { thought: 'Thinking...', text: 'Response' },
      ]);

      const thoughtEvents = events.filter((e) => e.type === 'thought');
      expect(thoughtEvents).toHaveLength(1);
    });

    test('assistant events: exactly one per response', async () => {
      const { events } = await collectEvents([{ text: 'Hello world' }]);

      const assistantEvents = events.filter((e) => e.type === 'assistant');
      expect(assistantEvents).toHaveLength(1);
    });

    test('tool_call events: each call appears exactly once', async () => {
      const myTool = tool({
        name: 'test_tool',
        description: 'Test',
        schema: z.object({ x: z.number() }),
        execute: () => ({ result: 'ok' }),
      });

      const { events } = await collectEvents(
        [
          { toolCalls: [{ name: 'test_tool', args: { x: 1 } }] },
          { text: 'Done' },
        ],
        { tools: [myTool] },
      );

      const toolCallEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
    });

    test('tool_call events: multiple calls each appear once', async () => {
      const toolA = tool({
        name: 'tool_a',
        description: 'A',
        schema: z.object({}),
        execute: () => ({}),
      });
      const toolB = tool({
        name: 'tool_b',
        description: 'B',
        schema: z.object({}),
        execute: () => ({}),
      });

      const { events } = await collectEvents(
        [
          {
            toolCalls: [
              { name: 'tool_a', args: {} },
              { name: 'tool_b', args: {} },
            ],
          },
          { text: 'Done' },
        ],
        { tools: [toolA, toolB] },
      );

      const toolCallEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolCallEvents).toHaveLength(2);

      const names = toolCallEvents.map((e) =>
        e.type === 'tool_call' ? e.name : '',
      );
      expect(names).toContain('tool_a');
      expect(names).toContain('tool_b');
    });

    test('tool_result events: each result appears exactly once', async () => {
      const myTool = tool({
        name: 'test',
        description: 'Test',
        schema: z.object({}),
        execute: () => ({ value: 42 }),
      });

      const { events } = await collectEvents(
        [{ toolCalls: [{ name: 'test', args: {} }] }, { text: 'Done' }],
        { tools: [myTool] },
      );

      const toolResultEvents = events.filter((e) => e.type === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
    });

    test('invocation_start: exactly one per invocation', async () => {
      const { events } = await collectEvents([{ text: 'Response' }]);

      const startEvents = events.filter((e) => e.type === 'invocation_start');
      expect(startEvents).toHaveLength(1);
    });

    test('invocation_end: exactly one per invocation', async () => {
      const { events } = await collectEvents([{ text: 'Response' }]);

      const endEvents = events.filter((e) => e.type === 'invocation_end');
      expect(endEvents).toHaveLength(1);
    });

    test('streaming does not cause duplicate complete events', async () => {
      const { events } = await collectEvents([
        { thought: 'Thinking hard', text: 'Answer', streamChunks: true },
      ]);

      const thoughtEvents = events.filter((e) => e.type === 'thought');
      const assistantEvents = events.filter((e) => e.type === 'assistant');

      expect(thoughtEvents).toHaveLength(1);
      expect(assistantEvents).toHaveLength(1);
    });
  });

  describe('2. Completeness - events contain full, unfragmented content', () => {
    test('thought event has complete text', async () => {
      const { events } = await collectEvents([
        { thought: 'First. Second. Third.', text: 'Done' },
      ]);

      const thought = events.find((e) => e.type === 'thought');
      expect(thought?.type === 'thought' && thought.text).toBe(
        'First. Second. Third.',
      );
    });

    test('assistant event has complete text', async () => {
      const { events } = await collectEvents([
        { text: 'Hello, this is a complete response.' },
      ]);

      const assistant = events.find((e) => e.type === 'assistant');
      expect(assistant?.type === 'assistant' && assistant.text).toBe(
        'Hello, this is a complete response.',
      );
    });

    test('streaming produces complete event with full accumulated text', async () => {
      const { events } = await collectEvents([
        { text: 'Streamed response content', streamChunks: true, chunkSize: 5 },
      ]);

      const assistant = events.find((e) => e.type === 'assistant');
      expect(assistant?.type === 'assistant' && assistant.text).toBe(
        'Streamed response content',
      );
    });

    test('all events have invocationId', async () => {
      const myTool = tool({
        name: 'test',
        description: 'Test',
        schema: z.object({}),
        execute: () => ({}),
      });

      const { events } = await collectEvents(
        [
          { thought: 'Thinking', toolCalls: [{ name: 'test', args: {} }] },
          { text: 'Done' },
        ],
        { tools: [myTool] },
      );

      const eventsWithInvocationId = [
        'thought',
        'tool_call',
        'tool_result',
        'assistant',
        'invocation_start',
        'invocation_end',
      ];

      for (const type of eventsWithInvocationId) {
        const event = events.find((e) => e.type === type);
        if (event) {
          expect(event.invocationId).toBeDefined();
          expect(event.invocationId).toMatch(/^inv_/);
        }
      }
    });
  });

  describe('3. Ordering - events arrive in correct sequence', () => {
    test('invocation_start is first event', async () => {
      const { events } = await collectEvents([{ text: 'Response' }]);

      expect(events[0].type).toBe('invocation_start');
    });

    test('invocation_end is last event', async () => {
      const { events } = await collectEvents([{ text: 'Response' }]);

      expect(events[events.length - 1].type).toBe('invocation_end');
    });

    test('deltas arrive before complete event', async () => {
      const { events } = await collectEvents([
        { text: 'Response', streamChunks: true },
      ]);

      const types = events.map((e) => e.type);
      const lastDeltaIdx = types.lastIndexOf('assistant_delta');
      const completeIdx = types.indexOf('assistant');

      expect(lastDeltaIdx).toBeLessThan(completeIdx);
    });

    test('thought events precede assistant events', async () => {
      const { events } = await collectEvents([
        { thought: 'Thinking', text: 'Response' },
      ]);

      const types = events.map((e) => e.type);
      const thoughtIdx = types.indexOf('thought');
      const assistantIdx = types.indexOf('assistant');

      expect(thoughtIdx).toBeLessThan(assistantIdx);
    });

    test('tool_call precedes tool_result', async () => {
      const myTool = tool({
        name: 'test',
        description: 'Test',
        schema: z.object({}),
        execute: () => ({}),
      });

      const { events } = await collectEvents(
        [{ toolCalls: [{ name: 'test', args: {} }] }, { text: 'Done' }],
        { tools: [myTool] },
      );

      const types = events.map((e) => e.type);
      const callIdx = types.indexOf('tool_call');
      const resultIdx = types.indexOf('tool_result');

      expect(callIdx).toBeLessThan(resultIdx);
    });

    test('multi-step: step N completes before step N+1 starts', async () => {
      const myTool = tool({
        name: 'test',
        description: 'Test',
        schema: z.object({}),
        execute: () => ({}),
      });

      const { events } = await collectEvents(
        [
          { thought: 'Step 1', toolCalls: [{ name: 'test', args: {} }] },
          { thought: 'Step 2', text: 'Done' },
        ],
        { tools: [myTool] },
      );

      const thoughtEvents = events.filter((e) => e.type === 'thought');
      const thoughtIndices = thoughtEvents.map((e) => events.indexOf(e));

      const toolResultIdx = events.findIndex((e) => e.type === 'tool_result');

      expect(thoughtIndices[0]).toBeLessThan(toolResultIdx);
      expect(thoughtIndices[1]).toBeGreaterThan(toolResultIdx);
    });
  });

  describe('4. Parity - iterator and callbacks receive identical events', () => {
    test('iterator and onStream receive same events', async () => {
      mockAdapter.setResponses([
        { thought: 'Thinking', text: 'Response', streamChunks: true },
      ]);

      const iteratorEvents: StreamEvent[] = [];
      const callbackEvents: StreamEvent[] = [];

      for await (const event of runner.run(
        testAgent(),
        createTestSession('Test'),
        { onStream: (e) => callbackEvents.push(e) },
      )) {
        iteratorEvents.push(event);
      }

      expect(iteratorEvents.length).toBe(callbackEvents.length);
    });

    test('event IDs match between iterator and onStream', async () => {
      mockAdapter.setResponses([{ text: 'Response' }]);

      const iteratorEvents: StreamEvent[] = [];
      const callbackEvents: StreamEvent[] = [];

      for await (const event of runner.run(
        testAgent(),
        createTestSession('Test'),
        { onStream: (e) => callbackEvents.push(e) },
      )) {
        iteratorEvents.push(event);
      }

      for (let i = 0; i < iteratorEvents.length; i++) {
        expect(iteratorEvents[i].id).toBe(callbackEvents[i].id);
      }
    });

    test('event types match between iterator and onStream', async () => {
      mockAdapter.setResponses([
        { thought: 'Thinking', text: 'Response', streamChunks: true },
      ]);

      const iteratorEvents: StreamEvent[] = [];
      const callbackEvents: StreamEvent[] = [];

      for await (const event of runner.run(
        testAgent(),
        createTestSession('Test'),
        { onStream: (e) => callbackEvents.push(e) },
      )) {
        iteratorEvents.push(event);
      }

      for (let i = 0; i < iteratorEvents.length; i++) {
        expect(iteratorEvents[i].type).toBe(callbackEvents[i].type);
      }
    });
  });

  describe('5. Persistence - session state is correct', () => {
    test('session contains complete events (thought, assistant)', async () => {
      const { session } = await collectEvents([
        { thought: 'Thinking', text: 'Response' },
      ]);

      const sessionThought = session.events.find((e) => e.type === 'thought');
      const sessionAssistant = session.events.find(
        (e) => e.type === 'assistant',
      );

      expect(sessionThought).toBeDefined();
      expect(sessionAssistant).toBeDefined();
    });

    test('session contains tool events', async () => {
      const myTool = tool({
        name: 'test',
        description: 'Test',
        schema: z.object({}),
        execute: () => ({ value: 1 }),
      });

      const { session } = await collectEvents(
        [{ toolCalls: [{ name: 'test', args: {} }] }, { text: 'Done' }],
        { tools: [myTool] },
      );

      const sessionToolCall = session.events.find(
        (e) => e.type === 'tool_call',
      );
      const sessionToolResult = session.events.find(
        (e) => e.type === 'tool_result',
      );

      expect(sessionToolCall).toBeDefined();
      expect(sessionToolResult).toBeDefined();
    });

    test('session does not contain delta events', async () => {
      const { session } = await collectEvents([
        { text: 'Response', streamChunks: true },
      ]);

      const deltaTypes = ['thought_delta', 'assistant_delta'];
      const deltas = session.events.filter((e) => deltaTypes.includes(e.type));

      expect(deltas).toHaveLength(0);
    });

    test('session event IDs match yielded event IDs', async () => {
      const { events, session } = await collectEvents([
        { thought: 'Thinking', text: 'Response' },
      ]);

      const yieldedThought = events.find((e) => e.type === 'thought');
      const yieldedAssistant = events.find((e) => e.type === 'assistant');
      const sessionThought = session.events.find((e) => e.type === 'thought');
      const sessionAssistant = session.events.find(
        (e) => e.type === 'assistant',
      );

      expect(sessionThought?.id).toBe(yieldedThought?.id);
      expect(sessionAssistant?.id).toBe(yieldedAssistant?.id);
    });

    test('session contains invocation boundary events', async () => {
      const { session } = await collectEvents([{ text: 'Response' }]);

      const start = session.events.find((e) => e.type === 'invocation_start');
      const end = session.events.find((e) => e.type === 'invocation_end');

      expect(start).toBeDefined();
      expect(end).toBeDefined();
    });
  });

  describe('6. Multi-turn consistency', () => {
    test('events from first turn are available in second turn context', async () => {
      mockAdapter.setResponses([{ text: 'First response' }]);

      const session = createTestSession('First message');
      for await (const _ of runner.run(testAgent(), session)) {
        // consume events
      }

      const firstAssistant = session.events.find((e) => e.type === 'assistant');
      expect(firstAssistant).toBeDefined();

      session.addMessage('Second message');
      mockAdapter.setResponses([{ text: 'Second response' }]);

      for await (const _ of runner.run(testAgent(), session)) {
        // consume events
      }

      const assistants = session.events.filter((e) => e.type === 'assistant');
      expect(assistants).toHaveLength(2);
    });
  });
});
