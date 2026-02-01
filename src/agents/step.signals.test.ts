import {
  runTest,
  user,
  model,
  mockAgent,
  testAgent,
  setupAdkMatchers,
} from '../testing';
import { step, sequence } from './index';

setupAdkMatchers();

describe('step routing and signals', () => {
  describe('basic routing', () => {
    test('routes to returned runnable', async () => {
      const targetAgent = testAgent({ name: 'target' });

      const gate = step({
        name: 'gate',
        execute: () => targetAgent,
      });

      const { events, status } = await runTest(gate, [
        user('Hello'),
        model({ text: 'Target response' }),
      ]);

      expect(events).toHaveAssistantText('Target response');
      expect(status).toBe('completed');
    });

    test('routes based on session state', async () => {
      const agentA = testAgent({ name: 'agent_a' });
      const agentB = testAgent({ name: 'agent_b' });

      const gate = step({
        name: 'gate',
        execute: (ctx) => {
          const route = ctx.state.route as string | undefined;
          return route === 'a' ? agentA : agentB;
        },
      });

      const { events } = await runTest(
        gate,
        [user('Hello'), model({ text: 'Agent A response' })],
        { initialState: { session: { route: 'a' } } },
      );

      expect(events).toHaveEvent({
        type: 'invocation_start',
        agentName: 'agent_a',
      });
    });

    test('supports async execute function', async () => {
      const targetAgent = testAgent({ name: 'target' });

      const gate = step({
        name: 'gate',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return targetAgent;
        },
      });

      const { status } = await runTest(gate, [
        user('Hello'),
        model({ text: 'Response' }),
      ]);

      expect(status).toBe('completed');
    });
  });

  describe('signal: skip', () => {
    test('ctx.skip() completes silently', async () => {
      const gate = step({
        name: 'skip_gate',
        execute: (ctx) => ctx.skip(),
      });

      const { result, events } = await runTest(gate, [user('Hello')]);

      expect(result.status).toBe('completed');
      const assistantEvents = [...events].filter((e) => e.type === 'assistant');
      expect(assistantEvents).toHaveLength(0);
    });

    test('void return completes silently', async () => {
      const gate = step({
        name: 'void_gate',
        execute: () => {},
      });

      const { status } = await runTest(gate, [user('Hello')]);

      expect(status).toBe('completed');
    });

    test('conditional skip in sequence', async () => {
      const beforeAgent = mockAgent('before', {
        responses: [{ text: 'Before' }],
      });
      const afterAgent = mockAgent('after', { responses: [{ text: 'After' }] });

      const conditionalStep = step({
        name: 'maybe_run',
        execute: (ctx) => {
          const shouldSkip = ctx.state.skip as boolean | undefined;
          return shouldSkip
            ? ctx.skip()
            : mockAgent('middle', { responses: [{ text: 'Middle' }] });
        },
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [beforeAgent, conditionalStep, afterAgent],
      });

      const { events } = await runTest(pipeline, [user('Go')], {
        initialState: { session: { skip: true } },
      });

      expect(events).toHaveAssistantText('After');
    });
  });

  describe('signal: respond', () => {
    test('ctx.respond() emits assistant event', async () => {
      const gate = step({
        name: 'respond_gate',
        execute: (ctx) => ctx.respond('Access denied'),
      });

      const { events, status } = await runTest(gate, [user('Hello')]);

      expect(events).toHaveAssistantText('Access denied');
      expect(status).toBe('completed');
    });

    test('respond with dynamic message', async () => {
      const gate = step({
        name: 'gate',
        execute: (ctx) => {
          const name = ctx.state.userName as string | undefined;
          return ctx.respond(`Hello, ${name ?? 'guest'}!`);
        },
      });

      const { events } = await runTest(gate, [user('Hi')], {
        initialState: { session: { userName: 'Alice' } },
      });

      expect(events).toHaveAssistantText('Hello, Alice!');
    });
  });

  describe('signal: fail', () => {
    test('ctx.fail() returns error status', async () => {
      const gate = step({
        name: 'fail_gate',
        execute: (ctx) => ctx.fail('Validation failed'),
      });

      const { result } = await runTest(gate, [user('Hello')]);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error).toBe('Validation failed');
      }
    });

    test('auth gate pattern', async () => {
      const protectedAgent = testAgent({ name: 'protected' });

      const authGate = step({
        name: 'auth_gate',
        execute: (ctx) => {
          const role = ctx.state.user.role as string | undefined;
          if (!role) return ctx.fail('Not authenticated');
          if (role !== 'admin') return ctx.respond('Admin access required');
          return protectedAgent;
        },
      });

      const { status } = await runTest(authGate, [user('Access')]);
      expect(status).toBe('error');
    });
  });

  describe('signal: complete', () => {
    test('ctx.complete() sets output value', async () => {
      const gate = step({
        name: 'complete_gate',
        execute: (ctx) => ctx.complete({ cached: true, value: 42 }, 'result'),
      });

      const { session, status } = await runTest(gate, [user('Hello')]);

      expect(session).toHaveState('session', 'result', {
        cached: true,
        value: 42,
      });
      expect(status).toBe('completed');
    });

    test('cache gate pattern', async () => {
      const computeAgent = testAgent({ name: 'compute' });

      const cacheGate = step({
        name: 'cache_gate',
        execute: (ctx) => {
          const cached = ctx.state.cachedResult as object | undefined;
          if (cached) return ctx.complete(cached, 'result');
          return computeAgent;
        },
      });

      const { session, status } = await runTest(cacheGate, [user('Compute')], {
        initialState: { session: { cachedResult: { answer: 42 } } },
      });

      expect(session).toHaveState('session', 'result', { answer: 42 });
      expect(status).toBe('completed');
    });
  });

  describe('invocation events', () => {
    test('emits correct invocation events', async () => {
      const targetAgent = mockAgent('target', {
        responses: [{ text: 'Done' }],
      });

      const gate = step({
        name: 'gate',
        execute: () => targetAgent,
      });

      const { events } = await runTest(gate, [user('Go')]);

      const starts = [...events].filter((e) => e.type === 'invocation_start');
      const ends = [...events].filter((e) => e.type === 'invocation_end');

      expect(starts).toHaveLength(2);
      expect(ends).toHaveLength(2);

      const stepStart = starts.find(
        (e) => e.type === 'invocation_start' && e.agentName === 'gate',
      );
      expect(stepStart).toBeDefined();
      if (stepStart?.type === 'invocation_start') {
        expect(stepStart.kind).toBe('step');
      }
    });
  });

  describe('composition', () => {
    test('step nested in sequence', async () => {
      const agentA = testAgent({ name: 'agent_a' });
      const afterStep = testAgent({ name: 'after' });

      const gate = step({
        name: 'gate',
        execute: () => agentA,
      });

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [gate, afterStep],
      });

      const { events } = await runTest(pipeline, [
        user('Go'),
        model({ text: 'Agent A done' }),
        model({ text: 'After done' }),
      ]);

      expect(events).toHaveAssistantText('After done');
    });

    test('step returns sequence', async () => {
      const step1 = testAgent({ name: 'step1' });
      const step2 = testAgent({ name: 'step2' });

      const innerSequence = sequence({
        name: 'inner_sequence',
        runnables: [step1, step2],
      });

      const dynamicStep = step({
        name: 'dynamic',
        execute: () => innerSequence,
      });

      const { events } = await runTest(dynamicStep, [
        user('Go'),
        model({ text: 'Step 1 done' }),
        model({ text: 'Step 2 done' }),
      ]);

      expect(events).toHaveAssistantText('Step 2 done');
    });
  });

  describe('real-world patterns', () => {
    test('validation gate', async () => {
      const processAgent = testAgent({ name: 'process' });

      const validationGate = step({
        name: 'validation',
        execute: (ctx) => {
          const input = ctx.state.input as { email?: string } | undefined;
          if (!input?.email) {
            return ctx.respond('Please provide an email address.');
          }
          if (!input.email.includes('@')) {
            return ctx.respond('Invalid email format.');
          }
          return processAgent;
        },
      });

      const { events } = await runTest(validationGate, [user('Submit')], {
        initialState: { session: { input: { email: 'invalid' } } },
      });

      expect(events).toHaveAssistantText('Invalid email format.');
    });

    test('feature flag routing', async () => {
      const newFeature = testAgent({ name: 'new_feature' });
      const oldFeature = testAgent({ name: 'old_feature' });

      const featureStep = step({
        name: 'feature_router',
        execute: (ctx) => {
          const flags = (ctx.state.featureFlags as string[] | undefined) ?? [];
          return flags.includes('new_ui') ? newFeature : oldFeature;
        },
      });

      const { events } = await runTest(
        featureStep,
        [user('Go'), model({ text: 'New feature!' })],
        { initialState: { session: { featureFlags: ['new_ui', 'beta'] } } },
      );

      expect(events).toHaveAssistantText('New feature!');

      const startEvents = [...events].filter(
        (e) => e.type === 'invocation_start',
      );
      const newFeatureStart = startEvents.find(
        (e) => e.type === 'invocation_start' && e.agentName === 'new_feature',
      );
      expect(newFeatureStart).toBeDefined();
    });
  });
});
