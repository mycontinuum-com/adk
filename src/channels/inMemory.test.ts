import { InMemoryChannel } from './inMemory';
import type { StreamEvent, AssistantDeltaEvent } from '../types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createDeltaEvent(
  delta: string,
  invocationId = 'test',
): AssistantDeltaEvent {
  return {
    id: `evt-${Date.now()}-${Math.random()}`,
    type: 'assistant_delta',
    createdAt: Date.now(),
    delta,
    text: delta,
    invocationId,
    agentName: 'test-agent',
  };
}

async function drainChannel(channel: InMemoryChannel) {
  const events: StreamEvent[] = [];
  const gen = channel.events();
  let iterResult = await gen.next();
  while (!iterResult.done) {
    events.push(iterResult.value);
    iterResult = await gen.next();
  }
  return { events, result: iterResult.value };
}

describe('InMemoryChannel', () => {
  let channel: InMemoryChannel;

  beforeEach(() => {
    channel = new InMemoryChannel();
  });

  afterEach(async () => {
    await channel.cleanup();
  });

  describe('single producer', () => {
    it('yields events and returns result', async () => {
      const expectedResult = { status: 'completed' as const, iterations: 1 };

      async function* producer() {
        yield createDeltaEvent('A');
        yield createDeltaEvent('B');
        return expectedResult;
      }

      channel.registerGenerator('main', producer(), true);
      const { events, result } = await drainChannel(channel);

      expect(events).toHaveLength(2);
      expect((events[0] as AssistantDeltaEvent).delta).toBe('A');
      expect((events[1] as AssistantDeltaEvent).delta).toBe('B');
      expect(result.mainResult).toEqual(expectedResult);
      expect(result.aborted).toBe(false);
    });

    it('captures yielded status with awaitingInput', async () => {
      const yieldedResult = {
        status: 'yielded' as const,
        iterations: 1,
        pendingCalls: [],
        awaitingInput: true,
      };

      async function* producer() {
        yield createDeltaEvent('before-yield');
        return yieldedResult;
      }

      channel.registerGenerator('main', producer(), true);
      const { result } = await drainChannel(channel);

      expect(result.mainResult?.status).toBe('yielded');
      expect(result.mainResult?.awaitingInput).toBe(true);
    });

    it('propagates producer errors via thrownError', async () => {
      async function* producer(): AsyncGenerator<StreamEvent, unknown> {
        yield createDeltaEvent('A');
        throw new Error('Producer failed');
      }

      channel.registerGenerator('main', producer(), true);
      const { events, result } = await drainChannel(channel);

      expect(events).toHaveLength(1);
      expect(result.thrownError?.message).toBe('Producer failed');
    });
  });

  describe('multiple producers', () => {
    it('interleaves events from concurrent generators', async () => {
      async function* producerA() {
        yield createDeltaEvent('A1');
        await delay(20);
        yield createDeltaEvent('A2');
        return { status: 'completed' as const, iterations: 1 };
      }

      async function* producerB() {
        await delay(10);
        yield createDeltaEvent('B1');
        return { status: 'completed' as const, iterations: 1 };
      }

      channel.registerGenerator('main', producerA(), true);
      channel.registerGenerator('spawn', producerB(), false);

      const { events } = await drainChannel(channel);
      const deltas = events.map((e) => (e as AssistantDeltaEvent).delta);

      expect(deltas).toEqual(expect.arrayContaining(['A1', 'A2', 'B1']));
      expect(deltas).toHaveLength(3);
    });

    it('returns only main producer result', async () => {
      const mainResult = {
        status: 'completed' as const,
        iterations: 3,
        output: 'main',
      };
      const spawnResult = {
        status: 'completed' as const,
        iterations: 1,
        output: 'spawn',
      };

      async function* main() {
        await delay(20);
        return mainResult;
      }

      async function* spawn() {
        return spawnResult;
      }

      channel.registerGenerator('main', main(), true);
      channel.registerGenerator('spawn', spawn(), false);

      const { result } = await drainChannel(channel);

      expect(result.mainResult).toEqual(mainResult);
    });

    it('continues when non-main producer fails', async () => {
      async function* main() {
        await delay(50);
        yield createDeltaEvent('main');
        return { status: 'completed' as const, iterations: 1 };
      }

      async function* failing(): AsyncGenerator<StreamEvent, unknown> {
        throw new Error('spawn failed');
      }

      channel.registerGenerator('main', main(), true);
      channel.registerGenerator('spawn', failing(), false);

      const { events, result } = await drainChannel(channel);

      expect(events).toHaveLength(1);
      expect(result.mainResult?.status).toBe('completed');
      expect(result.thrownError).toBeUndefined();
    });
  });

  describe('abort', () => {
    it('stops producers and returns aborted result', async () => {
      async function* slowProducer() {
        yield createDeltaEvent('start');
        await delay(500);
        yield createDeltaEvent('never-reached');
        return { status: 'completed' as const, iterations: 1 };
      }

      channel.registerGenerator('main', slowProducer(), true);
      setTimeout(() => channel.abort('test-abort'), 20);

      const { events, result } = await drainChannel(channel);

      expect(events).toHaveLength(1);
      expect(result.aborted).toBe(true);
      expect(result.abortReason).toBe('test-abort');
    });
  });

  describe('direct push API', () => {
    it('mixes pushed events with generator events', async () => {
      let pushReady: () => void;
      const pushReadyPromise = new Promise<void>((r) => (pushReady = r));

      async function* producer() {
        yield createDeltaEvent('gen-1');
        pushReady!();
        await delay(50);
        yield createDeltaEvent('gen-2');
        return { status: 'completed' as const, iterations: 1 };
      }

      channel.registerGenerator('main', producer(), true);

      const eventsPromise = drainChannel(channel);
      await pushReadyPromise;
      channel.push(createDeltaEvent('direct'));

      const { events } = await eventsPromise;
      const deltas = events.map((e) => (e as AssistantDeltaEvent).delta);

      expect(deltas).toContain('gen-1');
      expect(deltas).toContain('gen-2');
      expect(deltas).toContain('direct');
    });
  });

  describe('registerGenerator promise', () => {
    it('resolves with result on success', async () => {
      const expected = { status: 'completed' as const, iterations: 5 };

      async function* producer() {
        return expected;
      }

      const promise = channel.registerGenerator('main', producer(), true);
      drainChannel(channel);

      const { result, error } = await promise;

      expect(error).toBeUndefined();
      expect(result).toEqual(expected);
    });

    it('resolves with error on failure', async () => {
      async function* producer(): AsyncGenerator<StreamEvent, unknown> {
        throw new Error('test-error');
      }

      const promise = channel.registerGenerator('main', producer(), true);
      drainChannel(channel);

      const { error } = await promise;

      expect(error?.message).toBe('test-error');
    });

    it('returns error if channel already closed', async () => {
      channel.abort();

      async function* producer() {
        return { status: 'completed' as const, iterations: 1 };
      }

      const { error } = await channel.registerGenerator(
        'main',
        producer(),
        true,
      );

      expect(error?.message).toBe('Channel closed');
    });
  });
});
