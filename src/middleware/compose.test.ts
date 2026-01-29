import { z } from 'zod';
import { BaseRunner, tool } from '../core';
import { InMemorySessionService } from '../session';
import { agent } from '../agents';
import { openai } from '../providers';
import { includeHistory } from '../context';
import { composeMiddleware } from './compose';
import type { Hooks } from '../types';
import type { Middleware } from './types';
import { MockAdapter, createTestSession, testAgent } from '../testing';

describe('Middleware', () => {
  describe('composeMiddleware', () => {
    it('returns empty callbacks when no middleware and no agent callbacks', () => {
      const result = composeMiddleware([], [], undefined);
      expect(result.beforeAgent).toBeUndefined();
      expect(result.afterAgent).toBeUndefined();
      expect(result.beforeModel).toBeUndefined();
      expect(result.afterModel).toBeUndefined();
      expect(result.beforeTool).toBeUndefined();
      expect(result.afterTool).toBeUndefined();
    });

    it('preserves agent callbacks when no middleware', () => {
      const beforeAgent = jest.fn();
      const afterAgent = jest.fn();
      const agentCallbacks: Hooks = { beforeAgent, afterAgent };

      const result = composeMiddleware([], [], agentCallbacks);

      expect(result.beforeAgent).toBeDefined();
      expect(result.afterAgent).toBeDefined();
    });

    it('composes beforeAgent hooks in order (runner → agent middleware → callbacks)', async () => {
      const order: string[] = [];

      const runnerMw: Middleware = {
        beforeAgent: () => {
          order.push('runner');
        },
      };
      const agentMw: Middleware = {
        beforeAgent: () => {
          order.push('agent-mw');
        },
      };
      const hooks: Hooks = {
        beforeAgent: () => {
          order.push('callback');
        },
      };

      const composed = composeMiddleware([runnerMw], [agentMw], hooks);
      await composed.beforeAgent!({} as any);

      expect(order).toEqual(['runner', 'agent-mw', 'callback']);
    });

    it('composes afterAgent hooks in reverse order (callbacks → agent middleware → runner)', async () => {
      const order: string[] = [];

      const runnerMw: Middleware = {
        afterAgent: () => {
          order.push('runner');
        },
      };
      const agentMw: Middleware = {
        afterAgent: () => {
          order.push('agent-mw');
        },
      };
      const hooks: Hooks = {
        afterAgent: () => {
          order.push('callback');
        },
      };

      const composed = composeMiddleware([runnerMw], [agentMw], hooks);
      await composed.afterAgent!({} as any, 'output');

      expect(order).toEqual(['callback', 'agent-mw', 'runner']);
    });

    it('short-circuits beforeAgent when middleware returns a value', async () => {
      const order: string[] = [];

      const mw1: Middleware = {
        beforeAgent: () => {
          order.push('mw1');
          return 'short-circuit';
        },
      };
      const mw2: Middleware = {
        beforeAgent: () => {
          order.push('mw2');
        },
      };
      const hooks: Hooks = {
        beforeAgent: () => {
          order.push('callback');
        },
      };

      const composed = composeMiddleware([mw1, mw2], [], hooks);
      const result = await composed.beforeAgent!({} as any);

      expect(result).toBe('short-circuit');
      expect(order).toEqual(['mw1']);
    });

    it('allows afterAgent middleware to transform output', async () => {
      const mw1: Middleware = {
        afterAgent: (_, output) => `${output}-mw1`,
      };
      const mw2: Middleware = {
        afterAgent: (_, output) => `${output}-mw2`,
      };

      const composed = composeMiddleware([mw1, mw2], [], undefined);
      const result = await composed.afterAgent!({} as any, 'original');

      expect(result).toBe('original-mw2-mw1');
    });

    it('allows afterModel middleware to transform result', async () => {
      const mw: Middleware = {
        afterModel: (_, result) => ({
          ...result,
          terminal: true,
        }),
      };

      const composed = composeMiddleware([mw], [], undefined);
      const input = { stepEvents: [], toolCalls: [], terminal: false };
      const result = await composed.afterModel!({} as any, input);

      expect(result && 'terminal' in result && result.terminal).toBe(true);
    });
  });

  describe('Agent-level middleware', () => {
    it('calls middleware hooks during execution', async () => {
      const hooks: string[] = [];

      const middleware: Middleware = {
        beforeAgent: () => {
          hooks.push('beforeAgent');
        },
        afterAgent: () => {
          hooks.push('afterAgent');
        },
        beforeModel: () => {
          hooks.push('beforeModel');
        },
        afterModel: () => {
          hooks.push('afterModel');
        },
      };

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Hello!' }],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        middleware: [middleware],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
      });

      const session = createTestSession('Hi');
      await runner.run(myAgent, session);

      expect(hooks).toContain('beforeAgent');
      expect(hooks).toContain('beforeModel');
      expect(hooks).toContain('afterModel');
      expect(hooks).toContain('afterAgent');
    });

    it('calls tool middleware hooks during tool execution', async () => {
      const hooks: string[] = [];

      const middleware: Middleware = {
        beforeTool: (ctx, call) => {
          hooks.push(`beforeTool:${call.name}`);
        },
        afterTool: (ctx, result) => {
          hooks.push(`afterTool:${result.name}`);
        },
      };

      const myTool = tool({
        name: 'greet',
        description: 'Greet someone',
        schema: z.object({ name: z.string() }),
        execute: (ctx) => `Hello, ${ctx.args.name}!`,
      });

      const mockAdapter = new MockAdapter({
        responses: [
          { toolCalls: [{ name: 'greet', args: { name: 'World' } }] },
          { text: 'Done!' },
        ],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [myTool],
        middleware: [middleware],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
      });

      const session = createTestSession('Greet me');
      await runner.run(myAgent, session);

      expect(hooks).toContain('beforeTool:greet');
      expect(hooks).toContain('afterTool:greet');
    });
  });

  describe('Runner-level middleware', () => {
    it('applies runner middleware to all agents', async () => {
      const hooks: string[] = [];

      const runnerMiddleware: Middleware = {
        beforeAgent: (ctx) => {
          hooks.push(`runner:beforeAgent:${ctx.runnable.name}`);
        },
        afterAgent: (ctx) => {
          hooks.push(`runner:afterAgent:${ctx.runnable.name}`);
        },
      };

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Response' }],
      });

      const myAgent = testAgent({ name: 'my-agent' });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
        middleware: [runnerMiddleware],
      });

      const session = createTestSession('Test');
      await runner.run(myAgent, session);

      expect(hooks).toContain('runner:beforeAgent:my-agent');
      expect(hooks).toContain('runner:afterAgent:my-agent');
    });
  });

  describe('Combined runner and agent middleware', () => {
    it('composes in correct order (runner wraps agent)', async () => {
      const order: string[] = [];

      const runnerMw: Middleware = {
        beforeAgent: () => {
          order.push('runner:before');
        },
        afterAgent: () => {
          order.push('runner:after');
        },
      };

      const agentMw: Middleware = {
        beforeAgent: () => {
          order.push('agent:before');
        },
        afterAgent: () => {
          order.push('agent:after');
        },
      };

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Test' }],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        middleware: [agentMw],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
        middleware: [runnerMw],
      });

      const session = createTestSession('Hi');
      await runner.run(myAgent, session);

      expect(order).toEqual([
        'runner:before',
        'agent:before',
        'agent:after',
        'runner:after',
      ]);
    });

    it('runner middleware can short-circuit agent execution', async () => {
      const order: string[] = [];

      const runnerMw: Middleware = {
        beforeAgent: () => {
          order.push('runner:before');
          return 'Blocked by runner middleware';
        },
      };

      const agentMw: Middleware = {
        beforeAgent: () => {
          order.push('agent:before');
        },
      };

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Should not see this' }],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        middleware: [agentMw],
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
        middleware: [runnerMw],
      });

      const session = createTestSession('Hi');
      const result = await runner.run(myAgent, session);

      expect(result.status).toBe('completed');
      expect(order).toEqual(['runner:before']);
      expect(mockAdapter.stepCalls.length).toBe(0);
    });
  });

  describe('Middleware with static callbacks', () => {
    it('integrates middleware with agent callbacks', async () => {
      const order: string[] = [];

      const middleware: Middleware = {
        beforeAgent: () => {
          order.push('middleware:before');
        },
        afterAgent: () => {
          order.push('middleware:after');
        },
      };

      const hooks: Hooks = {
        beforeAgent: () => {
          order.push('callback:before');
        },
        afterAgent: () => {
          order.push('callback:after');
        },
      };

      const mockAdapter = new MockAdapter({
        responses: [{ text: 'Test' }],
      });

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        middleware: [middleware],
        hooks,
      });

      const runner = new BaseRunner({
        sessionService: new InMemorySessionService(),
        adapters: new Map([['openai', mockAdapter]]),
      });

      const session = createTestSession('Hi');
      await runner.run(myAgent, session);

      expect(order).toEqual([
        'middleware:before',
        'callback:before',
        'callback:after',
        'middleware:after',
      ]);
    });
  });
});
