import { z } from 'zod';
import {
  runTest,
  user,
  mockAgent,
  testAgent,
  setupAdkMatchers,
  MockAdapter,
} from '../testing';
import { parallel } from './index';
import { tool } from '../core';
import { includeHistory } from '../context';
import { BaseRunner } from '../core';
import { BaseSession } from '../session';
import type { Event } from '../types';

setupAdkMatchers();

const branchAgent = (name: string) =>
  testAgent({ name, context: [includeHistory({ scope: 'invocation' })] });

describe('parallel composition', () => {
  describe('basic parallel execution', () => {
    test('tests parallel with multiple branches', async () => {
      const analyzer = mockAgent('analyzer', {
        responses: [{ text: 'Analyzed' }],
      });
      const summarizer = mockAgent('summarizer', {
        responses: [{ text: 'Summarized' }],
      });

      const fanout = parallel({
        name: 'fanout',
        runnables: [analyzer, summarizer],
      });

      const { status } = await runTest(fanout, [user('Process')]);

      expect(status).toBe('completed');
    });

    test('handles same agent type in multiple branches', async () => {
      const worker1 = mockAgent('worker1', {
        responses: [{ text: 'Worker 0' }],
      });
      const worker2 = mockAgent('worker2', {
        responses: [{ text: 'Worker 1' }],
      });
      const worker3 = mockAgent('worker3', {
        responses: [{ text: 'Worker 2' }],
      });

      const fanout = parallel({
        name: 'fanout',
        runnables: [worker1, worker2, worker3],
      });

      const { status } = await runTest(fanout, [user('Process')]);

      expect(status).toBe('completed');
    });
  });

  describe('minSuccessful', () => {
    test('returns error if not enough branches succeed', async () => {
      const b1 = mockAgent('b1', { responses: [{ error: new Error('F1') }] });
      const b2 = mockAgent('b2', { responses: [{ error: new Error('F2') }] });
      const b3 = mockAgent('b3', { responses: [{ text: 'Success' }] });

      const fanout = parallel({
        name: 'min_test',
        runnables: [b1, b2, b3],
        minSuccessful: 2,
      });

      const { result } = await runTest(fanout, [user('Test')]);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error).toContain('Only 1 branches succeeded');
        expect(result.error).toContain('need 2');
      }
    });

    test('succeeds when enough branches complete', async () => {
      const b1 = mockAgent('b1', { responses: [{ text: 'Success 1' }] });
      const b2 = mockAgent('b2', { responses: [{ text: 'Success 2' }] });
      const b3 = mockAgent('b3', {
        responses: [{ error: new Error('Failed') }],
      });

      const fanout = parallel({
        name: 'min_test',
        runnables: [b1, b2, b3],
        minSuccessful: 2,
      });

      const { status } = await runTest(fanout, [user('Test')]);

      expect(status).toBe('completed');
    });
  });

  describe('branch errors', () => {
    test('handles branch errors gracefully', async () => {
      const failAgent = mockAgent('fail', {
        responses: [{ error: new Error('Branch failed') }],
      });
      const passAgent = mockAgent('pass', { responses: [{ text: 'Success' }] });

      const fanout = parallel({
        name: 'resilient',
        runnables: [failAgent, passAgent],
      });

      const { iterations } = await runTest(fanout, [user('Test')]);

      expect(iterations).toBe(1);
    });

    test('emits error events for failed branches', async () => {
      const failAgent = mockAgent('failing', {
        responses: [{ error: new Error('Branch 1 failed') }],
      });
      const passAgent = mockAgent('passing', {
        responses: [{ text: 'Success' }],
      });

      const fanout = parallel({
        name: 'error_events',
        runnables: [failAgent, passAgent],
      });

      const { events } = await runTest(fanout, [user('Test')]);

      const endEvents = [...events].filter(
        (e) => e.type === 'invocation_end' && e.reason === 'error',
      );
      expect(endEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('empty branches', () => {
    test('handles empty branches array', async () => {
      const fanout = parallel({
        name: 'empty',
        runnables: [],
      });

      const { iterations } = await runTest(fanout, [user('Test')]);

      expect(iterations).toBe(0);
    });
  });

  describe('custom merge', () => {
    test('custom merge function can add events', async () => {
      const summaryEvent: Event = {
        id: 'x',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: 'test-inv',
        agentName: 'test_agent',
        text: 'Merged Summary',
      };

      const b = mockAgent('b', { responses: [{ text: 'Result' }] });

      const fanout = parallel({
        name: 'merge',
        runnables: [b],
        merge: () => [summaryEvent],
      });

      const { events } = await runTest(fanout, [user('Test')]);

      expect(
        [...events].some(
          (e) =>
            e.type === 'assistant' &&
            (e as { text: string }).text === 'Merged Summary',
        ),
      ).toBe(true);
    });
  });

  describe('concurrent state modifications', () => {
    test('state changes from parallel branches are captured', async () => {
      const setTool = tool({
        name: 'set_state',
        description: 'Set state value',
        schema: z.object({ key: z.string(), value: z.string() }),
        execute: (ctx) => {
          ctx.state[ctx.args.key] = ctx.args.value;
          return { set: ctx.args.key };
        },
      });

      const branchWithTool = (name: string, key: string, value: string) =>
        testAgent({
          name,
          tools: [setTool],
          context: [includeHistory({ scope: 'invocation' })],
        });

      const adapter = new MockAdapter({
        responses: [
          {
            toolCalls: [
              { name: 'set_state', args: { key: 'b1', value: 'v1' } },
            ],
          },
          { text: 'Done 1' },
          {
            toolCalls: [
              { name: 'set_state', args: { key: 'b2', value: 'v2' } },
            ],
          },
          { text: 'Done 2' },
        ],
      });

      const runner = new BaseRunner({
        adapters: { openai: adapter, gemini: adapter },
      });

      const fanout = parallel({
        name: 'state_test',
        runnables: [
          branchWithTool('branch1', 'b1', 'v1'),
          branchWithTool('branch2', 'b2', 'v2'),
        ],
      });

      const session = new BaseSession('test-app', { id: `test-${Date.now()}` });
      session.addMessage('Set states');

      const result = await runner.run(fanout, session);

      const stateEvents = [...session.events].filter(
        (e) => e.type === 'state_change' && e.scope === 'session',
      );
      expect(stateEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('invocation tracking', () => {
    test('creates invocation events with parent-child relationship', async () => {
      const branchA = mockAgent('branch_a', { responses: [{ text: 'A' }] });
      const branchB = mockAgent('branch_b', { responses: [{ text: 'B' }] });

      const fanout = parallel({
        name: 'tracked',
        runnables: [branchA, branchB],
      });

      const { events } = await runTest(fanout, [user('Test')]);

      const starts = [...events].filter((e) => e.type === 'invocation_start');
      const parent = starts.find(
        (e) => e.type === 'invocation_start' && e.agentName === 'tracked',
      );
      const branches = starts.filter(
        (e) =>
          e.type === 'invocation_start' && e.agentName.startsWith('branch_'),
      );

      expect(branches).toHaveLength(2);
      if (parent?.type === 'invocation_start') {
        branches.forEach((b) => {
          if (b.type === 'invocation_start') {
            expect(b.parentInvocationId).toBe(parent.invocationId);
          }
        });
      }
    });
  });
});
