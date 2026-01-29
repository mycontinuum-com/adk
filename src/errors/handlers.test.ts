import { z } from 'zod';
import { BaseRunner, tool } from '../core';
import { InMemorySessionService } from '../session';
import { agent } from '../agents';
import { openai } from '../providers';
import { includeHistory } from '../context';
import {
  composeErrorHandlers,
  retryHandler,
  rateLimitHandler,
  timeoutHandler,
  loggingHandler,
  defaultHandler,
} from './index';
import type { ErrorContext } from '../types';
import type { ErrorHandler, ErrorRecovery } from './types';
import { MockAdapter, createTestSession, testAgent } from '../testing';

describe('Error Handlers', () => {
  describe('composeErrorHandlers', () => {
    const createErrorContext = (
      overrides: Partial<ErrorContext> = {},
    ): ErrorContext => ({
      invocationId: 'inv_test',
      agent: { name: 'test' } as any,
      phase: 'tool',
      attempt: 1,
      error: new Error('Test error'),
      timestamp: Date.now(),
      ...overrides,
    });

    it('returns default recovery when no handlers', async () => {
      const composed = composeErrorHandlers([], []);
      const result = await composed.handle(
        createErrorContext({ phase: 'tool' }),
      );
      expect(result).toEqual({ action: 'skip' });
    });

    it('returns throw for model errors by default', async () => {
      const composed = composeErrorHandlers([], []);
      const result = await composed.handle(
        createErrorContext({ phase: 'model' }),
      );
      expect(result).toEqual({ action: 'throw' });
    });

    it('executes handlers in order (runner then agent)', async () => {
      const order: string[] = [];

      const runnerHandler: ErrorHandler = {
        handle: () => {
          order.push('runner');
          return { action: 'pass' };
        },
      };

      const agentHandler: ErrorHandler = {
        handle: () => {
          order.push('agent');
          return { action: 'skip' };
        },
      };

      const composed = composeErrorHandlers([runnerHandler], [agentHandler]);
      await composed.handle(createErrorContext());

      expect(order).toEqual(['runner', 'agent']);
    });

    it('stops at first non-pass result', async () => {
      const order: string[] = [];

      const handler1: ErrorHandler = {
        handle: () => {
          order.push('h1');
          return { action: 'retry', delay: 100 };
        },
      };

      const handler2: ErrorHandler = {
        handle: () => {
          order.push('h2');
          return { action: 'skip' };
        },
      };

      const composed = composeErrorHandlers([handler1, handler2], []);
      const result = await composed.handle(createErrorContext());

      expect(order).toEqual(['h1']);
      expect(result).toEqual({ action: 'retry', delay: 100 });
    });

    it('respects canHandle filter', async () => {
      const handler: ErrorHandler = {
        canHandle: (ctx) => ctx.error.message.includes('rate limit'),
        handle: () => ({ action: 'retry', delay: 1000 }),
      };

      const composed = composeErrorHandlers([handler], []);

      const normalResult = await composed.handle(createErrorContext());
      expect(normalResult).toEqual({ action: 'skip' });

      const rateLimitResult = await composed.handle(
        createErrorContext({ error: new Error('rate limit exceeded') }),
      );
      expect(rateLimitResult).toEqual({ action: 'retry', delay: 1000 });
    });
  });

  describe('Built-in handlers', () => {
    describe('retryHandler', () => {
      it('retries up to maxAttempts', async () => {
        const handler = retryHandler({ maxAttempts: 3, baseDelay: 100 });
        const ctx = {
          invocationId: 'inv_1',
          phase: 'tool' as const,
          toolName: 'test',
        } as ErrorContext;

        const r1 = await handler.handle!(ctx);
        expect(r1.action).toBe('retry');

        const r2 = await handler.handle!(ctx);
        expect(r2.action).toBe('retry');

        const r3 = await handler.handle!(ctx);
        expect(r3.action).toBe('pass');
      });

      it('applies exponential backoff', async () => {
        const handler = retryHandler({
          maxAttempts: 3,
          baseDelay: 100,
          backoffMultiplier: 2,
        });
        const ctx = {
          invocationId: 'inv_backoff',
          phase: 'tool' as const,
          toolName: 'test',
        } as ErrorContext;

        const r1 = await handler.handle!(ctx);
        expect(r1).toEqual({ action: 'retry', delay: 100 });

        const r2 = await handler.handle!(ctx);
        expect(r2).toEqual({ action: 'retry', delay: 200 });
      });
    });

    describe('rateLimitHandler', () => {
      it('only handles rate limit errors', async () => {
        const handler = rateLimitHandler();

        const normalCtx = {
          error: new Error('connection failed'),
        } as ErrorContext;
        expect(await handler.canHandle!(normalCtx)).toBe(false);

        const rateLimitCtx = {
          error: new Error('rate limit exceeded'),
        } as ErrorContext;
        expect(await handler.canHandle!(rateLimitCtx)).toBe(true);

        const http429Ctx = {
          error: new Error('429 too many requests'),
        } as ErrorContext;
        expect(await handler.canHandle!(http429Ctx)).toBe(true);
      });
    });

    describe('timeoutHandler', () => {
      it('only handles timeout errors', async () => {
        const handler = timeoutHandler();

        const normalCtx = {
          error: new Error('connection failed'),
        } as ErrorContext;
        expect(await handler.canHandle!(normalCtx)).toBe(false);

        const timeoutCtx = {
          error: new Error('operation timed out'),
        } as ErrorContext;
        expect(await handler.canHandle!(timeoutCtx)).toBe(true);
      });

      it('returns fallback when configured', async () => {
        const handler = timeoutHandler({ fallbackResult: { default: true } });
        const ctx = { error: new Error('timed out') } as ErrorContext;

        const result = await handler.handle!(ctx);
        expect(result).toEqual({
          action: 'fallback',
          result: { default: true },
        });
      });

      it('returns skip when no fallback', async () => {
        const handler = timeoutHandler();
        const ctx = { error: new Error('timed out') } as ErrorContext;

        const result = await handler.handle!(ctx);
        expect(result).toEqual({ action: 'skip' });
      });
    });

    describe('loggingHandler', () => {
      it('logs and passes', async () => {
        const logged: ErrorContext[] = [];
        const handler = loggingHandler({ onError: (ctx) => logged.push(ctx) });
        const ctx = { error: new Error('test') } as ErrorContext;

        const result = await handler.handle!(ctx);
        expect(result).toEqual({ action: 'pass' });
        expect(logged).toHaveLength(1);
      });
    });

    describe('defaultHandler', () => {
      it('skips tool errors', async () => {
        const handler = defaultHandler();
        const ctx = { phase: 'tool' as const } as ErrorContext;
        expect(await handler.handle!(ctx)).toEqual({ action: 'skip' });
      });

      it('throws model errors', async () => {
        const handler = defaultHandler();
        const ctx = { phase: 'model' as const } as ErrorContext;
        expect(await handler.handle!(ctx)).toEqual({ action: 'throw' });
      });
    });
  });

  describe('Integration', () => {
    it('agent errorHandlers are called during tool errors', async () => {
      const handlerCalls: string[] = [];

      const errorHandler: ErrorHandler = {
        handle: (ctx) => {
          handlerCalls.push(`tool:${ctx.toolName}`);
          return { action: 'skip' };
        },
      };

      const failingTool = tool({
        name: 'failing_tool',
        description: 'Always fails',
        schema: z.object({}),
        execute: () => {
          throw new Error('Tool failure');
        },
      });

      const mockAdapter = new MockAdapter({
        responses: [
          { toolCalls: [{ name: 'failing_tool', args: {} }] },
          { text: 'Done' },
        ],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [failingTool],
        errorHandlers: [errorHandler],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
      });

      const session = createTestSession('Test');
      await runner.run(myAgent, session);

      expect(handlerCalls).toContain('tool:failing_tool');
    });

    it('runner errorHandlers wrap agent errorHandlers', async () => {
      const order: string[] = [];

      const runnerHandler: ErrorHandler = {
        handle: () => {
          order.push('runner');
          return { action: 'pass' };
        },
      };

      const agentHandler: ErrorHandler = {
        handle: () => {
          order.push('agent');
          return { action: 'skip' };
        },
      };

      const failingTool = tool({
        name: 'fail',
        description: 'Fails',
        schema: z.object({}),
        execute: () => {
          throw new Error('fail');
        },
      });

      const mockAdapter = new MockAdapter({
        responses: [
          { toolCalls: [{ name: 'fail', args: {} }] },
          { text: 'Done' },
        ],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [failingTool],
        errorHandlers: [agentHandler],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
        errorHandlers: [runnerHandler],
      });

      const session = createTestSession('Test');
      await runner.run(myAgent, session);

      expect(order).toEqual(['runner', 'agent']);
    });

    it('retry handler causes tool re-execution', async () => {
      let attempts = 0;

      const flakyTool = tool({
        name: 'flaky',
        description: 'Fails first two times',
        schema: z.object({}),
        execute: () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('temporary failure');
          }
          return { success: true };
        },
      });

      const mockAdapter = new MockAdapter({
        responses: [
          { toolCalls: [{ name: 'flaky', args: {} }] },
          { text: 'Success!' },
        ],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [flakyTool],
        errorHandlers: [retryHandler({ maxAttempts: 5, baseDelay: 10 })],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
      });

      const session = createTestSession('Test');
      const result = await runner.run(myAgent, session);

      expect(result.status).toBe('completed');
      expect(attempts).toBe(3);
    });

    it('fallback handler provides fallback result', async () => {
      const failingTool = tool({
        name: 'fail',
        description: 'Always fails',
        schema: z.object({}),
        execute: () => {
          throw new Error('timed out');
        },
      });

      const mockAdapter = new MockAdapter({
        responses: [
          { toolCalls: [{ name: 'fail', args: {} }] },
          { text: 'Done' },
        ],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [failingTool],
        errorHandlers: [timeoutHandler({ fallbackResult: { fallback: true } })],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
      });

      const session = createTestSession('Test');
      const result = await runner.run(myAgent, session);

      expect(result.status).toBe('completed');

      const toolResult = session.events.find((e) => e.type === 'tool_result');
      expect(toolResult?.type === 'tool_result' && toolResult.result).toEqual({
        fallback: true,
      });
    });
  });
});
