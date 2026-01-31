/**
 * Web Search Research Assistant
 *
 * A research assistant with web search and page fetching capabilities.
 * Uses Serper API for search (requires SERPER_API_KEY).
 *
 * Run: npx tsx examples/webSearch.ts
 */

import {
  agent,
  loop,
  openai,
  injectSystemMessage,
  includeHistory,
  webSearch,
  fetchPage,
  linkedInPipeline,
  type LoopContext,
} from '../src';
import { cli } from '../src/cli';

const researcher = agent({
  name: 'researcher',
  model: openai('gpt-5-mini'),
  context: [
    injectSystemMessage(`You are a helpful research assistant with access to web search.

Your capabilities:
- Search the web for current, accurate information
- Fetch full page content when you need more details
- Fetch LinkedIn profiles and company pages with full details
- Synthesize information from multiple sources

Guidelines:
- Always cite your sources with URLs
- Use web_search to find relevant pages
- Use fetch_page to get full content when snippets aren't enough
- For LinkedIn URLs, fetch_page will return complete profile/company information
- Be thorough but concise in your responses`),
    includeHistory(),
  ],
  tools: [
    webSearch({
      numResults: 10,
      searchType: 'web',
      country: 'GB',
    }),
    fetchPage({
      extractMode: 'markdown',
      render: true,
      pipelines: [linkedInPipeline()],
    }),
  ],
});

const chat = loop({
  name: 'research_chat',
  runnable: researcher,
  maxIterations: 100,
  yields: true,
  while: (ctx: LoopContext) => true,
});

cli(chat);
