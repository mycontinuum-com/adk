import { z } from 'zod'

import type { AdkApp } from '../api/app'
import type { ToolSpec } from '../api/spec'
import type { MediaPart } from '../types/events'
import type { FunctionTool, ToolExecutionContext } from '../types/runnables'
import type { StateSchema } from '../types/schema'
import type {
  SearchProvider,
  SearchResult,
  FetchPageResult,
  ProxyConfig,
  FetchPipeline,
} from './types'

import { screenshotPage } from './browser'
import { fetchPages as fetchPagesFn } from './fetch'
import { SerperProvider } from './serper'

export interface WebSearchConfig {
  numResults?: number
  searchType?: 'web' | 'news' | 'images'
  country?: string
  autoFetch?: boolean
  autoFetchTop?: number
  autoFetchRender?: boolean
  provider?: SearchProvider
  allowCountryOverride?: boolean
  proxy?: ProxyConfig
  pipelines?: FetchPipeline[]
}

type WebSearchArgs = { query: string; country?: string | null }
type WebSearchResult = { results: SearchResult[] }

export function webSearch(
  config?: WebSearchConfig,
): ToolSpec<WebSearchArgs, WebSearchResult, never, StateSchema> {
  // Built lazily: constructing SerperProvider demands SERPER_API_KEY, and a module that merely
  // defines a research agent must be importable without it. The key is a run-time requirement, not
  // a definition-time one.
  let provider = config?.provider
  const resolveProvider = (): SearchProvider => (provider ??= new SerperProvider())

  const allowCountry = config?.allowCountryOverride ?? true

  const baseSchema = z.object({
    query: z.string().describe('The search query'),
  })

  const schemaWithCountry = baseSchema.extend({
    country: z
      .string()
      .nullable()
      .optional()
      .describe('Country code for localized results (e.g. US, GB)'),
  })

  const schema = allowCountry ? schemaWithCountry : baseSchema

  return (
    app: AdkApp<StateSchema>,
  ): FunctionTool<WebSearchArgs, WebSearchResult, never, StateSchema> => {
    return app.tool({
      name: 'web_search',
      description:
        'Search the web for information. Returns search results with titles, URLs, and snippets.',
      schema: schema as z.ZodType<WebSearchArgs>,
      execute: async (
        ctx: ToolExecutionContext<WebSearchArgs, never, unknown, StateSchema>,
      ): Promise<WebSearchResult> => {
        const { query, country: argCountry } = ctx.args
        const country = argCountry || config?.country

        const results = await resolveProvider().search(query, {
          numResults: config?.numResults ?? 10,
          searchType: config?.searchType ?? 'web',
          country,
        })

        if (config?.autoFetch) {
          const topN = config.autoFetchTop ?? 3
          const urlsToFetch = results.slice(0, topN).map((r) => r.url)
          const fetched = await fetchPagesFn(urlsToFetch, {
            render: config.autoFetchRender,
            proxy: config.proxy,
            pipelines: config.pipelines,
          })

          const fetchedMap = new Map(fetched.map((f) => [f.url, f]))
          for (const result of results) {
            const fetchResult = fetchedMap.get(result.url)
            if (fetchResult?.success) {
              result.content = fetchResult.content
            }
          }
        }

        return { results }
      },
    })
  }
}

export interface FetchPageConfig {
  timeout?: number
  render?: boolean
  proxy?: ProxyConfig
  pipelines?: FetchPipeline[]
  concurrency?: number
  maxUrls?: number
  includeSelectors?: boolean
  maxPdfPages?: number
}

type FetchPageArgs = {
  urls: string | string[]
  includeSelectors?: boolean | null
}
type FetchPageResultItem = Omit<FetchPageResult, 'media'> & {
  mediaIndex?: number
}
interface FetchPageToolResult {
  results: FetchPageResultItem[]
  __media?: MediaPart[]
}

export function fetchPage(
  config?: FetchPageConfig,
): ToolSpec<FetchPageArgs, FetchPageToolResult, never, StateSchema> {
  const maxUrls = config?.maxUrls ?? 20

  return (
    app: AdkApp<StateSchema>,
  ): FunctionTool<FetchPageArgs, FetchPageToolResult, never, StateSchema> => {
    return app.tool({
      name: 'fetch_page',
      description: `Fetch content from one or more URLs. Works with web pages (returns markdown), PDFs (returns document for visual analysis), and images (returns image for visual analysis). Set includeSelectors=true to get CSS selectors for screenshottable elements. Max ${maxUrls} URLs per call.`,
      schema: z.object({
        urls: z
          .union([z.string(), z.array(z.string()).max(maxUrls)])
          .describe('URL or array of URLs to fetch - can include web pages, PDFs, or images'),
        includeSelectors: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            'Include CSS selectors inline for elements that can be screenshotted (marked with [@selector])',
          ),
      }),
      execute: async (
        ctx: ToolExecutionContext<FetchPageArgs, never, unknown, StateSchema>,
      ): Promise<FetchPageToolResult> => {
        const urlList = Array.isArray(ctx.args.urls) ? ctx.args.urls : [ctx.args.urls]

        const includeSelectors = ctx.args.includeSelectors ?? config?.includeSelectors ?? false

        const fetchResults = await fetchPagesFn(urlList, {
          timeout: config?.timeout ?? 30000,
          render: config?.render,
          proxy: config?.proxy,
          pipelines: config?.pipelines,
          concurrency: config?.concurrency ?? 5,
          includeSelectors,
          maxPdfPages: config?.maxPdfPages,
        })

        const media: MediaPart[] = []
        const results: FetchPageResultItem[] = fetchResults.map((result) => {
          const { media: resultMedia, ...rest } = result

          if (!resultMedia) {
            return rest
          }

          const mediaPart: MediaPart =
            resultMedia.type === 'document'
              ? {
                  type: 'document',
                  source: {
                    type: 'base64',
                    mimeType: resultMedia.mimeType,
                    data: resultMedia.data,
                  },
                }
              : {
                  type: 'image',
                  source: {
                    type: 'base64',
                    mimeType: resultMedia.mimeType,
                    data: resultMedia.data,
                  },
                }

          const mediaIndex = media.length
          media.push(mediaPart)

          return { ...rest, mediaIndex }
        })

        return {
          results,
          __media: media.length > 0 ? media : undefined,
        }
      },
    })
  }
}

export interface TakeScreenshotConfig {
  fullPage?: boolean
  timeout?: number
  maxWidth?: number
  maxHeight?: number
  proxy?: ProxyConfig
  concurrency?: number
  maxTargets?: number
}

type ScreenshotTarget = {
  url: string
  selector?: string | null
}

type TakeScreenshotArgs = {
  targets: ScreenshotTarget | ScreenshotTarget[]
  fullPage?: boolean | null
}

interface TakeScreenshotResultItem {
  success: boolean
  url: string
  selector?: string
  title?: string
  width?: number
  height?: number
  error?: string
}

interface TakeScreenshotToolResult {
  results: TakeScreenshotResultItem[]
  __media?: MediaPart[]
}

export function takeScreenshot(
  config?: TakeScreenshotConfig,
): ToolSpec<TakeScreenshotArgs, TakeScreenshotToolResult, never, StateSchema> {
  const maxTargets = config?.maxTargets ?? 10

  return (
    app: AdkApp<StateSchema>,
  ): FunctionTool<TakeScreenshotArgs, TakeScreenshotToolResult, never, StateSchema> => {
    return app.tool({
      name: 'take_screenshot',
      description: `Take screenshots of one or more webpages. Each target can have its own CSS selector for capturing specific elements. Max ${maxTargets} targets per call.`,
      schema: z.object({
        targets: z
          .union([
            z.object({
              url: z.string().describe('The URL of the page to screenshot'),
              selector: z
                .string()
                .nullable()
                .optional()
                .describe(
                  'Optional CSS selector to capture a specific element instead of the full page',
                ),
            }),
            z
              .array(
                z.object({
                  url: z.string().describe('The URL of the page to screenshot'),
                  selector: z
                    .string()
                    .nullable()
                    .optional()
                    .describe('Optional CSS selector to capture a specific element'),
                }),
              )
              .max(maxTargets),
          ])
          .describe('Single target or array of targets to screenshot'),
        fullPage: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            'Whether to capture the full scrollable page (default: true) or just the viewport. Applies to all targets without a selector.',
          ),
      }),
      execute: async (
        ctx: ToolExecutionContext<TakeScreenshotArgs, never, unknown, StateSchema>,
      ): Promise<TakeScreenshotToolResult> => {
        const targetList = Array.isArray(ctx.args.targets) ? ctx.args.targets : [ctx.args.targets]

        const screenshotPromises = targetList.map((target) =>
          screenshotPage(target.url, {
            fullPage: target.selector ? false : (ctx.args.fullPage ?? config?.fullPage ?? true),
            selector: target.selector ?? undefined,
            timeout: config?.timeout ?? 30000,
            maxWidth: config?.maxWidth,
            maxHeight: config?.maxHeight,
            proxy: config?.proxy,
          }),
        )

        const concurrency = config?.concurrency ?? 3
        const screenshotResults: Awaited<ReturnType<typeof screenshotPage>>[] = []
        for (let i = 0; i < screenshotPromises.length; i += concurrency) {
          const batch = screenshotPromises.slice(i, i + concurrency)
          const batchResults = await Promise.all(batch)
          screenshotResults.push(...batchResults)
        }

        const media: MediaPart[] = []
        const results = screenshotResults.map((result, idx) => {
          const target = targetList[idx]
          if (result.success && result.image) {
            media.push({
              type: 'image',
              source: {
                type: 'base64',
                mimeType: result.image.mimeType,
                data: result.image.data,
              },
            })
            return {
              success: true,
              url: result.url,
              selector: target.selector ?? undefined,
              title: result.title,
              width: result.image.width,
              height: result.image.height,
            }
          }
          return {
            success: false,
            url: result.url,
            selector: target.selector ?? undefined,
            error: result.error ?? 'Failed to capture screenshot',
          }
        })

        return {
          results,
          __media: media.length > 0 ? media : undefined,
        }
      },
    })
  }
}
