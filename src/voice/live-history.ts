import type { Event, UserEvent, AssistantEvent } from '../types/events'
import type { GPTLiveTranscriptSnapshot } from './gpt-live-transcript'

const backendEventTypes = new Set<Event['type']>([
  'system',
  'invocation_start',
  'invocation_end',
  'thought',
  'tool_call',
  'tool_result',
])

/** Projects transcript fragments into user and assistant events, in receipt order. */
export function transcriptMessages(
  snapshot: GPTLiveTranscriptSnapshot,
  agentName: string,
): Array<UserEvent | AssistantEvent> {
  return snapshot.fragments.map((fragment) => ({
    id: `${snapshot.callId}/transcript/${fragment.sequence}`,
    type: fragment.speaker === 'caller' ? 'user' : 'assistant',
    text: fragment.text,
    createdAt: fragment.receivedAt,
    invocationId: '',
    agentName,
    source: 'transcript',
    transcriptFragment: {
      connection: fragment.connection,
      sequence: fragment.sequence,
      startMs: fragment.startMs,
      endMs: fragment.endMs,
    },
  }))
}

/**
 * Builds a delegation's backend history. Each earlier batch of backend work is placed after the
 * transcript fragments at its receipt boundary, followed by the fragments that arrived later.
 */
export function liveHistory(
  events: readonly Event[],
  snapshot: GPTLiveTranscriptSnapshot,
  agentName: string,
): Event[] {
  const messages = transcriptMessages(snapshot, agentName)
  const history: Event[] = []
  let index = 0
  for (const event of events) {
    if (event.type === 'annotation' && event.label === 'live-backend-work') {
      const through = event.data?.transcriptThrough as number
      while (index < messages.length && messages[index]!.transcriptFragment!.sequence <= through)
        history.push(messages[index++]!)
    } else if (backendEventTypes.has(event.type)) history.push(event)
  }
  history.push(...messages.slice(index))
  return history
}

/**
 * Selects the backend events a delegation carries forward: reasoning, invocation markers and paired
 * tool calls and results. Tool calls without a result are listed in `unresolved` instead.
 */
export function completedBackendWork(events: readonly Event[]): {
  events: Event[]
  unresolved: Array<{ callId: string; name: string }>
} {
  const calls = events.filter((event) => event.type === 'tool_call')
  const results = events.filter((event) => event.type === 'tool_result')
  const paired = new Set(
    calls
      .filter((call) =>
        results.some(
          (result) => result.callId === call.callId && result.invocationId === call.invocationId,
        ),
      )
      .map((call) => JSON.stringify([call.invocationId, call.callId])),
  )
  return {
    events: events.filter(
      (event) =>
        backendEventTypes.has(event.type) &&
        ((event.type !== 'tool_call' && event.type !== 'tool_result') ||
          paired.has(JSON.stringify([event.invocationId, event.callId]))),
    ),
    unresolved: calls
      .filter((call) => !paired.has(JSON.stringify([call.invocationId, call.callId])))
      .map(({ callId, name }) => ({ callId, name })),
  }
}
