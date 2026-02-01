import { z } from 'zod';
import { runTest, user, model, testAgent, setupAdkMatchers } from '../testing';
import { tool } from '../core';
import { defaultHandler } from '../errors';
import type { ModelStepResult, UserEvent } from '../types';

setupAdkMatchers();

describe('agent hooks', () => {
  describe('beforeAgent', () => {
    test('beforeAgent can skip execution by returning value', async () => {
      const agent = testAgent({
        hooks: { beforeAgent: () => 'Skipped by hook' },
      });

      const { events, iterations, status } = await runTest(agent, [
        user('Test'),
      ]);

      expect(events).toHaveAssistantText('Skipped by hook');
      expect(iterations).toBe(0);
      expect(status).toBe('completed');
    });

    test('beforeAgent returning undefined continues execution', async () => {
      let hookCalled = false;
      const agent = testAgent({
        hooks: {
          beforeAgent: () => {
            hookCalled = true;
            return undefined;
          },
        },
      });

      const { events } = await runTest(agent, [
        user('Test'),
        model({ text: 'Normal response' }),
      ]);

      expect(events).toHaveAssistantText('Normal response');
      expect(hookCalled).toBe(true);
    });
  });

  describe('afterAgent', () => {
    test('afterAgent can transform output', async () => {
      const agent = testAgent({
        hooks: { afterAgent: (_, output) => `${output} [modified]` },
      });

      const { result } = await runTest(agent, [
        user('Test'),
        model({ text: 'Original' }),
      ]);

      expect(result.status).toBe('completed');
      if (result.status === 'completed') {
        expect(result.output).toBe('Original [modified]');
      }
    });
  });

  describe('beforeModel', () => {
    test('beforeModel can skip model call and return result', async () => {
      const agent = testAgent({
        hooks: {
          beforeModel: (_ctx, renderCtx): ModelStepResult | void => {
            const lastUser = renderCtx.events
              .filter((e) => e.type === 'user')
              .pop();
            if (
              lastUser?.type === 'user' &&
              lastUser.text.includes('blocked')
            ) {
              return {
                stepEvents: [
                  {
                    id: 'x',
                    type: 'assistant',
                    createdAt: Date.now(),
                    invocationId: renderCtx.invocationId,
                    agentName: renderCtx.agentName,
                    text: 'Blocked by hook',
                  },
                ],
                toolCalls: [],
                terminal: true,
              };
            }
          },
        },
      });

      const { events } = await runTest(agent, [
        user('This is blocked content'),
      ]);

      expect(events).toHaveAssistantText('Blocked by hook');
    });
  });

  describe('afterModel', () => {
    test('afterModel can modify result', async () => {
      const agent = testAgent({
        hooks: {
          afterModel: (_, result) => ({
            ...result,
            stepEvents: result.stepEvents.map((e) =>
              e.type === 'assistant'
                ? { ...e, text: `${e.text} [post-processed]` }
                : e,
            ),
          }),
        },
      });

      const { events } = await runTest(agent, [
        user('Test'),
        model({ text: 'Response' }),
      ]);

      expect(events).toHaveAssistantText('Response [post-processed]');
    });
  });

  describe('beforeTool', () => {
    test('beforeTool can block tool execution', async () => {
      const myTool = tool({
        name: 'secret_tool',
        description: 'Secret',
        schema: z.object({}),
        execute: (ctx) => ({ secret: true }),
      });

      const agent = testAgent({
        tools: [myTool],
        hooks: {
          beforeTool: (ctx, call) => ({
            id: 'x',
            type: 'tool_result',
            createdAt: Date.now(),
            invocationId: ctx.invocationId,
            agentName: ctx.runnable.name,
            callId: call.callId,
            name: call.name,
            error: 'Tool blocked by hook',
          }),
        },
      });

      const { events } = await runTest(agent, [
        user('Use secret tool'),
        model({ toolCalls: [{ name: 'secret_tool', args: {} }] }),
        model({ text: 'Tool was blocked' }),
      ]);

      const toolResults = [...events].filter((e) => e.type === 'tool_result');
      expect(
        toolResults.some(
          (r) => r.type === 'tool_result' && r.error === 'Tool blocked by hook',
        ),
      ).toBe(true);
    });
  });

  describe('afterTool', () => {
    test('afterTool can modify tool result', async () => {
      const myTool = tool({
        name: 'data_tool',
        description: 'Get data',
        schema: z.object({}),
        execute: (ctx) => ({ value: 1 }),
      });

      const agent = testAgent({
        tools: [myTool],
        hooks: {
          afterTool: (_, r) => ({
            ...r,
            result: {
              ...(r.result as Record<string, unknown>),
              modified: true,
            },
          }),
        },
      });

      const { events } = await runTest(agent, [
        user('Get data'),
        model({ toolCalls: [{ name: 'data_tool', args: {} }] }),
        model({ text: 'Done' }),
      ]);

      const toolResults = [...events].filter((e) => e.type === 'tool_result');
      const dataResult = toolResults.find(
        (r) => r.type === 'tool_result' && r.name === 'data_tool',
      );
      expect(dataResult?.type === 'tool_result' && dataResult.result).toEqual({
        value: 1,
        modified: true,
      });
    });
  });
});

describe('tool error handling', () => {
  test('handles tool validation errors', async () => {
    const strictTool = tool({
      name: 'strict',
      description: 'Strict tool',
      schema: z.object({
        email: z.string().email(),
        count: z.number().positive(),
      }),
      execute: (ctx) => ctx.args,
    });

    const { events } = await runTest(testAgent({ tools: [strictTool] }), [
      user('Call strict'),
      model({
        toolCalls: [{ name: 'strict', args: { email: 'invalid', count: 1 } }],
      }),
      model({ text: 'Done' }),
    ]);

    const toolResults = [...events].filter((e) => e.type === 'tool_result');
    expect(
      toolResults.some(
        (r) =>
          r.type === 'tool_result' && r.error?.includes('Invalid arguments'),
      ),
    ).toBe(true);
  });

  test('handles unknown tool calls', async () => {
    const { events } = await runTest(testAgent(), [
      user('Call unknown'),
      model({ toolCalls: [{ name: 'nonexistent', args: {} }] }),
      model({ text: 'Handled' }),
    ]);

    const toolResults = [...events].filter((e) => e.type === 'tool_result');
    expect(
      toolResults.some(
        (r) =>
          r.type === 'tool_result' && r.error === 'Unknown tool: nonexistent',
      ),
    ).toBe(true);
  });

  test('handles tool execution errors with errorHandler', async () => {
    const failTool = tool({
      name: 'fail',
      description: 'Fails',
      schema: z.object({}),
      execute: (ctx) => {
        throw new Error('Tool execution failed');
      },
    });

    const { events } = await runTest(
      testAgent({ tools: [failTool], errorHandlers: [defaultHandler()] }),
      [
        user('Call failing tool'),
        model({ toolCalls: [{ name: 'fail', args: {} }] }),
        model({ text: 'Continued after error' }),
      ],
    );

    const toolResults = [...events].filter((e) => e.type === 'tool_result');
    expect(
      toolResults.some(
        (r) => r.type === 'tool_result' && r.error?.includes('failed'),
      ),
    ).toBe(true);
    expect(events).toHaveAssistantText('Continued after error');
  });
});

describe('tool timeout and retry', () => {
  test('tool with timeout times out after configured duration', async () => {
    const slowTool = tool({
      name: 'slow',
      description: 'Slow tool',
      schema: z.object({}),
      timeout: 50,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { done: true };
      },
    });

    const { events } = await runTest(
      testAgent({ tools: [slowTool], errorHandlers: [defaultHandler()] }),
      [
        user('Call slow tool'),
        model({ toolCalls: [{ name: 'slow', args: {} }] }),
        model({ text: 'Done' }),
      ],
    );

    const toolResults = [...events].filter((e) => e.type === 'tool_result');
    expect(
      toolResults.some(
        (r) => r.type === 'tool_result' && r.error?.includes('timed out'),
      ),
    ).toBe(true);
  });

  test('tool with retry succeeds after failures', async () => {
    let attempts = 0;
    const flakyTool = tool({
      name: 'flaky',
      description: 'Fails first two times',
      schema: z.object({}),
      retry: {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 50,
        backoffMultiplier: 2,
      },
      execute: async () => {
        attempts++;
        if (attempts < 3) throw new Error(`Attempt ${attempts} failed`);
        return { success: true };
      },
    });

    const { events } = await runTest(testAgent({ tools: [flakyTool] }), [
      user('Call flaky tool'),
      model({ toolCalls: [{ name: 'flaky', args: {} }] }),
      model({ text: 'Done' }),
    ]);

    expect(attempts).toBe(3);
    const toolResults = [...events].filter((e) => e.type === 'tool_result');
    const flakyResult = toolResults.find(
      (r) => r.type === 'tool_result' && r.name === 'flaky',
    );
    expect(flakyResult?.type === 'tool_result' && flakyResult.result).toEqual({
      success: true,
    });
  });

  test('tool with retry fails after max attempts', async () => {
    let attempts = 0;
    const alwaysFailsTool = tool({
      name: 'always_fails',
      description: 'Always fails',
      schema: z.object({}),
      retry: {
        maxAttempts: 3,
        initialDelayMs: 5,
        maxDelayMs: 20,
        backoffMultiplier: 2,
      },
      execute: async () => {
        attempts++;
        throw new Error(`Attempt ${attempts} failed`);
      },
    });

    const { events } = await runTest(
      testAgent({
        tools: [alwaysFailsTool],
        errorHandlers: [defaultHandler()],
      }),
      [
        user('Call failing tool'),
        model({ toolCalls: [{ name: 'always_fails', args: {} }] }),
        model({ text: 'Done' }),
      ],
    );

    expect(attempts).toBe(3);
    const toolResults = [...events].filter((e) => e.type === 'tool_result');
    expect(
      toolResults.some(
        (r) => r.type === 'tool_result' && r.error?.includes('failed'),
      ),
    ).toBe(true);
  });
});

describe('maxSteps', () => {
  test('stops after maxSteps iterations', async () => {
    const loopTool = tool({
      name: 'loop',
      description: 'Loop tool',
      schema: z.object({}),
      execute: (ctx) => ({}),
    });

    const { iterations } = await runTest(
      testAgent({ tools: [loopTool], maxSteps: 2 }),
      [
        user('Loop forever'),
        model({ toolCalls: [{ name: 'loop', args: {} }] }),
        model({ toolCalls: [{ name: 'loop', args: {} }] }),
        model({ text: 'Should not reach' }),
      ],
    );

    expect(iterations).toBe(2);
  });
});

describe('thought events', () => {
  test('includes thought events when present', async () => {
    const { events } = await runTest(testAgent(), [
      user('Think about this'),
      model({ thought: 'Thinking deeply...', text: 'Response' }),
    ]);

    const thoughtEvents = [...events].filter((e) => e.type === 'thought');
    expect(thoughtEvents).toHaveLength(1);
  });
});

describe('invocation tracking', () => {
  test('creates invocation start and end events with matching IDs', async () => {
    const { events } = await runTest(testAgent({ name: 'tracked' }), [
      user('Test'),
      model({ text: 'Response' }),
    ]);

    const starts = [...events].filter((e) => e.type === 'invocation_start');
    const ends = [...events].filter((e) => e.type === 'invocation_end');

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0].type === 'invocation_start' && starts[0].agentName).toBe(
      'tracked',
    );
    expect(
      starts[0].type === 'invocation_start' &&
        ends[0].type === 'invocation_end' &&
        ends[0].invocationId,
    ).toBe(starts[0].type === 'invocation_start' && starts[0].invocationId);
    expect(ends[0].type === 'invocation_end' && ends[0].reason).toBe(
      'completed',
    );
  });

  test('events include invocation ID', async () => {
    const { events } = await runTest(testAgent(), [
      user('Test'),
      model({ text: 'Response' }),
    ]);

    const assistantEvents = [...events].filter((e) => e.type === 'assistant');
    expect(assistantEvents[0].invocationId).toBeDefined();
  });
});

describe('structured output', () => {
  const ProductSchema = z.object({
    name: z.string(),
    price: z.number(),
    inStock: z.boolean(),
  });

  test('saves structured output with custom key', async () => {
    const agent = testAgent({
      output: { schema: ProductSchema, key: 'currentProduct' },
    });

    const { session } = await runTest(agent, [
      user('Get product'),
      model({
        text: JSON.stringify({ name: 'Tool', price: 15.0, inStock: true }),
      }),
    ]);

    expect(session.state.currentProduct).toEqual({
      name: 'Tool',
      price: 15.0,
      inStock: true,
    });
  });
});

describe('tool state modification', () => {
  test('tool can modify session state', async () => {
    const stateTool = tool({
      name: 'set',
      description: 'Set state',
      schema: z.object({ v: z.number() }),
      execute: (ctx) => {
        ctx.state.val = ctx.args.v;
        return { set: true };
      },
    });

    const { session } = await runTest(testAgent({ tools: [stateTool] }), [
      user('Set value'),
      model({ toolCalls: [{ name: 'set', args: { v: 42 } }] }),
      model({ text: 'Done' }),
    ]);

    expect(session).toHaveState('session', 'val', 42);
  });
});
