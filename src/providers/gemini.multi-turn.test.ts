import { z } from 'zod';
// @ts-ignore @google/genai is ESM-only but bundler handles it
import type { Content } from '@google/genai';
import {
  agent,
  tool,
  loop,
  gemini,
  injectSystemMessage,
  includeHistory,
  buildContext,
} from '../index';
import { runTest, user, model, setupAdkMatchers } from '../testing';
import { serializeContext } from './gemini';
import type {
  RenderContext,
  Event,
  ToolCallEvent,
  ToolResultEvent,
} from '../types';

setupAdkMatchers();

const echoTool = tool({
  name: 'echo',
  description: 'Echoes back the input',
  schema: z.object({
    message: z.string().describe('Message to echo'),
  }),
  execute: (ctx) => ({ echoed: ctx.args.message }),
});

const calculatorTool = tool({
  name: 'calculate',
  description: 'Performs a calculation',
  schema: z.object({
    expression: z.string().describe('Math expression'),
  }),
  execute: (ctx) => {
    try {
      const result = Function(
        `"use strict"; return (${ctx.args.expression})`,
      )();
      return { result };
    } catch {
      return { error: 'Invalid expression' };
    }
  },
});

describe('Gemini multi-turn tool call handling', () => {
  describe('tool results from previous turns', () => {
    it('should include tool_call and tool_result events from previous turn in context', async () => {
      const testAgent = agent({
        name: 'test_agent',
        model: gemini('gemini-2.0-flash'),
        context: [
          injectSystemMessage('You are a test assistant.'),
          includeHistory(),
        ],
        tools: [echoTool],
      });

      const { session, events, status } = await runTest(testAgent, [
        user('Echo "hello"'),
        model({ toolCalls: [{ name: 'echo', args: { message: 'hello' } }] }),
        model({ text: 'I echoed: hello' }),
      ]);

      expect(events).toHaveToolCall('echo', { message: 'hello' });
      expect(events).toHaveAssistantText(/echoed/i);
      expect(status).toBe('completed');

      const capturedContext = buildContext(
        session,
        testAgent,
        'test-invocation',
      );
      expect(capturedContext).not.toBeNull();

      const toolCallEvents = capturedContext.events.filter(
        (e): e is ToolCallEvent => e.type === 'tool_call',
      );
      const toolResultEvents = capturedContext.events.filter(
        (e): e is ToolResultEvent => e.type === 'tool_result',
      );

      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
      expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);

      const { contents, systemInstruction } = serializeContext(capturedContext);

      const hasFunctionCall = contents.some((c: Content) =>
        c.parts?.some((p) => p.functionCall !== undefined),
      );
      const hasFunctionResponse = contents.some((c: Content) =>
        c.parts?.some((p) => p.functionResponse !== undefined),
      );

      expect(hasFunctionCall).toBe(true);
      expect(hasFunctionResponse).toBe(true);

      const functionCallContent = contents.find((c: Content) =>
        c.parts?.some((p) => p.functionCall?.name === 'echo'),
      );
      expect(functionCallContent?.role).toBe('model');

      const functionResponseContent = contents.find((c: Content) =>
        c.parts?.some((p) => p.functionResponse?.name === 'echo'),
      );
      expect(functionResponseContent?.role).toBe('user');
    });

    it('should serialize multi-turn conversation with tool calls correctly', async () => {
      const testAgent = agent({
        name: 'test_agent',
        model: gemini('gemini-2.0-flash'),
        context: [
          injectSystemMessage('You are a calculator assistant.'),
          includeHistory(),
        ],
        tools: [calculatorTool],
      });

      const { session, status } = await runTest(testAgent, [
        user('What is 2 + 2?'),
        model({
          toolCalls: [{ name: 'calculate', args: { expression: '2+2' } }],
        }),
        model({ text: 'The answer is 4' }),
      ]);

      expect(status).toBe('completed');

      const firstTurnContext = buildContext(session, testAgent, 'turn1');
      expect(firstTurnContext).not.toBeNull();

      const firstTurnSerialized = serializeContext(firstTurnContext);

      console.log('\n=== First turn serialized contents ===');
      firstTurnSerialized.contents.forEach((c: Content, i: number) => {
        console.log(`[${i}] Role: ${c.role}`);
        c.parts?.forEach((p, j) => {
          if (p.text)
            console.log(`  Part ${j}: text = "${p.text.substring(0, 50)}..."`);
          if (p.functionCall)
            console.log(`  Part ${j}: functionCall = ${p.functionCall.name}`);
          if (p.functionResponse)
            console.log(
              `  Part ${j}: functionResponse = ${p.functionResponse.name}`,
            );
        });
      });

      expect(firstTurnSerialized.contents.length).toBeGreaterThan(0);

      const hasCalculateFunctionCall = firstTurnSerialized.contents.some(
        (c: Content) =>
          c.parts?.some((p) => p.functionCall?.name === 'calculate'),
      );
      const hasCalculateFunctionResponse = firstTurnSerialized.contents.some(
        (c: Content) =>
          c.parts?.some((p) => p.functionResponse?.name === 'calculate'),
      );

      expect(hasCalculateFunctionCall).toBe(true);
      expect(hasCalculateFunctionResponse).toBe(true);
    });

    it('should preserve tool results across loop iterations', async () => {
      const testAgent = agent({
        name: 'loop_agent',
        model: gemini('gemini-2.0-flash'),
        context: [
          injectSystemMessage('You are a helpful assistant with a calculator.'),
          includeHistory(),
        ],
        tools: [calculatorTool],
      });

      const chat = loop({
        name: 'chat',
        runnable: testAgent,
        maxIterations: 3,
        yields: true,
        while: () => true,
      });

      const { session } = await runTest(chat, [
        user('What is 5 * 5?'),
        model({
          toolCalls: [{ name: 'calculate', args: { expression: '5*5' } }],
        }),
        model({ text: 'The result is 25' }),
      ]);

      const firstIterContext = buildContext(session, testAgent, 'iter1');
      const serialized = serializeContext(firstIterContext);

      console.log('\n=== Loop iteration context ===');
      serialized.contents.forEach((c: Content, i: number) => {
        console.log(`[${i}] Role: ${c.role}`);
        c.parts?.forEach((p, j) => {
          if (p.text)
            console.log(`  Part ${j}: text = "${p.text.substring(0, 80)}..."`);
          if (p.functionCall)
            console.log(
              `  Part ${j}: functionCall = ${JSON.stringify(p.functionCall)}`,
            );
          if (p.functionResponse)
            console.log(
              `  Part ${j}: functionResponse = ${JSON.stringify(p.functionResponse)}`,
            );
        });
      });

      const toolResultEvents = firstIterContext.events.filter(
        (e) => e.type === 'tool_result',
      );
      expect(toolResultEvents.length).toBeGreaterThan(0);

      const hasFunctionResponse = serialized.contents.some((c: Content) =>
        c.parts?.some((p) => p.functionResponse !== undefined),
      );
      expect(hasFunctionResponse).toBe(true);
    });
  });

  describe('role grouping validation', () => {
    it('should maintain correct role sequence: user -> model (tool_call) -> user (tool_result) -> model (response)', async () => {
      const testAgent = agent({
        name: 'role_test_agent',
        model: gemini('gemini-2.0-flash'),
        context: [injectSystemMessage('Test agent'), includeHistory()],
        tools: [echoTool],
      });

      const { session, status } = await runTest(testAgent, [
        user('Echo test'),
        model({ toolCalls: [{ name: 'echo', args: { message: 'test' } }] }),
        model({ text: 'Done' }),
      ]);

      expect(status).toBe('completed');

      const capturedContext = buildContext(session, testAgent, 'test');
      const serialized = serializeContext(capturedContext);

      const contentRoles = serialized.contents.map((c: Content) => ({
        role: c.role,
        hasText: c.parts?.some((p) => p.text) ?? false,
        hasFunctionCall: c.parts?.some((p) => p.functionCall) ?? false,
        hasFunctionResponse: c.parts?.some((p) => p.functionResponse) ?? false,
      }));

      console.log('\n=== Content role sequence ===');
      contentRoles.forEach((r, i) => {
        console.log(
          `[${i}] ${r.role}: text=${r.hasText}, functionCall=${r.hasFunctionCall}, functionResponse=${r.hasFunctionResponse}`,
        );
      });

      const expectedSequence = [
        { role: 'user', hasText: true },
        { role: 'model', hasFunctionCall: true },
        { role: 'user', hasFunctionResponse: true },
        { role: 'model', hasText: true },
      ];

      expect(contentRoles.length).toBeGreaterThanOrEqual(4);

      expectedSequence.forEach((expected, i) => {
        expect(contentRoles[i]?.role).toBe(expected.role);
        if (expected.hasText) expect(contentRoles[i]?.hasText).toBe(true);
        if (expected.hasFunctionCall)
          expect(contentRoles[i]?.hasFunctionCall).toBe(true);
        if (expected.hasFunctionResponse)
          expect(contentRoles[i]?.hasFunctionResponse).toBe(true);
      });
    });
  });

  describe('consecutive tool calls', () => {
    it('should handle multiple consecutive tool calls and their results', async () => {
      const testAgent = agent({
        name: 'multi_tool_agent',
        model: gemini('gemini-2.0-flash'),
        context: [
          injectSystemMessage('You can use multiple tools'),
          includeHistory(),
        ],
        tools: [echoTool, calculatorTool],
      });

      const { session, status } = await runTest(testAgent, [
        user('Echo "hello" and calculate 1+1'),
        model({
          toolCalls: [
            { name: 'echo', args: { message: 'hello' } },
            { name: 'calculate', args: { expression: '1+1' } },
          ],
        }),
        model({ text: 'I echoed hello and calculated 2' }),
      ]);

      expect(status).toBe('completed');

      const capturedContext = buildContext(session, testAgent, 'test');
      const serialized = serializeContext(capturedContext);

      console.log('\n=== Multi-tool context ===');
      serialized.contents.forEach((c: Content, i: number) => {
        console.log(`[${i}] Role: ${c.role}, Parts: ${c.parts?.length ?? 0}`);
        c.parts?.forEach((p, j) => {
          if (p.functionCall)
            console.log(`  [${j}] functionCall: ${p.functionCall.name}`);
          if (p.functionResponse)
            console.log(
              `  [${j}] functionResponse: ${p.functionResponse.name}`,
            );
        });
      });

      const toolCallContent = serialized.contents.find((c: Content) =>
        c.parts?.some((p) => p.functionCall),
      );
      expect(toolCallContent).toBeDefined();

      const toolCallCount =
        toolCallContent?.parts?.filter((p) => p.functionCall).length ?? 0;
      expect(toolCallCount).toBe(2);

      const toolResultContent = serialized.contents.find((c: Content) =>
        c.parts?.some((p) => p.functionResponse),
      );
      expect(toolResultContent).toBeDefined();

      const toolResultCount =
        toolResultContent?.parts?.filter((p) => p.functionResponse).length ?? 0;
      expect(toolResultCount).toBe(2);
    });
  });
});
