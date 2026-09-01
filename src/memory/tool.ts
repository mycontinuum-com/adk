import { z } from 'zod'

import type { FunctionTool } from '../types/runnables'
import type { ToolConfig, SearchOptions, SearchResult } from './types'

import { renderMatches } from './filter'

type ToolInternals<TMetadata extends Record<string, unknown>> = ToolConfig<TMetadata> & {
  search: (text: string, options?: SearchOptions) => Promise<SearchResult<TMetadata>>
}

export function createMemoryTool<TMetadata extends Record<string, unknown>>(
  config: ToolInternals<TMetadata>,
): FunctionTool {
  const schema = z.object({
    query: z.string().describe('Natural language search query'),
  })

  return {
    name: config.name ?? 'memory_search',
    description: config.description,
    schema,

    async execute(ctx) {
      const { query } = schema.parse(ctx.args)

      const filter =
        typeof config.filter === 'function'
          ? config.filter({ state: ctx.state as Record<string, unknown> })
          : config.filter

      const { matches } = await config.search(query, {
        topK: config.topK,
        filter,
        minScore: config.minScore,
      })

      if (config.render) {
        return config.render(matches)
      }

      return renderMatches(matches)
    },
  }
}
