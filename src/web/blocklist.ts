import type { FetchPipeline, FetchPageResult } from './types'

export interface BlocklistEntry {
  pattern: RegExp
  message: string
}

const DEFAULT_BLOCKLIST: BlocklistEntry[] = [
  {
    pattern: /linkedin\.com\/in\//,
    message: 'LinkedIn profile data is not accessible via direct browsing.',
  },
  {
    pattern: /linkedin\.com\/company\//,
    message: 'LinkedIn company data is not accessible via direct browsing.',
  },
  {
    pattern: /linkedin\.com\/posts\//,
    message:
      'LinkedIn posts are not accessible via direct browsing due to authentication requirements.',
  },
  {
    pattern: /linkedin\.com\/feed/,
    message:
      'LinkedIn feed is not accessible via direct browsing due to authentication requirements.',
  },
]

export interface BlocklistPipelineOptions {
  entries?: BlocklistEntry[]
  includeDefaults?: boolean
}

export function blocklistPipeline(options?: BlocklistPipelineOptions): FetchPipeline {
  const includeDefaults = options?.includeDefaults ?? true
  const customEntries = options?.entries ?? []
  const entries = includeDefaults ? [...DEFAULT_BLOCKLIST, ...customEntries] : customEntries

  return {
    name: 'blocklist',
    patterns: entries.map((e) => e.pattern),

    async fetch(url: string): Promise<FetchPageResult> {
      const entry = entries.find((e) => e.pattern.test(url))
      const message = entry?.message ?? 'URL is blocked.'
      return {
        success: true,
        url,
        title: 'Blocked URL',
        content: message,
        wordCount: message.split(/\s+/).length,
        pipeline: 'blocklist',
      }
    },
  }
}
