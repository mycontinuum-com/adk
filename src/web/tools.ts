import { z } from 'zod';
import { tool } from '../core/tools';
import { SerperProvider } from './serper';
import { fetchPage as fetchPageFn, fetchPages } from './fetch';
import type {
  SearchProvider,
  SearchResult,
  FetchPageResult,
  ProxyConfig,
  FetchPipeline,
} from './types';

export interface WebSearchConfig {
  numResults?: number;
  searchType?: 'web' | 'news' | 'images';
  country?: string;
  autoFetch?: boolean;
  autoFetchTop?: number;
  autoFetchRender?: boolean;
  provider?: SearchProvider;
  allowCountryOverride?: boolean;
  proxy?: ProxyConfig;
  pipelines?: FetchPipeline[];
}

export function webSearch(config?: WebSearchConfig) {
  const provider = config?.provider ?? new SerperProvider();

  const allowCountry = config?.allowCountryOverride ?? true;

  const baseSchema = z.object({
    query: z.string().describe('The search query'),
  });

  const schemaWithCountry = baseSchema.extend({
    country: z
      .string()
      .nullable()
      .optional()
      .describe('Country code for localized results (e.g. US, GB)'),
  });

  const schema = allowCountry ? schemaWithCountry : baseSchema;

  return tool({
    name: 'web_search',
    description:
      'Search the web for information. Returns search results with titles, URLs, and snippets.',
    schema,
    execute: async (ctx): Promise<{ results: SearchResult[] }> => {
      const args = ctx.args as { query: string; country?: string | null };
      const country = args.country || config?.country;

      const results = await provider.search(args.query, {
        numResults: config?.numResults ?? 10,
        searchType: config?.searchType ?? 'web',
        country,
      });

      if (config?.autoFetch) {
        const topN = config.autoFetchTop ?? 3;
        const urlsToFetch = results.slice(0, topN).map((r) => r.url);
        const fetched = await fetchPages(urlsToFetch, {
          render: config.autoFetchRender,
          proxy: config.proxy,
          pipelines: config.pipelines,
        });

        const fetchedMap = new Map(fetched.map((f) => [f.url, f]));
        for (const result of results) {
          const fetchResult = fetchedMap.get(result.url);
          if (fetchResult?.success) {
            result.content = fetchResult.content;
          }
        }
      }

      return { results };
    },
  });
}

export interface FetchPageConfig {
  extractMode?: 'markdown' | 'text' | 'readability';
  timeout?: number;
  render?: boolean;
  proxy?: ProxyConfig;
  pipelines?: FetchPipeline[];
}

export function fetchPage(config?: FetchPageConfig) {
  return tool({
    name: 'fetch_page',
    description:
      'Fetch and extract content from a URL. Returns the page title and content in markdown format.',
    schema: z.object({
      url: z
        .string()
        .describe('The URL to fetch (must be a valid HTTP/HTTPS URL)'),
    }),
    execute: async (ctx): Promise<FetchPageResult> => {
      return fetchPageFn(ctx.args.url, {
        extractMode: config?.extractMode ?? 'markdown',
        timeout: config?.timeout ?? 30000,
        render: config?.render,
        proxy: config?.proxy,
        pipelines: config?.pipelines,
      });
    },
  });
}
