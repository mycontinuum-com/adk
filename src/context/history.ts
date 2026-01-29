import type { ContextRenderer, Session, Event } from '../types';

export type HistoryScope = 'all' | 'invocation' | 'ancestors' | 'agent';

export interface IncludeHistoryOptions {
  scope?: HistoryScope;
  agents?: string[];
}

function getAncestorInvocationIds(
  events: Session['events'],
  currentInvocationId: string,
): Set<string> {
  const ancestors = new Set<string>();
  let invId: string | undefined = currentInvocationId;

  while (invId) {
    const startEvent = events.find(
      (e) => e.type === 'invocation_start' && e.invocationId === invId,
    );
    if (
      startEvent?.type === 'invocation_start' &&
      startEvent.parentInvocationId
    ) {
      ancestors.add(startEvent.parentInvocationId);
      invId = startEvent.parentInvocationId;
    } else {
      break;
    }
  }

  return ancestors;
}

/**
 * Include conversation history from the session in the model context.
 * Use `scope` to control which events are visible to the agent.
 * @param options - History filtering options
 * @param options.scope - 'all' (default) | 'invocation' | 'ancestors' | 'agent'
 * @param options.agents - Agent names to include (used with 'agent' scope, or to extend other scopes)
 * @returns Context renderer that adds session events
 * @example
 * includeHistory()                          // All events (default)
 * includeHistory({ scope: 'invocation' })   // Only current invocation
 * includeHistory({ scope: 'ancestors' })    // Current + parent chain
 * includeHistory({ scope: 'agent' })        // User events + own events
 * includeHistory({ scope: 'agent', agents: ['other_agent'] })  // + assistant from other agents
 */
export function includeHistory(
  options?: IncludeHistoryOptions,
): ContextRenderer {
  const scope = options?.scope ?? 'all';
  const agents = options?.agents ?? [];

  return (ctx) => {
    const sessionEvents = ctx.session.events;

    if (scope === 'all' && agents.length === 0) {
      return {
        ...ctx,
        events: [...ctx.events, ...sessionEvents],
      };
    }

    const isUserEvent = (e: Event) => e.type === 'user';
    const isOwnEvent = (e: Event) => e.agentName === ctx.agentName;
    const isFromIncludedAgent = (e: Event) =>
      e.type === 'assistant' && agents.includes(e.agentName ?? '');

    if (scope === 'agent') {
      const filtered = sessionEvents.filter(
        (e) => isUserEvent(e) || isOwnEvent(e) || isFromIncludedAgent(e),
      );
      return {
        ...ctx,
        events: [...ctx.events, ...filtered],
      };
    }

    if (scope === 'invocation') {
      const filtered = sessionEvents.filter(
        (e) => !e.invocationId || e.invocationId === ctx.invocationId,
      );
      return {
        ...ctx,
        events: [...ctx.events, ...filtered],
      };
    }

    if (scope === 'ancestors') {
      const ancestorIds = getAncestorInvocationIds(
        sessionEvents,
        ctx.invocationId,
      );
      const filtered = sessionEvents.filter(
        (e) =>
          !e.invocationId ||
          e.invocationId === ctx.invocationId ||
          ancestorIds.has(e.invocationId),
      );
      return {
        ...ctx,
        events: [...ctx.events, ...filtered],
      };
    }

    return {
      ...ctx,
      events: [...ctx.events, ...sessionEvents],
    };
  };
}
