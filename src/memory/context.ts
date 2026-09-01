import type { SystemEvent } from '../types/events'
import type { ContextRenderer, RenderContext } from '../types/runnables'
import type { ContextConfig, SearchOptions, SearchResult } from './types'

import { createEventId } from '../core/constants'
import { renderMatches } from './filter'

type ContextInternals<TMetadata extends Record<string, unknown>> = ContextConfig<TMetadata> & {
  search: (text: string, options?: SearchOptions) => Promise<SearchResult<TMetadata>>
}

export function createMemoryContext<TMetadata extends Record<string, unknown>>(
  config: ContextInternals<TMetadata>,
): ContextRenderer {
  return async (ctx: RenderContext): Promise<RenderContext> => {
    const queryText = config.query(ctx)
    if (!queryText) return ctx

    const filter = typeof config.filter === 'function' ? config.filter(ctx) : config.filter

    const { matches } = await config.search(queryText, {
      topK: config.topK,
      filter,
      minScore: config.minScore,
    })

    if (matches.length === 0) return ctx

    const rendered = config.render ? config.render(matches) : renderMatches(matches)

    const systemEvent: SystemEvent = {
      id: createEventId(),
      type: 'system',
      createdAt: Date.now(),
      invocationId: ctx.invocationId,
      agentName: ctx.agentName,
      text: rendered,
    }

    return {
      ...ctx,
      events: [...ctx.events, systemEvent],
    }
  }
}
