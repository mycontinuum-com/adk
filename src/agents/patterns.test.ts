import { runTest, user, setupAdkMatchers, MockAdapter } from '../testing';
import { step, sequence } from './factory';
import { gated, cached } from './patterns';
import { BaseSession } from '../session';
import { BaseRunner } from '../core';

setupAdkMatchers();

const createRunner = () => {
  const adapter = new MockAdapter({ responses: [] });
  return new BaseRunner({ adapters: { openai: adapter, gemini: adapter } });
};

describe('gated', () => {
  test('runs wrapped runnable when check returns undefined', async () => {
    let executed = false;
    const inner = step({
      name: 'inner',
      execute: () => {
        executed = true;
      },
    });
    const pipeline = sequence({
      name: 'p',
      runnables: [gated(inner, () => undefined)],
    });

    await runTest(pipeline, [user('Go')]);

    expect(executed).toBe(true);
  });

  test('skips wrapped runnable when check returns a result', async () => {
    let executed = false;
    const inner = step({
      name: 'inner',
      execute: () => {
        executed = true;
      },
    });
    const pipeline = sequence({
      name: 'p',
      runnables: [gated(inner, (ctx) => ctx.complete('blocked', 'result'))],
    });

    await runTest(pipeline, [user('Go')]);

    expect(executed).toBe(false);
  });

  test('preserves name and description from wrapped runnable', () => {
    const inner = step({
      name: 'my_step',
      description: 'Does things',
      execute: () => {},
    });
    const result = gated(inner, () => undefined);

    expect(result.name).toBe('my_step');
    expect(result.description).toBe('Does things');
  });
});

describe('cached', () => {
  test('executes when cache key is not set', async () => {
    let executed = false;
    const inner = step({
      name: 'inner',
      execute: () => {
        executed = true;
      },
    });
    const pipeline = sequence({
      name: 'p',
      runnables: [cached(inner, { key: 'result' })],
    });

    await runTest(pipeline, [user('Go')]);

    expect(executed).toBe(true);
  });

  test('skips execution when cache key exists in session state', async () => {
    let executed = false;
    const inner = step({
      name: 'inner',
      execute: () => {
        executed = true;
      },
    });
    const pipeline = sequence({
      name: 'p',
      runnables: [cached(inner, { key: 'data', scope: 'session' })],
    });

    await runTest(pipeline, [user('Go')], {
      initialState: { session: { data: 'cached' } },
    });

    expect(executed).toBe(false);
  });

  test('respects TTL - executes when expired, skips when valid', async () => {
    let executed = false;
    const inner = step({
      name: 'inner',
      execute: () => {
        executed = true;
      },
    });
    const pipeline = sequence({
      name: 'p',
      runnables: [cached(inner, { key: 'result', ttlMs: 1000 })],
    });

    const expiredSession = new BaseSession('test-app', { id: 'expired' });
    expiredSession.addMessage('Go');
    expiredSession.state.result = 'old_value';
    const stateEvent = expiredSession.events.find(
      (e) => e.type === 'state_change',
    );
    if (stateEvent)
      (stateEvent as { createdAt: number }).createdAt = Date.now() - 2000;

    await createRunner().run(pipeline, expiredSession);
    expect(executed).toBe(true);

    executed = false;
    const validSession = new BaseSession('test-app', { id: 'valid' });
    validSession.addMessage('Go');
    validSession.state.result = 'recent_value';

    await createRunner().run(pipeline, validSession);
    expect(executed).toBe(false);
  });
});
