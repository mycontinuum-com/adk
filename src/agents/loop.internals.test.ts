import { loop } from './index';
import { BaseRunner } from '../core';
import { MockAdapter, createTestSession, testAgent } from '../testing';
import type { LoopContext } from '../types';

describe('Loop - While Context', () => {
  let mockAdapter: MockAdapter;
  let runner: BaseRunner;

  beforeEach(() => {
    mockAdapter = new MockAdapter();
    runner = new BaseRunner({
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    });
  });

  test('while receives context with iteration and lastResult', async () => {
    const results: Array<LoopContext['lastResult']> = [];
    mockAdapter.setResponses([{ text: 'First' }, { text: 'Second' }]);

    const looped = loop({
      name: 'loop',
      runnable: testAgent(),
      maxIterations: 3,
      while: (ctx) => {
        results.push(ctx.lastResult);
        return ctx.iteration < 2;
      },
    });

    await runner.run(looped, createTestSession('Test'));
    expect(results[0]).toBeNull();
    expect(results[1]?.iterations).toBe(1);
  });

  test('async while condition', async () => {
    mockAdapter.setResponses([{ text: '1' }, { text: '2' }]);

    const looped = loop({
      name: 'loop',
      runnable: testAgent(),
      maxIterations: 5,
      while: async (ctx) => {
        await new Promise((r) => setTimeout(r, 5));
        return ctx.iteration < 2;
      },
    });

    expect(
      (await runner.run(looped, createTestSession('Test'))).iterations,
    ).toBe(2);
  });
});
