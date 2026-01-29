import { z } from 'zod';
import { BaseRunner, tool } from './index';
import { BaseSession, InMemorySessionService } from '../session';
import {
  MockAdapter,
  createTestSession,
  testAgent,
  getLastAssistantText,
} from '../testing';
import type { StreamEvent } from '../types';
import type { ErrorHandler } from '../errors';

describe('BaseRunner', () => {
  let mockAdapter: MockAdapter;

  beforeEach(() => {
    mockAdapter = new MockAdapter();
  });

  describe('constructor', () => {
    test('accepts session service, adapters as Map or Record', () => {
      expect(new BaseRunner()).toBeInstanceOf(BaseRunner);
      expect(
        new BaseRunner({ sessionService: new InMemorySessionService() }),
      ).toBeInstanceOf(BaseRunner);
      expect(
        new BaseRunner({ adapters: new Map([['openai', mockAdapter]]) }),
      ).toBeInstanceOf(BaseRunner);
      expect(
        new BaseRunner({
          adapters: { openai: mockAdapter, gemini: mockAdapter },
        }),
      ).toBeInstanceOf(BaseRunner);
    });
  });

  describe('run()', () => {
    test('runs agent and returns result', async () => {
      mockAdapter.setResponses([{ text: 'Hello!' }]);
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });
      const session = createTestSession('Hi');

      const result = await runner.run(testAgent(), session);

      expect(result.session).toBe(session);
      expect(result.iterations).toBe(1);
      expect(getLastAssistantText(result.session.events)).toBe('Hello!');
    });

    test('streams events via onStream callback', async () => {
      mockAdapter.setResponses([{ text: 'Response', streamChunks: true }]);
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });
      const events: StreamEvent[] = [];

      await runner.run(testAgent(), createTestSession('Test'), {
        onStream: (e) => events.push(e),
      });

      expect(events.some((e) => e.type === 'assistant_delta')).toBe(true);
    });

    test('calls onStep after each model step', async () => {
      mockAdapter.setResponses([
        { toolCalls: [{ name: 't', args: {} }] },
        { text: 'Done' },
      ]);
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });
      const myTool = tool({
        name: 't',
        description: 'T',
        schema: z.object({}),
        execute: (ctx) => ({}),
      });
      const steps: number[] = [];

      await runner.run(
        testAgent({ tools: [myTool] }),
        createTestSession('Test'),
        { onStep: (e) => steps.push(e.length) },
      );

      expect(steps.length).toBeGreaterThanOrEqual(2);
    });

    test('supports timeout', async () => {
      mockAdapter.setResponses([{ text: 'Slow', delayMs: 500 }]);
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });

      await expect(
        runner.run(testAgent(), createTestSession('Test'), { timeout: 100 }),
      ).rejects.toThrow('Timeout');
    });

    test('supports abort', async () => {
      mockAdapter.setResponses([{ text: 'Response', delayMs: 500 }]);
      const runner = new BaseRunner({
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });
      const stream = runner.run(testAgent(), createTestSession('Test'));

      setTimeout(() => stream.abort(), 50);
      await expect(stream).rejects.toThrow('Aborted');
    });
  });

  describe('static run()', () => {
    test('creates session from message string', async () => {
      mockAdapter.setResponses([{ text: 'Hello!' }]);

      const result = await BaseRunner.run(testAgent(), 'Hi there', {
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });

      expect(result.iterations).toBe(1);
      expect(
        result.session.events.filter((e) => e.type === 'user')[0],
      ).toMatchObject({ type: 'user', text: 'Hi there' });
    });

    test('supports both iteration and await', async () => {
      mockAdapter.setResponses([{ text: 'Response', streamChunks: true }]);

      const events: StreamEvent[] = [];
      for await (const e of BaseRunner.run(testAgent(), 'Test', {
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      })) {
        events.push(e);
      }
      expect(events.some((e) => e.type === 'assistant_delta')).toBe(true);

      mockAdapter.reset();
      mockAdapter.setResponses([{ text: 'Response' }]);
      const result = await BaseRunner.run(testAgent(), 'Test', {
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });
      expect(result.iterations).toBe(1);
    });

    test('throws if stream consumed twice', async () => {
      mockAdapter.setResponses([{ text: 'Response' }]);
      const stream = BaseRunner.run(testAgent(), 'Test', {
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });

      for await (const _ of stream) {
      }
      expect(() => stream[Symbol.asyncIterator]()).toThrow(
        'Stream already consumed',
      );
    });

    test('accepts custom session ID', async () => {
      mockAdapter.setResponses([{ text: 'Response' }]);
      const result = await BaseRunner.run(testAgent(), 'Test', {
        sessionId: 'custom-id',
        adapters: { openai: mockAdapter, gemini: mockAdapter },
      });
      expect(result.session.id).toBe('custom-id');
    });
  });

  describe('provider selection', () => {
    test('routes to correct adapter by provider', async () => {
      const openaiAdapter = new MockAdapter({
        defaultResponse: { text: 'OpenAI' },
      });
      const geminiAdapter = new MockAdapter({
        defaultResponse: { text: 'Gemini' },
      });
      const runner = new BaseRunner({
        adapters: { openai: openaiAdapter, gemini: geminiAdapter },
      });

      const result = await runner.run(testAgent(), createTestSession('Test'));

      expect(openaiAdapter.stepCalls).toHaveLength(1);
      expect(geminiAdapter.stepCalls).toHaveLength(0);
      expect(getLastAssistantText(result.session.events)).toBe('OpenAI');
    });

    test('throws for unsupported provider', async () => {
      const runner = new BaseRunner({
        adapters: new Map([['openai', mockAdapter]]),
      });
      const myAgent = testAgent({
        model: { provider: 'gemini', name: 'gemini-pro' },
      });

      await expect(
        runner.run(myAgent, createTestSession('Test')),
      ).rejects.toThrow('Unsupported provider: gemini');
    });
  });
});

describe('Integration', () => {
  let mockAdapter: MockAdapter;
  let sessionService: InMemorySessionService;
  let runner: BaseRunner;

  beforeEach(() => {
    mockAdapter = new MockAdapter();
    sessionService = new InMemorySessionService();
    runner = new BaseRunner({
      sessionService,
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    });
  });

  test('multi-turn conversation with state tracking', async () => {
    const incTool = tool({
      name: 'inc',
      description: 'Inc',
      schema: z.object({}),
      execute: (ctx) => {
        const c = (ctx.state.get<number>('c') ?? 0) + 1;
        ctx.state.set('c', c);
        return { c };
      },
    });

    const session = (await sessionService.createSession('app', {
      userId: 'user1',
      sessionId: 's1',
    })) as BaseSession;

    mockAdapter.setResponses([
      { toolCalls: [{ name: 'inc', args: {} }] },
      { text: '1' },
    ]);
    session.addMessage('Inc');
    await runner.run(testAgent({ tools: [incTool] }), session);
    expect(session.state.session.get('c')).toBe(1);

    mockAdapter.reset();
    mockAdapter.setResponses([
      { toolCalls: [{ name: 'inc', args: {} }] },
      { text: '2' },
    ]);
    session.addMessage('Inc');
    await runner.run(testAgent({ tools: [incTool] }), session);
    expect(session.state.session.get('c')).toBe(2);
  });

  test('user state persists across sessions', async () => {
    const setTool = tool({
      name: 'set',
      description: 'Set',
      schema: z.object({ k: z.string(), v: z.string() }),
      execute: (ctx) => {
        ctx.state.user.set(ctx.args.k, ctx.args.v);
        return {};
      },
    });

    mockAdapter.setResponses([
      { toolCalls: [{ name: 'set', args: { k: 'theme', v: 'dark' } }] },
      { text: 'Set' },
    ]);
    const s1 = (await sessionService.createSession('app', {
      userId: 'user1',
    })) as BaseSession;
    s1.addMessage('Set');
    await runner.run(testAgent({ tools: [setTool] }), s1);

    const s2 = (await sessionService.createSession('app', {
      userId: 'user1',
    })) as BaseSession;
    expect(s2.state.user.get('theme')).toBe('dark');
  });

  test('error recovery with errorHandlers', async () => {
    mockAdapter.setResponses([
      { error: new Error('Fail') },
      { text: 'Recovered' },
    ]);
    const errors: Error[] = [];

    const errorHandler: ErrorHandler = {
      handle: (ctx) => {
        errors.push(ctx.error);
        return { action: 'skip' };
      },
    };

    const runnerWithHandler = new BaseRunner({
      adapters: new Map([['openai', mockAdapter]]),
      errorHandlers: [errorHandler],
    });

    const result = await runnerWithHandler.run(
      testAgent(),
      createTestSession('Test'),
    );

    expect(errors[0].message).toBe('Fail');
    expect(getLastAssistantText(result.session.events)).toBe('Recovered');
  });

  test('context includes tool events after execution', async () => {
    mockAdapter.setResponses([
      { toolCalls: [{ name: 't', args: {} }] },
      { text: 'Done' },
    ]);
    const myTool = tool({
      name: 't',
      description: 'T',
      schema: z.object({}),
      execute: (ctx) => ({ data: 1 }),
    });

    await runner.run(testAgent({ tools: [myTool] }), createTestSession('Test'));

    const ctx = mockAdapter.stepCalls[1].ctx;
    expect(ctx.events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(ctx.events.some((e) => e.type === 'tool_result')).toBe(true);
  });
});
