import {
  testAgent,
  createTestSession,
  setupAdkMatchers,
  MockAdapter,
} from '../testing';
import { BaseRunner } from './index';
import type { StreamEvent } from '../types';

setupAdkMatchers();

describe('streaming and abort', () => {
  let mockAdapter: MockAdapter;
  let runner: BaseRunner;

  beforeEach(() => {
    mockAdapter = new MockAdapter();
    runner = new BaseRunner({
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    });
  });

  describe('delta streaming', () => {
    test('streams delta events when streamChunks is enabled', async () => {
      mockAdapter.setResponses([
        { text: 'Hello World!', streamChunks: true, chunkSize: 5 },
      ]);

      const events: StreamEvent[] = [];
      for await (const event of runner.run(
        testAgent(),
        createTestSession('Test'),
      )) {
        events.push(event);
      }

      const deltas = events.filter((e) => e.type === 'assistant_delta');
      expect(deltas.length).toBeGreaterThan(1);
    });

    test('partial stream consumption yields only consumed events', async () => {
      mockAdapter.setResponses([
        { text: 'Hello World!', streamChunks: true, chunkSize: 3 },
      ]);

      const stream = runner.run(testAgent(), createTestSession('Test'));
      const events: StreamEvent[] = [];

      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      events.push(first.value);
      const second = await iterator.next();
      events.push(second.value);
      const third = await iterator.next();
      events.push(third.value);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('invocation_start');
      expect(events[1].type).toBe('model_start');
    });

    test('consuming all events yields invocation and streaming events', async () => {
      mockAdapter.setResponses([
        { text: 'Complete', streamChunks: true, chunkSize: 4 },
      ]);

      const events: StreamEvent[] = [];
      for await (const event of runner.run(
        testAgent(),
        createTestSession('Test'),
      )) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'invocation_start')).toBe(true);
      expect(events.some((e) => e.type === 'assistant_delta')).toBe(true);
    });
  });

  describe('onStream callback', () => {
    test('streams events via onStream callback', async () => {
      mockAdapter.setResponses([{ text: 'Response', streamChunks: true }]);

      const events: StreamEvent[] = [];
      await runner.run(testAgent(), createTestSession('Test'), {
        onStream: (e) => events.push(e),
      });

      expect(events.some((e) => e.type === 'assistant_delta')).toBe(true);
    });
  });

  describe('abort handling', () => {
    test('respects abort signal', async () => {
      mockAdapter.setResponses([{ text: 'Response', delayMs: 200 }]);

      const stream = runner.run(testAgent(), createTestSession('Test'));

      setTimeout(() => stream.abort(), 20);
      await expect(stream).rejects.toThrow('Aborted');
    });

    test('abort during streaming stops event production', async () => {
      mockAdapter.setResponses([
        {
          text: 'A long response here',
          streamChunks: true,
          chunkSize: 2,
          delayMs: 50,
        },
      ]);

      const stream = runner.run(testAgent(), createTestSession('Test'));
      const events: StreamEvent[] = [];
      let aborted = false;

      setTimeout(() => stream.abort(), 25);

      try {
        for await (const event of stream) {
          events.push(event);
        }
      } catch (e) {
        aborted = true;
        expect((e as Error).message).toBe('Aborted');
      }

      expect(aborted).toBe(true);
      expect(events.length).toBeLessThan(15);
    });
  });

  describe('timeout', () => {
    test('timeout produces timeout error', async () => {
      mockAdapter.setResponses([{ text: 'Slow', delayMs: 500 }]);

      await expect(
        runner.run(testAgent(), createTestSession('Test'), { timeout: 100 }),
      ).rejects.toThrow('Timeout');
    });

    test('timeout during streaming produces timeout error', async () => {
      mockAdapter.setResponses([
        {
          text: 'Very long response',
          streamChunks: true,
          chunkSize: 2,
          delayMs: 200,
        },
      ]);

      await expect(
        runner.run(testAgent(), createTestSession('Test'), { timeout: 50 }),
      ).rejects.toThrow('Timeout');
    });
  });

  describe('stream consumption', () => {
    test('throws if stream consumed twice', async () => {
      mockAdapter.setResponses([{ text: 'Response' }]);

      const stream = runner.run(testAgent(), createTestSession('Test'));

      for await (const _ of stream) {
        // Consume all
      }

      expect(() => stream[Symbol.asyncIterator]()).toThrow(
        'Stream already consumed',
      );
    });
  });
});
