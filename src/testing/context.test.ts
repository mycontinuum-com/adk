import {
  createTestContext,
  testAgent,
  createTestSession,
  findEventsByType,
  getLastAssistantText,
  getToolCalls,
  getToolResults,
} from './context';
import { user, model, setupAdkMatchers } from './index';
import { z } from 'zod';
import { tool } from '../core';
import type { Event } from '../types';

setupAdkMatchers();

const TEST_INV_ID = 'test-invocation-id';

describe('test context helpers', () => {
  describe('createTestContext', () => {
    test('creates context with agent', () => {
      const agent = testAgent();
      const ctx = createTestContext(agent);

      expect(ctx.agent).toBe(agent);
      expect(ctx.adapter).toBeDefined();
      expect(ctx.runner).toBeDefined();
    });

    test('respond() queues responses', () => {
      const ctx = createTestContext(testAgent());

      ctx.respond({ text: 'First' });
      ctx.respond({ text: 'Second' });

      expect(ctx.adapter.stepCalls).toHaveLength(0);
    });

    test('run() executes scenario with queued responses', async () => {
      const ctx = createTestContext(testAgent());

      ctx.respond({ text: 'Hello!' });

      const result = await ctx.run([user('Hi')]);

      expect(result.status).toBe('completed');
      expect(result.events).toHaveAssistantText('Hello!');
    });

    test('runMessage() is shorthand for simple scenarios', async () => {
      const ctx = createTestContext(testAgent());

      ctx.respond({ text: 'Response' });

      const result = await ctx.runMessage('Hello');

      expect(getLastAssistantText([...result.events])).toBe('Response');
    });

    test('reset() clears state', async () => {
      const ctx = createTestContext(testAgent());

      ctx.respond({ text: 'First' });
      ctx.reset();

      ctx.respond({ text: 'Second' });

      const result = await ctx.runMessage('Test');

      expect(getLastAssistantText([...result.events])).toBe('Second');
    });
  });

  describe('testAgent', () => {
    test('creates agent with defaults', () => {
      const agent = testAgent();

      expect(agent.kind).toBe('agent');
      expect(agent.name).toBe('test');
      expect(agent.tools).toEqual([]);
    });

    test('accepts overrides', () => {
      const myTool = tool({
        name: 'my_tool',
        description: 'Test',
        schema: z.object({}),
        execute: () => ({}),
      });

      const agent = testAgent({
        name: 'custom',
        tools: [myTool],
        maxSteps: 5,
      });

      expect(agent.name).toBe('custom');
      expect(agent.tools).toHaveLength(1);
      expect(agent.maxSteps).toBe(5);
    });
  });

  describe('createTestSession', () => {
    test('creates session with message', () => {
      const session = createTestSession('Hello');

      expect(session.events).toHaveLength(1);
      expect(session.events[0]).toMatchObject({
        type: 'user',
        text: 'Hello',
      });
    });

    test('creates session without message', () => {
      const session = createTestSession();

      expect(session.events).toHaveLength(0);
    });

    test('accepts custom options', () => {
      const session = createTestSession('Hi', {
        id: 'custom-id',
        userId: 'user-123',
        patientId: 'patient-456',
      });

      expect(session.id).toBe('custom-id');
      expect(session.userId).toBe('user-123');
      expect(session.patientId).toBe('patient-456');
    });
  });

  describe('event query helpers', () => {
    test('findEventsByType returns matching events', () => {
      const session = createTestSession('Test');
      session.pushEvent({
        id: '1',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        text: 'Response',
      } as Event);

      const userEvents = findEventsByType(session.events, 'user');
      const assistantEvents = findEventsByType(session.events, 'assistant');

      expect(userEvents).toHaveLength(1);
      expect(assistantEvents).toHaveLength(1);
    });

    test('getLastAssistantText returns last response', () => {
      const session = createTestSession();
      session.pushEvent({
        id: '1',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        text: 'First',
      } as Event);
      session.pushEvent({
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        text: 'Last',
      } as Event);

      expect(getLastAssistantText(session.events)).toBe('Last');
    });

    test('getToolCalls returns all tool calls', () => {
      const session = createTestSession();
      session.pushEvent({
        id: '1',
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test_agent',
        callId: 'call_1',
        name: 'tool_a',
        args: { x: 1 },
      } as Event);
      session.pushEvent({
        id: '2',
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test_agent',
        callId: 'call_2',
        name: 'tool_b',
        args: { y: 2 },
      } as Event);

      const calls = getToolCalls(session.events);

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({ name: 'tool_a', args: { x: 1 } });
      expect(calls[1]).toEqual({ name: 'tool_b', args: { y: 2 } });
    });

    test('getToolResults returns all results', () => {
      const session = createTestSession();
      session.pushEvent({
        id: '1',
        type: 'tool_result',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        callId: 'call_1',
        name: 'tool_a',
        result: { value: 42 },
      } as Event);

      const results = getToolResults(session.events);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        name: 'tool_a',
        result: { value: 42 },
        error: undefined,
      });
    });
  });
});
