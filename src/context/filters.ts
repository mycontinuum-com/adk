import type { SyncContextRenderer, ToolChoice, StateSchema } from '../types'

export function selectRecentEvents<S extends StateSchema = StateSchema>(
  count: number,
): SyncContextRenderer<S> {
  return (ctx) => {
    const systemEvents = ctx.events.filter((e) => e.type === 'system')
    // Only include events that are actually serialized into model prompts.
    // Internal bookkeeping events (invocation/model/state lifecycle) can balloon
    // the event count and cause us to truncate in the middle of a tool call,
    // which Claude rejects (tool_result without preceding tool_use).
    const promptEvents = ctx.events.filter(
      (e) =>
        e.type === 'user' ||
        e.type === 'assistant' ||
        e.type === 'thought' ||
        e.type === 'tool_call' ||
        e.type === 'tool_result',
    )

    if (promptEvents.length <= count) return ctx

    const sliced = promptEvents.slice(-count)

    // Ensure we never include a tool_result without its corresponding tool_call
    // somewhere earlier in the selected window. If required, include the matching
    // tool_call even if it falls outside the strict count.
    const slicedToolCallIds = new Set<string>()
    for (const e of sliced) {
      if (e.type === 'tool_call') {
        slicedToolCallIds.add(e.callId)
      }
    }

    const extraToolCalls: typeof sliced = []
    for (const e of sliced) {
      if (e.type !== 'tool_result') continue
      const callId = e.callId
      if (!callId || slicedToolCallIds.has(callId)) continue

      // Find the most recent matching tool_call before this tool_result in the original promptEvents
      const idx = promptEvents.indexOf(e)
      for (let i = idx - 1; i >= 0; i--) {
        const prev = promptEvents[i]!
        if (prev.type === 'tool_call' && prev.callId === callId) {
          extraToolCalls.push(prev)
          slicedToolCallIds.add(callId)
          break
        }
      }
    }

    // De-dupe while preserving order: extras first (older), then sliced
    const seen = new Set<string>()
    const merged = [...extraToolCalls, ...sliced].filter((e) => {
      const key = `${e.type}:${e.id ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return { ...ctx, events: [...systemEvents, ...merged] }
  }
}

/**
 * Remove thinking/reasoning tokens from context to reduce token usage.
 *
 * @returns Context renderer that filters out thought events
 */
export function pruneReasoning<S extends StateSchema = StateSchema>(): SyncContextRenderer<S> {
  return (ctx) => ({
    ...ctx,
    events: ctx.events.filter((e) => e.type !== 'thought'),
  })
}

/**
 * Remove user messages tagged with a specific agent name.
 *
 * @example
 *   pruneUserMessages('self') // Filter messages tagged with current agent's name
 *   pruneUserMessages('questionnaire_agent') // Filter messages tagged with specific agent
 *
 * @param agentName - Agent name to filter, or 'self' to filter messages matching current agent
 * @returns Context renderer that filters user messages
 */
export function pruneUserMessages<S extends StateSchema = StateSchema>(
  agentName: string,
): SyncContextRenderer<S> {
  return (ctx) => ({
    ...ctx,
    events: ctx.events.filter((e) => {
      if (e.type !== 'user') return true
      const targetName = agentName === 'self' ? ctx.agentName : agentName
      return e.agentName !== targetName
    }),
  })
}

/**
 * Restrict which tools are available to the agent for this context.
 *
 * @example
 *   limitTools(['approve', 'reject']) // Only allow approve/reject tools
 *
 * @param tools - Array of tool names to allow
 * @returns Context renderer that sets allowed tools
 */
export function limitTools<S extends StateSchema = StateSchema>(
  tools: string[],
): SyncContextRenderer<S> {
  return (ctx) => ({
    ...ctx,
    allowedTools: tools,
  })
}

/**
 * Override the tool choice mode for this context.
 *
 * @example
 *   setToolChoice('required') // Must use a tool
 *   setToolChoice('none') // Cannot use tools
 *   setToolChoice({ name: 'save' }) // Must use specific tool
 *
 * @param choice - 'auto' | 'none' | 'required' | { name: string }
 * @returns Context renderer that sets tool choice
 */
export function setToolChoice<S extends StateSchema = StateSchema>(
  choice: ToolChoice,
): SyncContextRenderer<S> {
  return (ctx) => ({
    ...ctx,
    toolChoice: choice,
  })
}
