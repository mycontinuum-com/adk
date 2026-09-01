import type {
  Event,
  SharedScope,
  StateScope,
  ToolYieldEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
} from '../types/events'
import type { SessionStatus } from '../types/session'

import { buildInvocationTree, type InvocationNode } from './resume/tree'

export interface SessionSnapshot {
  eventIndex: number
  eventId: string
  timestamp: number

  sessionState: Record<string, unknown>
  scopedStates: Partial<Record<SharedScope, Record<string, unknown>>>

  status: SessionStatus
  currentAgentName: string | undefined
  yieldedTools: ToolYieldEvent[]
  invocationTree: InvocationNode[]

  event: Event
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotError'
  }
}

export function computeStateAtEvent(
  events: readonly Event[],
  eventIndex: number,
  scope: StateScope = 'session',
): Record<string, unknown> {
  if (eventIndex < 0 || eventIndex >= events.length) {
    throw new SnapshotError(
      `Event index ${eventIndex} out of bounds. Valid range: 0-${events.length - 1}`,
    )
  }

  const state: Record<string, unknown> = {}

  for (let i = 0; i <= eventIndex; i++) {
    const event = events[i]
    if (event.type === 'state_change' && event.scope === scope) {
      for (const change of event.changes) {
        if (change.newValue === undefined) {
          delete state[change.key]
        } else {
          state[change.key] = change.newValue
        }
      }
    }
  }

  return state
}

function computeSessionStatusAtEvent(events: readonly Event[], eventIndex: number): SessionStatus {
  const eventsUpTo = events.slice(0, eventIndex + 1)

  const yieldEvents = eventsUpTo.filter((e): e is ToolYieldEvent => e.type === 'tool_yield')
  const hasUnresolvedToolYield = yieldEvents.some(
    (y) => !eventsUpTo.some((e) => e.type === 'tool_result' && e.callId === y.callId),
  )
  if (hasUnresolvedToolYield) return 'awaiting_input'

  const inputYields = eventsUpTo.filter(
    (e): e is InvocationYieldEvent => e.type === 'invocation_yield' && e.awaitingInput === true,
  )
  const hasUnresolvedInputYield = inputYields.some(
    (yieldEvent) =>
      !eventsUpTo.some(
        (e): e is InvocationResumeEvent =>
          e.type === 'invocation_resume' &&
          e.invocationId === yieldEvent.invocationId &&
          e.yieldIndex === yieldEvent.yieldIndex,
      ),
  )
  if (hasUnresolvedInputYield) return 'awaiting_input'

  const lastEnd = [...eventsUpTo]
    .toReversed()
    .find((e): e is InvocationEndEvent => e.type === 'invocation_end')

  if (lastEnd?.reason === 'completed') return 'completed'
  if (lastEnd?.reason === 'error') return 'error'

  return 'active'
}

function computeCurrentAgentAtEvent(
  events: readonly Event[],
  eventIndex: number,
): string | undefined {
  const openInvocations = new Map<string, string>()

  for (let i = 0; i <= eventIndex; i++) {
    const event = events[i]
    if (event.type === 'invocation_start') {
      openInvocations.set(event.invocationId, event.agentName)
    } else if (event.type === 'invocation_end') {
      openInvocations.delete(event.invocationId)
    }
  }

  return [...openInvocations.values()].pop()
}

function computePendingYieldingCallsAtEvent(
  events: readonly Event[],
  eventIndex: number,
): ToolYieldEvent[] {
  const eventsUpTo = events.slice(0, eventIndex + 1)

  const yieldEvents = eventsUpTo.filter((e): e is ToolYieldEvent => e.type === 'tool_yield')

  return yieldEvents.filter(
    (y) => !eventsUpTo.some((e) => e.type === 'tool_result' && e.callId === y.callId),
  )
}

export function snapshotAt(events: readonly Event[], eventIndex: number): SessionSnapshot {
  if (events.length === 0) {
    throw new SnapshotError('Cannot create snapshot from empty event list')
  }

  if (eventIndex < 0 || eventIndex >= events.length) {
    throw new SnapshotError(
      `Event index ${eventIndex} out of bounds. Valid range: 0-${events.length - 1}`,
    )
  }

  const event = events[eventIndex]
  const eventsUpTo = events.slice(0, eventIndex + 1)

  const allStates = computeAllStatesAtEvent(events, eventIndex)

  return {
    eventIndex,
    eventId: event.id,
    timestamp: event.createdAt,

    sessionState: allStates.session,
    scopedStates: allStates.scopedStates,

    status: computeSessionStatusAtEvent(events, eventIndex),
    currentAgentName: computeCurrentAgentAtEvent(events, eventIndex),
    yieldedTools: computePendingYieldingCallsAtEvent(events, eventIndex),
    invocationTree: buildInvocationTree(eventsUpTo),

    event,
  }
}

export function findEventIndex(events: readonly Event[], eventId: string): number | undefined {
  const index = events.findIndex((e) => e.id === eventId)
  return index === -1 ? undefined : index
}

export interface InvocationBoundary {
  invocationId: string
  agentName: string
  startIndex: number
  endIndex: number | undefined
}

export function findInvocationBoundary(
  events: readonly Event[],
  invocationId: string,
): InvocationBoundary | undefined {
  let startIndex: number | undefined
  let endIndex: number | undefined
  let agentName: string | undefined

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'invocation_start' && event.invocationId === invocationId) {
      startIndex = i
      agentName = event.agentName
    } else if (event.type === 'invocation_end' && event.invocationId === invocationId) {
      endIndex = i
      break
    }
  }

  if (startIndex === undefined || agentName === undefined) {
    return undefined
  }

  return {
    invocationId,
    agentName,
    startIndex,
    endIndex,
  }
}

const SHARED_SCOPES: SharedScope[] = ['user', 'patient', 'practice', 'org', 'team']

export function computeAllStatesAtEvent(
  events: readonly Event[],
  eventIndex: number,
): {
  session: Record<string, unknown>
  scopedStates: Partial<Record<SharedScope, Record<string, unknown>>>
} {
  if (eventIndex < 0 || eventIndex >= events.length) {
    throw new SnapshotError(
      `Event index ${eventIndex} out of bounds. Valid range: 0-${events.length - 1}`,
    )
  }

  const session: Record<string, unknown> = {}
  const scopeMap: Record<string, Record<string, unknown>> = { session }
  for (const s of SHARED_SCOPES) {
    scopeMap[s] = {}
  }

  for (let i = 0; i <= eventIndex; i++) {
    const event = events[i]
    if (event.type === 'state_change') {
      const target = scopeMap[event.scope]
      if (target) {
        for (const change of event.changes) {
          if (change.newValue === undefined) {
            delete target[change.key]
          } else {
            target[change.key] = change.newValue
          }
        }
      }
    }
  }

  const scopedStates: Partial<Record<SharedScope, Record<string, unknown>>> = {}
  for (const s of SHARED_SCOPES) {
    const state = scopeMap[s]
    if (Object.keys(state).length > 0) {
      scopedStates[s] = state
    }
  }

  return { session, scopedStates }
}
