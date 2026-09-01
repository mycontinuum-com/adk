/**
 * Web Search Research Assistant
 *
 * A research assistant with web search and page fetching capabilities. Uses Serper API for search
 * (requires SERPER_API_KEY).
 *
 * Run: npx tsx examples/webSearch.ts
 */

import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk()

const researcher = app.agent({
  name: 'researcher',
  model: openai('gpt-5-mini', {
    reasoning: { effort: 'medium', summary: 'detailed' },
  }),
  context: [
    app.context.system(`You are a helpful research assistant with access to web search.

Your capabilities:
- Search the web for current, accurate information
- Fetch full page content when you need more details
- Fetch LinkedIn profiles and company pages with full details
- Synthesize information from multiple sources

Guidelines:
- Use web_search to find relevant pages
- Use fetch_page to get full content when snippets aren't enough
- For LinkedIn URLs, fetch_page will return complete profile/company information
- Be thorough but concise in your responses`),
    app.context.history(),
  ],
  tools: [
    app.tools.webSearch({
      numResults: 10,
      searchType: 'web',
      country: 'GB',
    }),
    app.tools.fetchPage({
      render: true,
    }),
    app.tools.takeScreenshot({
      fullPage: true,
    }),
  ],
})

const chat = app.loop({
  name: 'research_chat',
  runnable: researcher,
  maxIterations: 100,
  yields: true,
  while: () => true,
})

const PROMPT = `Tell me about Anima Health`

app.cli(chat, PROMPT)
