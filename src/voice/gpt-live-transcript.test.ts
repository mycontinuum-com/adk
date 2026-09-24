import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

import type { Event } from '../types/events'
import type { StoredSession } from '../types/session'

import { InMemoryStore } from '../session/memory'
import { openGPTLiveTranscript } from './gpt-live-transcript'

class LiveSource extends EventEmitter {
  sessionId: string | null = null
  server(event: unknown) {
    this.emit('openai_server_event_received', event)
  }
  client(event: unknown) {
    this.emit('openai_client_event_queued', event)
  }
  start(id: string) {
    this.server({ type: 'session.started', session: { id } })
    this.sessionId = id
  }
}
const delta = (id: string, text: string, start: number, speaker = 'input') => ({
  type: `session.${speaker}_transcript.delta`,
  event_id: id,
  delta: text,
  start_ms: start,
  end_ms: start + 10,
})

async function fixture(store = new InMemoryStore()) {
  const capture = await openGPTLiveTranscript({ store, callId: 'synthetic-call' })
  const live = new LiveSource()
  capture.attach(live)
  live.start('connection-one')
  return { capture, live, store }
}

describe('GPT Live transcript capture', () => {
  test('preserves exact deltas, late arrival, overlapping speakers, and a frozen receipt boundary', async () => {
    const { capture, live } = await fixture()
    live.server(delta('three', ' Friday.', 300))
    live.server(delta('one', 'I can do', 100))
    live.server(delta('question', 'Which day?', 50, 'output'))
    const earlier = capture.snapshot()
    live.server(delta('two', ' next', 200))
    expect(
      capture.snapshot().fragments.map((fragment) => [fragment.speaker, fragment.text]),
    ).toEqual([
      ['agent', 'Which day?'],
      ['caller', 'I can do'],
      ['caller', ' next'],
      ['caller', ' Friday.'],
    ])
    expect(earlier.receivedThrough).toBe(5)
    expect(capture.receivedThrough).toBe(6)
    expect(earlier.fragments.map((fragment) => fragment.text)).toEqual([
      'Which day?',
      'I can do',
      ' Friday.',
    ])
    expect(Object.isFrozen(earlier.observations[0]?.connection)).toBe(true)
    await capture.close()
  })

  test('retains duplicate observations and makes identity conflicts explicit', async () => {
    const { capture, live } = await fixture()
    live.server(delta('one', 'Yes.', 100))
    live.server(delta('one', 'Yes.', 100))
    live.server(delta('one', 'No.', 100))
    live.server(delta('two', 'Yes.', 200))
    const snapshot = capture.snapshot()
    expect(snapshot.observations.filter((row) => row.payload.kind === 'transcript')).toHaveLength(4)
    expect(snapshot.fragments.map((fragment) => fragment.text)).toEqual(['Yes.', 'Yes.'])
    expect(snapshot.duplicates).toBe(1)
    expect(snapshot.status).toBe('ambiguous')
    expect(snapshot.conflicts).toEqual([
      { connectionId: 'connection-one', eventId: 'one', sequences: [3, 5] },
    ])
    await capture.close()
  })

  test('separates event identities and native offsets across reconnects', async () => {
    const { capture, live } = await fixture()
    live.server(delta('one', 'Before.', 100))
    live.server({ type: 'session.closed', reason: 'expired' })
    live.start('connection-two')
    live.server(delta('one', 'After.', 0))
    const snapshot = capture.snapshot()
    expect(snapshot.fragments.map((fragment) => [fragment.connection.id, fragment.text])).toEqual([
      ['connection-one', 'Before.'],
      ['connection-two', 'After.'],
    ])
    expect(snapshot.duplicates).toBe(0)
    expect(snapshot.conflicts).toEqual([])
    await capture.close()
  })

  test('preserves fragments without event IDs or timestamps without inventing deduplication', async () => {
    const { capture, live } = await fixture()
    const event = { type: 'session.input_transcript.delta', delta: 'Again.' }
    live.server(event)
    live.server(event)
    expect(capture.snapshot().fragments).toMatchObject([
      { text: 'Again.', eventId: null, startMs: null, endMs: null },
      { text: 'Again.', eventId: null, startMs: null, endMs: null },
    ])
    expect(capture.snapshot().diagnostics).toHaveLength(2)
    await capture.close()
  })

  test('captures whitelisted controls, delegation, and acknowledgment timing without audio or configuration', async () => {
    const { capture, live } = await fixture()
    live.server({
      type: 'session.delegation.created',
      event_id: 'd',
      offset_ms: 15,
      delegation: { id: 'lookup', target: 'client' },
      secret: 'omit',
    })
    live.client({
      type: 'session.thinking.append',
      event_id: 'c',
      delegation_id: 'lookup',
      content: 'Checking.',
    })
    live.server({
      type: 'session.thinking.appended',
      client_event_id: 'c',
      start_ms: 10,
      end_ms: 20,
    })
    live.client({ type: 'session.input_audio.append', audio: 'omit' })
    live.client({ type: 'session.start', session: { instructions: 'omit', apiKey: 'omit' } })
    live.server({ type: 'session.output_audio.delta', delta: 'omit' })
    const records = capture
      .snapshot()
      .observations.slice(2)
      .map((row) => row.payload)
    expect(records).toEqual([
      {
        kind: 'delegation',
        event: {
          type: 'session.delegation.created',
          event_id: 'd',
          offset_ms: 15,
          delegation: { id: 'lookup', target: 'client' },
        },
      },
      {
        kind: 'control',
        event: {
          type: 'session.thinking.append',
          event_id: 'c',
          delegation_id: 'lookup',
          content: 'Checking.',
        },
      },
      {
        kind: 'acknowledgement',
        event: {
          type: 'session.thinking.appended',
          client_event_id: 'c',
          start_ms: 10,
          end_ms: 20,
        },
      },
    ])
    await capture.close()
  })

  test('isolates malformed native events and throwing error callbacks from provider listeners', async () => {
    const capture = await openGPTLiveTranscript({
      store: new InMemoryStore(),
      callId: 'bad-event',
      onError() {
        throw new Error('handler failed')
      },
    })
    const live = new LiveSource()
    capture.attach(live)
    live.start('known')
    const laterListener = vi.fn<(event: unknown) => void>()
    live.on('openai_server_event_received', laterListener)
    expect(() => live.server({ type: 'session.input_transcript.delta', delta: 42 })).not.toThrow()
    live.server(delta('valid', 'Still listening.', 1))
    expect(laterListener).toHaveBeenCalledTimes(2)
    expect(capture.snapshot().fragments[0]?.text).toBe('Still listening.')
    expect(capture.snapshot().diagnostics).toContain(
      'Invalid session.input_transcript.delta observation at receipt 3.',
    )
    await capture.close()
  })

  test('records late attachment, and stale detach handles cannot disconnect a new source', async () => {
    const capture = await openGPTLiveTranscript({ store: new InMemoryStore(), callId: 'late' })
    const first = new LiveSource()
    first.sessionId = 'already-started'
    const detach = capture.attach(first)
    expect(capture.snapshot().diagnostics).toHaveLength(1)
    expect(() => capture.attach(first)).toThrow('already has an attached source')
    detach()
    const next = new LiveSource()
    capture.attach(next)
    next.start('next')
    detach()
    first.server(delta('unobserved', 'Gone.', 1))
    next.server(delta('observed', 'Here.', 1))
    await capture.close()
    next.server(delta('after-close', 'Gone.', 2))
    expect(capture.snapshot().fragments.map((fragment) => fragment.text)).toEqual(['Here.'])
    expect(next.listenerCount('openai_server_event_received')).toBe(0)
  })

  test('reopening reproduces snapshots and continues receipt and connection order', async () => {
    const { capture, live, store } = await fixture()
    live.server(delta('one', 'Saved.', 1))
    await capture.close()
    const saved = capture.snapshot()
    const reopened = await openGPTLiveTranscript({ store, callId: 'synthetic-call' })
    expect(reopened.snapshot()).toEqual(saved)
    expect(reopened.receivedThrough).toBe(saved.receivedThrough)
    const newLive = new LiveSource()
    reopened.attach(newLive)
    newLive.start('connection-two')
    newLive.server(delta('one', 'New.', 0))
    expect(reopened.snapshot().receivedThrough).toBe(saved.receivedThrough + 3)
    expect(reopened.snapshot().fragments.map((fragment) => fragment.text)).toEqual([
      'Saved.',
      'New.',
    ])
    await reopened.close()
  })

  test('checkpoint failure is visible, close can retry, and the caller retains store ownership', async () => {
    const { capture, live, store } = await fixture()
    const originalCommit = store.commit.bind(store)
    const commit = vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('disk failed'))
    const storeClose = vi.spyOn(store, 'close')
    live.server(delta('one', 'Buffered.', 1))
    await expect(capture.close()).rejects.toThrow('disk failed')
    expect(capture.snapshot().diagnostics).toContain(
      'Transcript checkpoint failed; buffered observations are not confirmed durable.',
    )
    commit.mockImplementation(originalCommit)
    await capture.close()
    expect(capture.snapshot().diagnostics).toEqual([])
    expect(storeClose).not.toHaveBeenCalled()
    const reopened = await openGPTLiveTranscript({ store, callId: 'synthetic-call' })
    expect(reopened.snapshot().fragments[0]?.text).toBe('Buffered.')
    await reopened.close()
  })

  test('periodic checkpoint reports errors and retries buffered data on the next interval', async () => {
    vi.useFakeTimers()
    try {
      const store = new InMemoryStore()
      const onError = vi.fn<(error: Error) => void>()
      const capture = await openGPTLiveTranscript({
        store,
        callId: 'timer',
        checkpointMs: 10,
        onError,
      })
      const live = new LiveSource()
      capture.attach(live)
      live.start('connection')
      live.server(delta('one', 'Saved on retry.', 1))
      vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('disk failed'))
      await vi.advanceTimersByTimeAsync(10)
      expect(onError).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10)
      expect(capture.snapshot().diagnostics).toEqual([])
      await capture.close()
      const reopened = await openGPTLiveTranscript({ store, callId: 'timer' })
      expect(reopened.snapshot().fragments[0]?.text).toBe('Saved on retry.')
      await reopened.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('records arriving during a checkpoint persist at the next checkpoint', async () => {
    const { capture, live, store } = await fixture()
    const originalCommit = store.commit.bind(store)
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => {}
    const committing = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(store, 'commit').mockImplementationOnce(
      async (session: StoredSession, events: Event[], version: number) => {
        entered()
        await blocked
        return originalCommit(session, events, version)
      },
    )
    live.server(delta('one', 'First.', 1))
    const pending = capture.checkpoint()
    await committing
    live.server(delta('two', ' Second.', 2))
    const later = capture.checkpoint()
    release()
    await Promise.all([pending, later])
    const reopened = await openGPTLiveTranscript({ store, callId: 'synthetic-call' })
    expect(reopened.snapshot().fragments.map((fragment) => fragment.text)).toEqual([
      'First.',
      ' Second.',
    ])
    await capture.close()
  })

  test.each(Array.from({ length: 25 }, (_, depth) => depth))(
    'a checkpoint or close %i microtasks after store completion persists later arrivals',
    async (depth) => {
      for (const close of [false, true]) {
        const { capture, live, store } = await fixture()
        const originalCommit = store.commit.bind(store)
        let scheduleFinish: () => void = () => {}
        const later = new Promise<void>((resolve, reject) => {
          scheduleFinish = () => {
            live.server(delta('two', ' Second.', 2))
            const result = close ? capture.close() : capture.checkpoint()
            result.then(resolve, reject)
          }
        })
        vi.spyOn(store, 'commit').mockImplementationOnce(async (...args) => {
          const result = await originalCommit(...args)
          let remaining = depth
          const next = () => {
            if (remaining-- > 0) queueMicrotask(next)
            else scheduleFinish()
          }
          queueMicrotask(next)
          return result
        })
        live.server(delta('one', 'First.', 1))
        await capture.checkpoint()
        await later
        const reopened = await openGPTLiveTranscript({ store, callId: 'synthetic-call' })
        expect(reopened.snapshot().fragments.map((fragment) => fragment.text)).toEqual([
          'First.',
          ' Second.',
        ])
        expect(reopened.snapshot().receivedThrough).toBe(capture.snapshot().receivedThrough)
        await capture.close()
      }
    },
  )

  test('store-free observation preserves native integrity without checkpoint timers', async () => {
    vi.useFakeTimers()
    try {
      const capture = await openGPTLiveTranscript({ callId: 'store-free' })
      const live = new LiveSource()
      capture.attach(live)
      live.start('connection-one')
      expect(capture.status).toBe('usable')
      live.server(delta('one', 'Yes.', 1))
      live.server(delta('one', 'Yes.', 1))
      expect(capture.status).toBe(capture.snapshot().status)
      expect(capture.snapshot().duplicates).toBe(1)
      live.start('connection-two')
      live.server(delta('one', 'No.', 1))
      expect(capture.status).toBe('usable')
      live.server(delta('one', 'Maybe.', 1))
      expect(capture.status).toBe('ambiguous')
      expect(capture.status).toBe(capture.snapshot().status)
      const beforeCheckpoint = capture.snapshot()
      await capture.checkpoint()
      expect(capture.snapshot()).toEqual(beforeCheckpoint)
      expect(vi.getTimerCount()).toBe(0)
      await capture.close()
      expect(live.listenerCount('openai_server_event_received')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('store-free checkpoints are rejected at the option boundary', async () => {
    await expect(
      openGPTLiveTranscript({
        callId: 'invalid-options',
        // @ts-expect-error A checkpoint interval requires a store.
        checkpointMs: 100,
        onError() {},
      }),
    ).rejects.toThrow('Transcript checkpoints require a store')
  })

  test('reopening restores native integrity before another source attaches', async () => {
    const { capture, live, store } = await fixture()
    live.server(delta('one', 'Yes.', 1))
    live.server(delta('one', 'No.', 1))
    expect(capture.status).toBe('ambiguous')
    await capture.close()
    const reopened = await openGPTLiveTranscript({ store, callId: 'synthetic-call' })
    expect(reopened.status).toBe('ambiguous')
    expect(reopened.status).toBe(reopened.snapshot().status)
    await reopened.close()
  })

  test('load errors do not silently create an empty transcript', async () => {
    const store = new InMemoryStore()
    vi.spyOn(store, 'load').mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(openGPTLiveTranscript({ store, callId: 'missing' })).rejects.toThrow(
      'storage unavailable',
    )
  })
})
