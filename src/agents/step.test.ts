import {
  runTest,
  user,
  model,
  mockAgent,
  testAgent,
  setupAdkMatchers,
} from '../testing';
import { step, sequence, parallel } from './index';

setupAdkMatchers();

describe('step composition', () => {
  describe('basic execution', () => {
    test('executes code and completes', async () => {
      let executed = false;

      const myStep = step({
        name: 'my_step',
        execute: () => {
          executed = true;
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [myStep],
      });

      const { status } = await runTest(pipeline, [user('Go')]);

      expect(executed).toBe(true);
      expect(status).toBe('completed');
    });

    test('executes async code', async () => {
      let result = 0;

      const asyncStep = step({
        name: 'async_step',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          result = 42;
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [asyncStep],
      });

      await runTest(pipeline, [user('Go')]);

      expect(result).toBe(42);
    });

    test('has access to session state', async () => {
      const stateStep = step({
        name: 'state_step',
        execute: (ctx) => {
          const input = ctx.state.get<string>('input');
          ctx.state.set('output', `processed: ${input}`);
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [stateStep],
      });

      const { session } = await runTest(pipeline, [user('Go')], {
        initialState: { session: { input: 'hello' } },
      });

      expect(session).toHaveState('session', 'output', 'processed: hello');
    });
  });

  describe('error handling', () => {
    test('captures thrown errors', async () => {
      const errorStep = step({
        name: 'error_step',
        execute: () => {
          throw new Error('Something went wrong');
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [errorStep],
      });

      const { result } = await runTest(pipeline, [user('Go')]);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error).toBe('Something went wrong');
      }
    });

    test('captures async errors', async () => {
      const asyncErrorStep = step({
        name: 'async_error_step',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('Async error');
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [asyncErrorStep],
      });

      const { status } = await runTest(pipeline, [user('Go')]);

      expect(status).toBe('error');
    });
  });

  describe('invocation events', () => {
    test('emits correct invocation events', async () => {
      const myStep = step({
        name: 'my_step',
        execute: () => {},
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [myStep],
      });

      const { events } = await runTest(pipeline, [user('Go')]);

      const starts = [...events].filter((e) => e.type === 'invocation_start');
      const ends = [...events].filter((e) => e.type === 'invocation_end');

      const stepStart = starts.find(
        (e) => e.type === 'invocation_start' && e.agentName === 'my_step',
      );
      expect(stepStart).toBeDefined();
      if (stepStart?.type === 'invocation_start') {
        expect(stepStart.kind).toBe('step');
      }

      const stepEnd = ends.find(
        (e) => e.type === 'invocation_end' && e.agentName === 'my_step',
      );
      expect(stepEnd).toBeDefined();
    });
  });

  describe('composition with agents', () => {
    test('step before agent', async () => {
      const setupStep = step({
        name: 'setup',
        execute: (ctx) => {
          ctx.state.set('configured', true);
        },
      });

      const myAgent = testAgent({ name: 'my_agent' });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [setupStep, myAgent],
      });

      const { session, events } = await runTest(pipeline, [
        user('Go'),
        model({ text: 'Agent response' }),
      ]);

      expect(events).toHaveAssistantText('Agent response');
      expect(session).toHaveState('session', 'configured', true);
    });

    test('step after agent', async () => {
      const myAgent = testAgent({ name: 'my_agent' });

      const cleanupStep = step({
        name: 'cleanup',
        execute: (ctx) => {
          ctx.state.set('cleaned', true);
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [myAgent, cleanupStep],
      });

      const { session } = await runTest(pipeline, [
        user('Go'),
        model({ text: 'Agent response' }),
      ]);

      expect(session).toHaveState('session', 'cleaned', true);
    });

    test('step between agents', async () => {
      const agent1 = mockAgent('agent1', { responses: [{ text: 'First' }] });
      const agent2 = mockAgent('agent2', { responses: [{ text: 'Second' }] });

      const transformStep = step({
        name: 'transform',
        execute: (ctx) => {
          ctx.state.set('transformed', true);
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [agent1, transformStep, agent2],
      });

      const { session, events } = await runTest(pipeline, [user('Go')]);

      expect(session).toHaveState('session', 'transformed', true);
      expect(events).toHaveAssistantText('Second');
    });
  });

  describe('orchestration', () => {
    test('can call agents with ctx.call', async () => {
      const innerAgent = testAgent({ name: 'inner_agent' });

      const orchestratingStep = step({
        name: 'orchestrating_step',
        execute: async (ctx) => {
          const result = await ctx.call(innerAgent, {
            message: 'Hello from step',
          });
          ctx.state.set('callResult', {
            status: result.status,
            hasResponse: result.output !== undefined,
          });
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [orchestratingStep],
      });

      const { session } = await runTest(pipeline, [
        user('Go'),
        model({ text: 'Inner response' }),
      ]);

      expect(session).toHaveState('session', 'callResult', {
        status: 'completed',
        hasResponse: true,
      });
    });

    test('can spawn agents with ctx.spawn', async () => {
      const innerAgent = mockAgent('spawned_agent', {
        responses: [{ text: 'Spawned response' }],
      });

      const spawnStep = step({
        name: 'spawn_step',
        execute: async (ctx) => {
          const handle = ctx.spawn(innerAgent);
          const result = await handle.wait();
          ctx.state.set('spawnResult', result.status);
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [spawnStep],
      });

      const { session } = await runTest(pipeline, [user('Go')]);

      expect(session).toHaveState('session', 'spawnResult', 'completed');
    });

    test('can dispatch agents with ctx.dispatch', async () => {
      const innerAgent = mockAgent('dispatched_agent', {
        responses: [{ text: 'Dispatched response' }],
      });

      const dispatchStep = step({
        name: 'dispatch_step',
        execute: (ctx) => {
          const handle = ctx.dispatch(innerAgent);
          ctx.state.set('dispatchId', handle.invocationId);
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [dispatchStep],
      });

      const { session } = await runTest(pipeline, [user('Go')]);

      const dispatchId = session.state.session.get('dispatchId');
      expect(dispatchId).toBeDefined();
    });
  });

  describe('real-world patterns', () => {
    test('data fetching step', async () => {
      const fetchStep = step({
        name: 'fetch_data',
        execute: async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          ctx.state.set('data', {
            items: ['a', 'b', 'c'],
            count: 3,
          });
        },
      });

      const processAgent = testAgent({ name: 'process' });

      const pipeline = sequence({
        name: 'data_pipeline',
        runnables: [fetchStep, processAgent],
      });

      const { session } = await runTest(pipeline, [
        user('Fetch and process'),
        model({ text: 'Processed' }),
      ]);

      expect(session).toHaveState('session', 'data', {
        items: ['a', 'b', 'c'],
        count: 3,
      });
    });

    test('logging/audit step', async () => {
      const logs: string[] = [];

      const logStep = step({
        name: 'audit_log',
        execute: (ctx) => {
          logs.push(`Session ${ctx.invocationId} completed`);
        },
      });

      const myAgent = testAgent({ name: 'my_agent' });

      const pipeline = sequence({
        name: 'audited_pipeline',
        runnables: [myAgent, logStep],
      });

      await runTest(pipeline, [user('Do something'), model({ text: 'Done' })]);

      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('completed');
    });

    test('state initialization step', async () => {
      const initStep = step({
        name: 'init',
        execute: (ctx) => {
          ctx.state.set('config', {
            maxRetries: 3,
            timeout: 5000,
            features: ['a', 'b'],
          });
        },
      });

      const myAgent = testAgent({ name: 'my_agent' });

      const pipeline = sequence({
        name: 'configured_pipeline',
        runnables: [initStep, myAgent],
      });

      const { session } = await runTest(pipeline, [
        user('Start'),
        model({ text: 'Running with config' }),
      ]);

      expect(session).toHaveState('session', 'config', {
        maxRetries: 3,
        timeout: 5000,
        features: ['a', 'b'],
      });
    });

    test('parallel steps', async () => {
      const results: string[] = [];

      const step1 = step({
        name: 'step1',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          results.push('step1');
        },
      });

      const step2 = step({
        name: 'step2',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push('step2');
        },
      });

      const parallelSteps = parallel({
        name: 'parallel_steps',
        runnables: [step1, step2],
      });

      await runTest(parallelSteps, [user('Go')]);

      expect(results).toContain('step1');
      expect(results).toContain('step2');
    });
  });
});
