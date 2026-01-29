import { runTest, user, model, testAgent, setupAdkMatchers } from '../testing';
import { loop } from './index';
import type { LoopContext } from '../types';

setupAdkMatchers();

describe('loop composition', () => {
  test('tests loop with maxIterations', async () => {
    const agent = testAgent({ name: 'worker' });

    const looped = loop({
      name: 'refiner',
      runnable: agent,
      maxIterations: 2,
      while: () => true,
    });

    const { iterations } = await runTest(looped, [
      user('Refine'),
      model({ text: 'Iteration 1' }),
      model({ text: 'Iteration 2' }),
    ]);

    expect(iterations).toBe(2);
  });

  test('tests loop termination condition', async () => {
    const agent = testAgent({ name: 'worker' });

    const looped = loop({
      name: 'finder',
      runnable: agent,
      maxIterations: 10,
      while: (ctx: LoopContext) => {
        const lastAssistant = [...ctx.session.events]
          .reverse()
          .find((e) => e.type === 'assistant');
        return !(
          lastAssistant?.type === 'assistant' &&
          lastAssistant.text.includes('FOUND')
        );
      },
    });

    const { iterations, events } = await runTest(looped, [
      user('Search'),
      model({ text: 'Searching...' }),
      model({ text: 'Still looking...' }),
      model({ text: 'FOUND it!' }),
    ]);

    expect(iterations).toBe(3);
    expect(events).toHaveAssistantText(/FOUND/);
  });
});
