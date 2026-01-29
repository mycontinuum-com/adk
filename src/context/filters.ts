import type {
  ContextRenderer,
  InvocationStartEvent,
  ToolChoice,
  UserEvent,
} from '../types';

/**
 * Keep only the most recent N events in context (preserves system instructions).
 * @param count - Number of recent non-system events to keep
 * @returns Context renderer that filters events
 * @example
 * selectRecentEvents(20) // Keep last 20 non-system events
 */
export function selectRecentEvents(count: number): ContextRenderer {
  return (ctx) => {
    const systemEvents = ctx.events.filter((e) => e.type === 'system');
    const nonSystemEvents = ctx.events.filter((e) => e.type !== 'system');

    if (nonSystemEvents.length <= count) return ctx;

    return {
      ...ctx,
      events: [...systemEvents, ...nonSystemEvents.slice(-count)],
    };
  };
}

/**
 * Remove thinking/reasoning tokens from context to reduce token usage.
 * @returns Context renderer that filters out thought events
 */
export function pruneReasoning(): ContextRenderer {
  return (ctx) => ({
    ...ctx,
    events: ctx.events.filter((e) => e.type !== 'thought'),
  });
}

/**
 * Remove user messages tagged with a specific agent name.
 * @param agentName - Agent name to filter, or 'self' to filter messages matching current agent
 * @returns Context renderer that filters user messages
 * @example
 * pruneUserMessages('self')              // Filter messages tagged with current agent's name
 * pruneUserMessages('questionnaire_agent') // Filter messages tagged with specific agent
 */
export function pruneUserMessages(agentName: string): ContextRenderer {
  return (ctx) => ({
    ...ctx,
    events: ctx.events.filter((e) => {
      if (e.type !== 'user') return true;
      const targetName = agentName === 'self' ? ctx.agentName : agentName;
      return (e as UserEvent).agentName !== targetName;
    }),
  });
}

/**
 * Exclude user messages from child invocations (call/spawn/dispatch/transfer).
 * Prevents sub-agent instructions from appearing in parent context.
 * @returns Context renderer that filters child invocation user messages
 */
export function excludeChildInvocationInstructions(): ContextRenderer {
  return (ctx) => {
    const childInvocationIds = new Set<string>();
    for (const e of ctx.events) {
      if (e.type === 'invocation_start') {
        const start = e as InvocationStartEvent;
        if (
          start.handoffOrigin &&
          (start.handoffOrigin.type === 'call' ||
            start.handoffOrigin.type === 'spawn' ||
            start.handoffOrigin.type === 'dispatch' ||
            start.handoffOrigin.type === 'transfer')
        ) {
          childInvocationIds.add(start.invocationId);
        }
      }
    }

    if (childInvocationIds.size === 0) return ctx;

    return {
      ...ctx,
      events: ctx.events.filter((e) => {
        if (
          e.type === 'user' &&
          e.invocationId &&
          childInvocationIds.has(e.invocationId)
        ) {
          return false;
        }
        return true;
      }),
    };
  };
}

/**
 * Exclude all events from child invocations (call/spawn/dispatch/transfer).
 * Useful when parent agent shouldn't see sub-agent conversation details.
 * @returns Context renderer that filters all child invocation events
 */
export function excludeChildInvocationEvents(): ContextRenderer {
  return (ctx) => {
    const childInvocationIds = new Set<string>();
    for (const e of ctx.events) {
      if (e.type === 'invocation_start') {
        const start = e as InvocationStartEvent;
        if (
          start.handoffOrigin &&
          (start.handoffOrigin.type === 'call' ||
            start.handoffOrigin.type === 'spawn' ||
            start.handoffOrigin.type === 'dispatch' ||
            start.handoffOrigin.type === 'transfer')
        ) {
          childInvocationIds.add(start.invocationId);
        }
      }
    }

    if (childInvocationIds.size === 0) return ctx;

    return {
      ...ctx,
      events: ctx.events.filter((e) => {
        if (e.invocationId && childInvocationIds.has(e.invocationId)) {
          return false;
        }
        return true;
      }),
    };
  };
}

/**
 * Restrict which tools are available to the agent for this context.
 * @param tools - Array of tool names to allow
 * @returns Context renderer that sets allowed tools
 * @example
 * limitTools(['approve', 'reject']) // Only allow approve/reject tools
 */
export function limitTools(tools: string[]): ContextRenderer {
  return (ctx) => ({
    ...ctx,
    allowedTools: tools,
  });
}

/**
 * Override the tool choice mode for this context.
 * @param choice - 'auto' | 'none' | 'required' | { name: string }
 * @returns Context renderer that sets tool choice
 * @example
 * setToolChoice('required')      // Must use a tool
 * setToolChoice('none')          // Cannot use tools
 * setToolChoice({ name: 'save' }) // Must use specific tool
 */
export function setToolChoice(choice: ToolChoice): ContextRenderer {
  return (ctx) => ({
    ...ctx,
    toolChoice: choice,
  });
}
