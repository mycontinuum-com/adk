import { z } from 'zod';
import { runTest, user, model, testAgent, setupAdkMatchers } from './index';
import { tool } from '../core';

setupAdkMatchers();

describe('runTest() runner', () => {
  const addTool = tool({
    name: 'add',
    description: 'Add two numbers',
    schema: z.object({ a: z.number(), b: z.number() }),
    execute: (ctx) => ({ sum: ctx.args.a + ctx.args.b }),
  });

  describe('basic execution', () => {
    test('runs agent with simple response', async () => {
      const { session, status, events } = await runTest(testAgent(), [
        user('Hello'),
        model({ text: 'Hi there!' }),
      ]);

      expect(status).toBe('completed');
      expect(events).toHaveAssistantText('Hi there!');
    });

    test('matches assistant text with regex', async () => {
      const { events } = await runTest(testAgent(), [
        user('What is the weather?'),
        model({ text: 'The weather is sunny today!' }),
      ]);

      expect(events).toHaveAssistantText(/sunny/);
    });

    test('matches assistant text with custom assertion', async () => {
      const { events } = await runTest(testAgent(), [
        user('Count to 3'),
        model({ text: '1, 2, 3' }),
      ]);

      const assistantEvents = [...events].filter((e) => e.type === 'assistant');
      const lastAssistant = assistantEvents[assistantEvents.length - 1];
      expect(lastAssistant).toBeDefined();
      if (lastAssistant && 'text' in lastAssistant) {
        expect(lastAssistant.text).toContain('1');
        expect(lastAssistant.text).toContain('2');
        expect(lastAssistant.text).toContain('3');
      }
    });
  });

  describe('tool execution', () => {
    test('executes tool calls and continues', async () => {
      const { events, iterations } = await runTest(
        testAgent({ tools: [addTool] }),
        [
          user('What is 2 + 3?'),
          model({ toolCalls: [{ name: 'add', args: { a: 2, b: 3 } }] }),
          model({ text: 'The sum is 5' }),
        ],
      );

      expect(events).toHaveToolCall('add', { a: 2, b: 3 });
      expect(events).toHaveAssistantText(/5/);
      expect(iterations).toBe(2);
    });

    test('verifies tool call with custom assertion', async () => {
      const { events } = await runTest(testAgent({ tools: [addTool] }), [
        user('Add numbers'),
        model({ toolCalls: [{ name: 'add', args: { a: 10, b: 20 } }] }),
        model({ text: 'Done' }),
      ]);

      expect(events).toHaveToolCall('add');
      const toolCalls = [...events].filter((e) => e.type === 'tool_call');
      const addCall = toolCalls.find((e) => 'name' in e && e.name === 'add') as
        | { args: { a: number; b: number } }
        | undefined;
      expect(addCall).toBeDefined();
      expect(addCall!.args.a).toBeLessThan(addCall!.args.b);
    });

    test('handles multiple tool calls', async () => {
      const { events } = await runTest(testAgent({ tools: [addTool] }), [
        user('Calculate'),
        model({
          toolCalls: [
            { name: 'add', args: { a: 1, b: 1 } },
            { name: 'add', args: { a: 2, b: 2 } },
          ],
        }),
        model({ text: 'Done' }),
      ]);

      const toolCalls = [...events].filter((e) => e.type === 'tool_call');
      const toolResults = [...events].filter((e) => e.type === 'tool_result');
      expect(toolCalls.length).toBe(2);
      expect(toolResults.length).toBe(2);
    });
  });

  describe('state verification', () => {
    test('verifies session state changes', async () => {
      const stateTool = tool({
        name: 'set_value',
        description: 'Set a value',
        schema: z.object({ value: z.number() }),
        execute: (ctx) => {
          ctx.state.set('myValue', ctx.args.value);
          return { stored: true };
        },
      });

      const { session } = await runTest(testAgent({ tools: [stateTool] }), [
        user('Set value to 42'),
        model({ toolCalls: [{ name: 'set_value', args: { value: 42 } }] }),
        model({ text: 'Done' }),
      ]);

      expect(session).toHaveState('session', 'myValue', 42);
    });

    test('verifies state with custom assertion', async () => {
      const stateTool = tool({
        name: 'increment',
        description: 'Increment counter',
        schema: z.object({}),
        execute: (ctx) => {
          const current = ctx.state.get<number>('counter') ?? 0;
          ctx.state.set('counter', current + 1);
          return { counter: current + 1 };
        },
      });

      const { session } = await runTest(testAgent({ tools: [stateTool] }), [
        user('Increment'),
        model({ toolCalls: [{ name: 'increment', args: {} }] }),
        model({ text: 'Done' }),
      ]);

      const counter = session.state.session.get('counter');
      expect(counter).toBeGreaterThan(0);
    });
  });

  describe('event patterns', () => {
    test('matches event patterns', async () => {
      const { events } = await runTest(testAgent(), [
        user('Hello'),
        model({ text: 'Hi!' }),
      ]);

      expect(events).toHaveEvent({ type: 'user', text: 'Hello' });
      expect(events).toHaveEvent({ type: 'assistant', text: 'Hi!' });
    });

    test('matches events with regex in patterns', async () => {
      const { events } = await runTest(testAgent(), [
        user('Tell me a joke'),
        model({ text: 'Why did the chicken cross the road?' }),
      ]);

      expect(events).toHaveEvent({ type: 'assistant' });
      const assistantEvents = [...events].filter((e) => e.type === 'assistant');
      expect(
        assistantEvents.some(
          (e) => 'text' in e && /chicken/.test(e.text as string),
        ),
      ).toBe(true);
    });
  });

  describe('iteration tracking', () => {
    test('tracks correct number of iterations', async () => {
      const { iterations } = await runTest(testAgent(), [
        user('Hello'),
        model({ text: 'Hi!' }),
      ]);

      expect(iterations).toBe(1);
    });

    test('tracks iterations with custom assertion', async () => {
      const { iterations } = await runTest(testAgent({ tools: [addTool] }), [
        user('Calculate'),
        model({ toolCalls: [{ name: 'add', args: { a: 1, b: 1 } }] }),
        model({ text: 'Done' }),
      ]);

      expect(iterations).toBeGreaterThanOrEqual(2);
    });
  });

  describe('initial state', () => {
    test('sets initial session state', async () => {
      const readTool = tool({
        name: 'read_state',
        description: 'Read state',
        schema: z.object({}),
        execute: (ctx) => ({
          value: ctx.state.get('preset'),
        }),
      });

      const { session } = await runTest(
        testAgent({ tools: [readTool] }),
        [
          user('Read state'),
          model({ toolCalls: [{ name: 'read_state', args: {} }] }),
          model({ text: 'Done' }),
        ],
        {
          initialState: {
            session: { preset: 'initial value' },
          },
        },
      );

      expect(session.state.session.get('preset')).toBe('initial value');
    });
  });
});
