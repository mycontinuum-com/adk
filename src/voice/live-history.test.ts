import { EventEmitter } from 'node:events'

import type { Event } from '../types/events'

import { InMemoryStore } from '../session/memory'
import { createGPTLiveTranscript } from './gpt-live-transcript'
import { completedBackendWork, liveHistory, transcriptMessages } from './live-history'

test('projects receipt order with stable identity instead of inventing turn order', async () => {
  const recorder = await createGPTLiveTranscript(new InMemoryStore(), 'call', () => {})
  const source = Object.assign(new EventEmitter(), { sessionId: 'connection' })
  recorder.attach(source)
  const fragment = (id: string, text: string, start: number, end: number) => {
    source.emit('openai_server_event_received', {
      type: 'session.input_transcript.delta',
      event_id: id,
      delta: text,
      start_ms: start,
      end_ms: end,
    })
  }
  fragment('later', ' Friday', 300, 400)
  fragment('earlier', 'I said', 100, 200)
  const snapshot = recorder.snapshot()
  fragment('middle', 'next', 200, 300)
  const projected = transcriptMessages(snapshot, 'backend')
  expect(projected.map((event) => event.text)).toEqual([' Friday', 'I said'])
  expect(projected.map((event) => event.transcriptFragment?.startMs)).toEqual([300, 100])
  expect(projected.map((event) => event.id)).toEqual(
    transcriptMessages(snapshot, 'backend').map((event) => event.id),
  )
  expect(projected.map((event) => event.createdAt)).toEqual(
    snapshot.observations
      .filter((event) => event.payload.kind === 'transcript')
      .map((event) => event.receivedAt),
  )
  await recorder.close()
})

test('carries completed tool pairs and lineage without backend prose or orphan calls', () => {
  const base = { createdAt: 100, invocationId: 'invocation', agentName: 'backend' }
  const providerContext = { provider: 'openai', data: { synthetic: 'retained' } }
  const events: Event[] = [
    { ...base, id: 'start', type: 'invocation_start', kind: 'agent' },
    { ...base, id: 'thought', type: 'thought', text: 'Check the request', providerContext },
    {
      ...base,
      id: 'call',
      type: 'tool_call',
      callId: 'complete',
      name: 'lookup',
      args: {},
      providerContext,
    },
    {
      ...base,
      id: 'result',
      type: 'tool_result',
      callId: 'complete',
      name: 'lookup',
      result: { found: true },
    },
    { ...base, id: 'pending', type: 'tool_call', callId: 'unknown', name: 'submit', args: {} },
    { ...base, id: 'orphan', type: 'tool_result', callId: 'absent', name: 'lookup', result: {} },
    { ...base, id: 'prose', type: 'assistant', text: 'Tell the caller it worked' },
    { ...base, id: 'end', type: 'invocation_end', reason: 'completed' },
  ]
  const work = completedBackendWork(events)
  expect(work.events.map((event) => event.id)).toEqual([
    'start',
    'thought',
    'call',
    'result',
    'end',
  ])
  expect(work.events[2]).toEqual(events[2])
  expect(work.unresolved).toEqual([{ callId: 'unknown', name: 'submit' }])
})

test('restores receipt-anchored work in stable blocks across equal boundaries and reconnects', async () => {
  const recorder = await createGPTLiveTranscript(new InMemoryStore(), 'call', () => {})
  const source = Object.assign(new EventEmitter(), { sessionId: 'connection' })
  recorder.attach(source)
  const fragment = (text: string) =>
    source.emit('openai_server_event_received', {
      type: 'session.input_transcript.delta',
      event_id: text,
      delta: text,
    })
  fragment('First')
  const first = recorder.snapshot()
  const base = { createdAt: 100, invocationId: 'run', agentName: 'backend' }
  const work = completedBackendWork([
    { ...base, id: 'call', type: 'tool_call', callId: 'done', name: 'lookup', args: {} },
    { ...base, id: 'result', type: 'tool_result', callId: 'done', name: 'lookup', result: 'Found' },
    { ...base, id: 'unknown', type: 'tool_call', callId: 'unknown', name: 'submit', args: {} },
  ])
  const events: Event[] = [
    {
      ...base,
      id: 'batch',
      type: 'annotation',
      kind: 'mark',
      label: 'live-backend-work',
      data: { transcriptThrough: first.receivedThrough },
    },
    { ...base, id: 'note', type: 'system', text: 'Unresolved submit; do not retry.' },
    ...work.events,
    {
      ...base,
      id: 'equal',
      type: 'annotation',
      kind: 'mark',
      label: 'live-backend-work',
      data: { transcriptThrough: first.receivedThrough },
    },
    { ...base, id: 'second-note', type: 'system', text: 'Second batch.' },
  ]
  source.emit('openai_server_event_received', {
    type: 'session.started',
    session: { id: 'reconnected' },
  })
  fragment('Second')
  const frozen = recorder.snapshot()
  fragment('Later')
  const projected = liveHistory(structuredClone(events), frozen, 'backend')
  expect(projected.map((event) => event.id)).toEqual([
    `call/transcript/${first.fragments[0]!.sequence}`,
    'note',
    'call',
    'result',
    'second-note',
    `call/transcript/${frozen.fragments[1]!.sequence}`,
  ])
  expect(projected.at(-1)).toMatchObject({
    text: 'Second',
    transcriptFragment: { connection: { index: 2 } },
  })
  expect(projected.slice(0, 5)).toEqual(liveHistory(events, first, 'backend'))
  expect(work.unresolved).toEqual([{ callId: 'unknown', name: 'submit' }])
  await recorder.close()
})
