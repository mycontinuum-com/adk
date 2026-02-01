import { z } from 'zod';
import { parallel } from './index';
import { tool, BaseRunner } from '../core';
import { includeHistory } from '../context';
import { MockAdapter, createTestSession, testAgent } from '../testing';

describe('Parallel - Cloned Session Isolation', () => {
  test('branches operate on cloned sessions with isolated state', async () => {
    const stateValues: Record<string, unknown>[] = [];

    const setTool = tool({
      name: 'set_value',
      description: 'Set a value',
      schema: z.object({ key: z.string(), value: z.number() }),
      execute: (ctx) => {
        ctx.state[ctx.args.key] = ctx.args.value;
        stateValues.push({ ...ctx.state });
        return { set: true };
      },
    });

    const branchWithTool = (name: string, key: string, value: number) => {
      const adapter = new MockAdapter({
        responses: [
          { toolCalls: [{ name: 'set_value', args: { key, value } }] },
          { text: `Set ${key}=${value}` },
        ],
      });
      return {
        agent: testAgent({
          name,
          tools: [setTool],
          context: [includeHistory({ scope: 'invocation' })],
        }),
        adapter,
      };
    };

    const branch1 = branchWithTool('branch1', 'key1', 100);

    const adaptersMap = new Map<'openai' | 'gemini', MockAdapter>([
      ['openai', branch1.adapter],
    ]);

    const customRunner = new BaseRunner({ adapters: adaptersMap });

    const fanout = parallel({
      name: 'state_test',
      runnables: [branch1.agent],
    });

    const session = createTestSession('Test');
    session.state.initial = 'value';

    await customRunner.run(fanout, session);

    expect(stateValues.length).toBeGreaterThan(0);
    expect(stateValues[0]).toHaveProperty('key1', 100);
  });
});
