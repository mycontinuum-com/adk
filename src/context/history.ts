import type { SyncContextRenderer, Session, Event, StateSchema } from '../types'

export type HistoryScope = 'direct' | 'all' | 'invocation' | 'ancestors' | 'agent'

function isUserHistoryEvent(e: Event): boolean {
  return e.type === 'user'
}

export interface IncludeHistoryOptions {
  scope?: HistoryScope
  agents?: string[]
}

function getAncestorInvocationIds(
  events: Session['events'],
  currentInvocationId: string,
): Set<string> {
  const ancestors = new Set<string>()
  let invId: string | undefined = currentInvocationId

  while (invId) {
    const startEvent = events.find((e) => e.type === 'invocation_start' && e.invocationId === invId)
    if (startEvent?.type === 'invocation_start' && startEvent.parentInvocationId) {
      ancestors.add(startEvent.parentInvocationId)
      invId = startEvent.parentInvocationId
    } else {
      break
    }
  }

  return ancestors
}

function getRootInvocationIds(events: Session['events']): Set<string> {
  const ids = new Set<string>()
  for (const e of events) {
    if (e.type === 'invocation_start') {
      if (!e.handoffOrigin) {
        ids.add(e.invocationId)
      }
    }
  }
  return ids
}

function getLineageIds(events: Session['events'], currentInvocationId: string): Set<string> {
  const ids = new Set<string>()
  ids.add(currentInvocationId)

  for (const id of getAncestorInvocationIds(events, currentInvocationId)) {
    ids.add(id)
  }

  for (const id of getRootInvocationIds(events)) {
    ids.add(id)
  }

  return ids
}

function isIsolatedHandoffTarget(events: Session['events'], invocationId: string): boolean {
  const startEvent = events.find(
    (e) => e.type === 'invocation_start' && e.invocationId === invocationId,
  )
  if (startEvent?.type !== 'invocation_start') return false
  const origin = startEvent.handoffOrigin
  return (
    !!origin &&
    (origin.type === 'run' ||
      origin.type === 'call' ||
      origin.type === 'spawn' ||
      origin.type === 'dispatch')
  )
}

function getDirectIds(events: Session['events'], currentInvocationId: string): Set<string> {
  const ids = new Set<string>()
  ids.add(currentInvocationId)

  if (isIsolatedHandoffTarget(events, currentInvocationId)) {
    return ids
  }

  for (const id of getRootInvocationIds(events)) {
    ids.add(id)
  }

  return ids
}

/**
 * Include conversation history from the session in the model context. Use `scope` to control which
 * events are visible to the agent.
 *
 * @example
 *   includeHistory() // Direct conversation (default)
 *   includeHistory({ scope: 'all' }) // All events unfiltered
 *   includeHistory({ scope: 'invocation' }) // Only current invocation
 *   includeHistory({ scope: 'ancestors' }) // Current + parent chain + cross-turn roots
 *   includeHistory({ scope: 'agent' }) // Lineage filtered by agent name
 *   includeHistory({ scope: 'agent', agents: ['other_agent'] }) // + assistant from other agents
 *
 * @param options - History filtering options
 * @param options.scope - 'direct' (default) | 'all' | 'invocation' | 'ancestors' | 'agent'
 * @param options.agents - Agent names to include (used with 'agent' scope, or to extend other
 *   scopes)
 * @returns Context renderer that adds session events
 */
export function includeHistory<S extends StateSchema = StateSchema>(
  options?: IncludeHistoryOptions,
): SyncContextRenderer<S> {
  const scope = options?.scope ?? 'direct'
  const agents = options?.agents ?? []

  return (ctx) => {
    const sessionEvents = ctx.session.events

    if (scope === 'all') {
      return {
        ...ctx,
        events: [...ctx.events, ...sessionEvents],
      }
    }

    if (scope === 'invocation') {
      const filtered = sessionEvents.filter(
        (e) => !e.invocationId || e.invocationId === ctx.invocationId,
      )
      return {
        ...ctx,
        events: [...ctx.events, ...filtered],
      }
    }

    if (scope === 'ancestors') {
      const lineage = getLineageIds(sessionEvents, ctx.invocationId)
      const filtered = sessionEvents.filter((e) => !e.invocationId || lineage.has(e.invocationId))
      return {
        ...ctx,
        events: [...ctx.events, ...filtered],
      }
    }

    if (scope === 'agent') {
      const lineage = getLineageIds(sessionEvents, ctx.invocationId)
      const inLineage = (e: Event) => !e.invocationId || lineage.has(e.invocationId)
      const isOwnEvent = (e: Event) => e.agentName === ctx.agentName
      const isFromIncludedAgent = (e: Event) =>
        e.type === 'assistant' && agents.includes(e.agentName ?? '')
      const filtered = sessionEvents.filter(
        (e) => inLineage(e) && (isUserHistoryEvent(e) || isOwnEvent(e) || isFromIncludedAgent(e)),
      )
      return {
        ...ctx,
        events: [...ctx.events, ...filtered],
      }
    }

    const directIds = getDirectIds(sessionEvents, ctx.invocationId)
    const filtered = sessionEvents.filter((e) => !e.invocationId || directIds.has(e.invocationId))
    return {
      ...ctx,
      events: [...ctx.events, ...filtered],
    }
  }
}
