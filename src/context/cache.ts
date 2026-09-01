import type { SyncContextRenderer } from '../types'
import type { SystemEvent, UserEvent } from '../types/events'
import type { StateSchema } from '../types/schema'

import { createEventId } from '../session'

/**
 * Inject a system message tagged as cacheable for Claude/Vertex prompt caching.
 *
 * This does not enable caching by itself; it only tags the event so that providers that support
 * prompt caching can apply `cache_control` safely.
 */
export function injectCacheableSystemMessage<S extends StateSchema = StateSchema>(
  text: string,
): SyncContextRenderer<S>
export function injectCacheableSystemMessage(text: string): SyncContextRenderer {
  return (renderCtx) => {
    const systemEvent: SystemEvent = {
      id: createEventId(),
      type: 'system',
      createdAt: Date.now(),
      invocationId: renderCtx.invocationId,
      agentName: renderCtx.agentName,
      text,
      providerContext: {
        provider: 'adk',
        data: { cacheable: true },
      },
    }

    return {
      ...renderCtx,
      events: [...renderCtx.events, systemEvent],
    }
  }
}

/**
 * Inject a user message tagged for provider prompt caching.
 *
 * This does not enable caching by itself; the selected provider model must also enable caching.
 */
export function injectCacheableUserMessage<S extends StateSchema = StateSchema>(
  text: string,
): SyncContextRenderer<S>
export function injectCacheableUserMessage(text: string): SyncContextRenderer {
  return (renderCtx) => {
    const userEvent: UserEvent = {
      id: createEventId(),
      type: 'user',
      createdAt: Date.now(),
      invocationId: renderCtx.invocationId,
      agentName: renderCtx.agentName,
      text,
      providerContext: {
        provider: 'adk',
        data: { cacheable: true },
      },
    }

    return {
      ...renderCtx,
      events: [...renderCtx.events, userEvent],
    }
  }
}
