import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

import type { Event } from '../types/events'
import type { SessionStore, StoredSession } from '../types/session'
import type { GPTLiveTranscriptObservation } from './gpt-live-transcript'

import { InMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { createGPTLiveTranscript } from './gpt-live-transcript'

class LiveSource extends EventEmitter {
  sessionId: string | null = null
  server(event: unknown) {
    this.emit('openai_server_event_received', event)
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

async function fixture(store = new InMemoryStore(), callId = 'synthetic-call') {
  const onError = vi.fn<(error: Error) => void>()
  const capture = await createGPTLiveTranscript(store, callId, onError)
  const live = new LiveSource()
  capture.attach(live)
  live.start('connection-one')
  return { capture, live, store, onError }
}

/** The transcript text a reader of the stored session sees, in receipt order. */
async function persistedText(store: SessionStore, callId = 'synthetic-call') {
  const session = await sessionService(store).getSession('adk-gpt-live-transcript', callId)
  return session!.events.flatMap((event) => {
    const observation =
      event.type === 'annotation'
        ? (event.data?.observation as GPTLiveTranscriptObservation)
        : undefined
    return observation?.payload.kind === 'transcript' ? [observation.payload.event.delta] : []
  })
}

describe('GPT Live transcript capture', () => {
  test('preserves exact deltas in receipt order, overlapping speakers, and a frozen receipt boundary', async () => {
    const { capture, live } = await fixture()
    live.server(delta('three', ' Friday.', 300))
    live.server(delta('one', 'I can do', 100))
    live.server(delta('question', 'Which day?', 50, 'output'))
    const earlier = capture.snapshot()
    live.server(delta('two', ' next', 200))
    expect(
      capture.snapshot().fragments.map((fragment) => [fragment.speaker, fragment.text]),
    ).toEqual([
      ['caller', ' Friday.'],
      ['caller', 'I can do'],
      ['agent', 'Which day?'],
      ['caller', ' next'],
    ])
    expect(earlier.receivedThrough).toBe(3)
    expect(capture.receivedThrough).toBe(4)
    expect(earlier.fragments.map((fragment) => fragment.text)).toEqual([
      ' Friday.',
      'I can do',
      'Which day?',
    ])
    await capture.close()
  })

  test('separates native offsets across reconnects', async () => {
    const { capture, live } = await fixture()
    live.server(delta('one', 'Before.', 100))
    live.server({ type: 'session.closed', reason: 'expired' })
    live.start('connection-two')
    live.server(delta('one', 'After.', 0))
    const snapshot = capture.snapshot()
    expect(
      snapshot.fragments.map((fragment) => [
        fragment.connection.id,
        fragment.connection.index,
        fragment.text,
      ]),
    ).toEqual([
      ['connection-one', 2, 'Before.'],
      ['connection-two', 3, 'After.'],
    ])
    await capture.close()
  })

  test('preserves fragments without event IDs or timestamps', async () => {
    const { capture, live } = await fixture()
    const event = { type: 'session.input_transcript.delta', delta: 'Again.' }
    live.server(event)
    live.server(event)
    expect(capture.snapshot().fragments).toMatchObject([
      { text: 'Again.', startMs: null, endMs: null },
      { text: 'Again.', startMs: null, endMs: null },
    ])
    await capture.close()
  })

  test('captures delegations without audio, configuration or unknown fields', async () => {
    const { capture, live } = await fixture()
    live.server({
      type: 'session.delegation.created',
      event_id: 'd',
      offset_ms: 15,
      delegation: { id: 'lookup', target: 'client' },
      secret: 'omit',
    })
    live.server({ type: 'session.thinking.appended', client_event_id: 'c', start_ms: 10 })
    live.server({ type: 'session.output_audio.delta', delta: 'omit' })
    live.server({ type: 'session.closed', reason: 'expired' })
    expect(capture.snapshot().observations.map((row) => row.payload)).toEqual([
      {
        kind: 'delegation',
        event: {
          type: 'session.delegation.created',
          event_id: 'd',
          offset_ms: 15,
          delegation: { id: 'lookup' },
        },
      },
    ])
    await capture.close()
  })

  test('isolates malformed native events and throwing error callbacks from provider listeners', async () => {
    const onError = vi.fn<(error: Error) => void>(() => {
      throw new Error('handler failed')
    })
    const capture = await createGPTLiveTranscript(new InMemoryStore(), 'bad-event', onError)
    const live = new LiveSource()
    capture.attach(live)
    live.start('known')
    const laterListener = vi.fn<(event: unknown) => void>()
    live.on('openai_server_event_received', laterListener)
    expect(() => live.server({ type: 'session.input_transcript.delta', delta: 42 })).not.toThrow()
    live.server(delta('valid', 'Still listening.', 1))
    expect(laterListener).toHaveBeenCalledTimes(2)
    expect(capture.snapshot().fragments.map((fragment) => fragment.text)).toEqual([
      'Still listening.',
    ])
    expect(onError).toHaveBeenCalledWith(new Error('Invalid GPT Live transcript event'))
    await capture.close()
  })

  test('close stops capture and persists what was captured', async () => {
    const { capture, live, store } = await fixture()
    live.server(delta('one', 'Here.', 1))
    await capture.close()
    live.server(delta('two', 'Gone.', 2))
    expect(capture.snapshot().fragments.map((fragment) => fragment.text)).toEqual(['Here.'])
    expect(live.listenerCount('openai_server_event_received')).toBe(0)
    expect(await persistedText(store)).toEqual(['Here.'])
  })

  test('checkpoint failure is visible, close can retry, and the caller retains store ownership', async () => {
    const { capture, live, store } = await fixture()
    const originalCommit = store.commit.bind(store)
    const commit = vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('disk failed'))
    const storeClose = vi.spyOn(store, 'close')
    live.server(delta('one', 'Buffered.', 1))
    await expect(capture.close()).rejects.toThrow('disk failed')
    commit.mockImplementation(originalCommit)
    await capture.close()
    expect(storeClose).not.toHaveBeenCalled()
    expect(await persistedText(store)).toEqual(['Buffered.'])
  })

  test('periodic checkpoint reports errors and retries buffered data on the next interval', async () => {
    vi.useFakeTimers()
    try {
      const { capture, live, store, onError } = await fixture(new InMemoryStore(), 'timer')
      live.server(delta('one', 'Saved on retry.', 1))
      vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('disk failed'))
      await vi.advanceTimersByTimeAsync(500)
      expect(onError).toHaveBeenCalledWith(new Error('GPT Live transcript checkpoint failed'))
      await vi.advanceTimersByTimeAsync(500)
      expect(await persistedText(store, 'timer')).toEqual(['Saved on retry.'])
      await capture.close()
      expect(onError).toHaveBeenCalledTimes(1)
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
    expect(await persistedText(store)).toEqual(['First.', ' Second.'])
    await capture.close()
  })

  test.each(Array.from({ length: 25 }, (_, depth) => depth))(
    'a checkpoint or close %i microtasks after store completion persists later arrivals',
    async (depth) => {
      for (const close of [false, true]) {
        const callId = `microtasks-${close}`
        const { capture, live, store } = await fixture(new InMemoryStore(), callId)
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
        expect(await persistedText(store, callId)).toEqual(['First.', ' Second.'])
        await capture.close()
      }
    },
  )
})
