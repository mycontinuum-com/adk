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

/**
 * Projects transcript fragments into user and assistant events, in receipt order. The caller's
 * consecutive fragments on one connection are one event, up to the next delegation: GPT Live
 * transcribes the caller in word-sized deltas that carry their own spacing, and a spelled name
 * given to the backend one letter per message was misread. A joined event keeps its first
 * fragment's ID and start offset and its last fragment's sequence and end offset. Assistant
 * fragments stay one event each, since their deltas can split a word. The backend and eval results
 * read this one view.
 */
export function transcriptMessages(
  snapshot: GPTLiveTranscriptSnapshot,
  agentName: string,
): Array<UserEvent | AssistantEvent> {
  const delegations = snapshot.observations
    .filter(({ payload }) => payload.kind === 'delegation')
    .map(({ sequence }) => sequence)
  const messages: Array<UserEvent | AssistantEvent> = []
  for (const fragment of snapshot.fragments) {
    const previous = messages.at(-1)
    const joined = previous?.transcriptFragment
    if (
      fragment.speaker === 'caller' &&
      previous?.type === 'user' &&
      joined &&
      joined.connection.index === fragment.connection.index &&
      !delegations.some((sequence) => sequence > joined.sequence && sequence < fragment.sequence)
    ) {
      messages[messages.length - 1] = {
        ...previous,
        text: previous.text + fragment.text,
        transcriptFragment: {
          ...joined,
          sequence: fragment.sequence,
          startMs: joined.startMs ?? fragment.startMs,
          endMs: fragment.endMs ?? joined.endMs,
        },
      }
      continue
    }
    messages.push({
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
    })
  }
  return messages
}

/**
 * Builds a delegation's backend history. Each earlier batch of backend work is placed after the
 * transcript at its receipt boundary, followed by the transcript that arrived later.
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
  const workKey = (event: { invocationId: string; callId: string }) =>
    JSON.stringify([event.invocationId, event.callId])
  const resultKeys = new Set<string>()
  for (const event of events) if (event.type === 'tool_result') resultKeys.add(workKey(event))
  const paired = new Set<string>()
  const unresolved: Array<{ callId: string; name: string }> = []
  for (const event of events) {
    if (event.type !== 'tool_call') continue
    const key = workKey(event)
    if (resultKeys.has(key)) paired.add(key)
    else unresolved.push({ callId: event.callId, name: event.name })
  }
  return {
    events: events.filter(
      (event) =>
        backendEventTypes.has(event.type) &&
        ((event.type !== 'tool_call' && event.type !== 'tool_result') ||
          paired.has(workKey(event))),
    ),
    unresolved,
  }
}
