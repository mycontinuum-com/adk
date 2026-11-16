import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { adk } from '../api/app'
import { createVoyageEmbedder, voyage } from '../memory/providers/voyage'
import { openai } from '../providers/models'
import { OpenAIAdapter } from '../providers/openai'
import { PRICE_LIST } from '../providers/price-list.gen'
import { configurePricing, loadedPricing } from '../providers/pricing'
import { useTestPricing } from '../test-support/pricing-registry'
import { UsageReportingAdapter } from '../test-support/usage-adapter'
import { configureUsageLog } from './usage-log'

let lines: Array<Record<string, unknown>> = []

beforeEach(() => {
  lines = []
  configureUsageLog({ write: (line) => lines.push(JSON.parse(line)) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  configureUsageLog(false)
  configurePricing(false)
})

/** Answers OpenAI's EU endpoint with one completed response that reports `serviceTier`. */
function answerOnEuEndpoint(serviceTier: string) {
  const completed = {
    type: 'response.completed',
    sequence_number: 1,
    response: {
      id: 'r',
      status: 'completed',
      service_tier: serviceTier,
      output: [],
      usage: { input_tokens: 200_000, output_tokens: 100_000 },
    },
  }
  const requests: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input))
    const created = {
      type: 'response.created',
      sequence_number: 0,
      response: { id: 'r', status: 'in_progress', output: [] },
    }
    return new Response(
      `data: ${JSON.stringify(created)}\n\ndata: ${JSON.stringify(completed)}\n\n`,
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    )
  })
  return requests
}

function lunaOnEuEndpoint() {
  const adapter = new OpenAIAdapter([
    { type: 'openai', apiKey: 'test', baseUrl: 'https://eu.api.openai.com/v1' },
  ])
  const app = adk({ adapters: { openai: adapter } })
  const agent = app.agent({
    name: 'coder',
    model: openai('gpt-6-luna'),
    context: [app.context.history()],
  })
  return { app, agent }
}

function priced() {
  return lines.map(
    ({
      operation,
      provider,
      model,
      endpointRegion,
      serviceTier,
      inputTokens,
      outputTokens,
      costUsd,
      costBasis,
    }) => ({
      operation,
      provider,
      model,
      endpointRegion,
      serviceTier,
      inputTokens,
      outputTokens,
      costUsd,
      costBasis,
    }),
  )
}

test.each([
  {
    billed: 'default',
    line: 'a standard-priced line with the EU uplift and no tier',
    serviceTier: undefined,
    cost: { costUsd: expect.closeTo(0.077, 12), costBasis: 'reported' },
  },
  {
    billed: 'priority',
    line: 'a line priced at priority rates with the EU uplift',
    serviceTier: 'priority',
    cost: { costUsd: expect.closeTo(0.154, 12), costBasis: 'reported' },
  },
  {
    billed: 'fast',
    line: 'an unpriced line naming the tier, which the price list has no rates for',
    serviceTier: 'fast',
    cost: { costUsd: undefined, costBasis: 'unavailable' },
  },
])(
  'a call to OpenAI’s EU endpoint billed at the $billed tier writes $line',
  { meta: { fixture: 'agent-kit.tier-region-price' } },
  async ({ billed, serviceTier, cost }) => {
    await useTestPricing()
    const requests = answerOnEuEndpoint(billed)
    const { app, agent } = lunaOnEuEndpoint()

    await app.run(agent, { input: 'Hello' })

    expect(requests).toEqual(['https://eu.api.openai.com/v1/responses'])
    expect(priced()).toEqual([
      {
        operation: 'coder',
        provider: 'openai',
        model: 'gpt-6-luna',
        endpointRegion: 'eu',
        serviceTier,
        inputTokens: 200_000,
        outputTokens: 100_000,
        ...cost,
      },
    ])
  },
)

test(
  'a Voyage embedding request writes a priced line',
  { meta: { fixture: 'agent-kit.tier-region-price' } },
  async () => {
    await useTestPricing()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
            model: 'voyage-3.5',
            usage: { total_tokens: 1_000_000 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )
    const embedder = createVoyageEmbedder(voyage('voyage-3.5', { dimensions: 2, apiKey: 'test' }))

    const result = await embedder.embed(['a request to remember'])

    expect(result.usage).toEqual({ totalTokens: 1_000_000 })
    expect(priced()).toEqual([
      {
        operation: 'memory.embed',
        provider: 'voyage',
        model: 'voyage-3.5',
        endpointRegion: undefined,
        serviceTier: undefined,
        inputTokens: 1_000_000,
        outputTokens: 0,
        costUsd: expect.closeTo(0.06, 12),
        costBasis: 'reported',
      },
    ])
  },
)

test(
  'each failed Voyage attempt writes a line: a refused one spent nothing, a lost one its estimated input',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    await useTestPricing()
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{"detail":"rate limited"}', { status: 429 }))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              object: 'list',
              data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
              model: 'voyage-3.5',
              usage: { total_tokens: 1_000_000 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
    )
    const embedder = createVoyageEmbedder(
      voyage('voyage-3.5', {
        dimensions: 2,
        apiKey: 'test',
        retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
      }),
    )

    await embedder.embed(['a request to remember'])

    expect(
      lines.map(({ model, inputTokens, outputTokens, usageBasis, costUsd, costBasis }) => ({
        model,
        inputTokens,
        outputTokens,
        usageBasis,
        costUsd,
        costBasis,
      })),
    ).toEqual([
      {
        model: 'voyage-3.5',
        inputTokens: 0,
        outputTokens: 0,
        usageBasis: 'reported',
        costUsd: 0,
        costBasis: 'reported',
      },
      {
        model: 'voyage-3.5',
        inputTokens: 6,
        outputTokens: 0,
        usageBasis: 'estimated',
        costUsd: expect.closeTo(6 * 0.06e-6, 15),
        costBasis: 'estimated',
      },
      {
        model: 'voyage-3.5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        usageBasis: 'reported',
        costUsd: expect.closeTo(0.06, 12),
        costBasis: 'reported',
      },
    ])
  },
)

test(
  'a second copy of the ADK, as each CommonJS entry bundles, writes to the log and prices from the list the first configured',
  { meta: { fixture: 'agent-kit.usage-line' } },
  async () => {
    await useTestPricing()
    vi.resetModules()
    const copy = await import('./usage-log')
    const embedding = {
      operation: 'memory.embed',
      durationMs: 5,
      usage: {
        provider: 'voyage',
        modelName: 'voyage-3.5',
        inputTokens: 1_000_000,
        outputTokens: 0,
      },
    } as const

    copy.logTokenUsage(embedding)
    configureUsageLog(false)
    copy.logTokenUsage(embedding)

    expect(priced()).toEqual([
      {
        operation: 'memory.embed',
        provider: 'voyage',
        model: 'voyage-3.5',
        endpointRegion: undefined,
        serviceTier: undefined,
        inputTokens: 1_000_000,
        outputTokens: 0,
        costUsd: expect.closeTo(0.06, 12),
        costBasis: 'reported',
      },
    ])
  },
)

test(
  "a process's first model call is priced from the shipped price list, with no request",
  { meta: { fixture: 'agent-kit.shipped-price-list' } },
  async () => {
    configurePricing({})
    const fetchSpy = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchSpy)
    const app = adk({ adapters: { openai: new UsageReportingAdapter() } })
    const agent = app.agent({
      name: 'cold',
      model: openai('gpt-4o-mini'),
      context: [app.context.history()],
    })

    await app.run(agent, { input: 'Hello' })

    expect(
      lines.map(({ inputTokens, costUsd, costBasis }) => ({ inputTokens, costUsd, costBasis })),
    ).toEqual([
      {
        inputTokens: 1_000_000,
        costUsd: expect.closeTo(
          1_000_000 * Number(PRICE_LIST['gpt-4o-mini'].input_cost_per_token),
          12,
        ),
        costBasis: 'reported',
      },
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  },
)

test(
  'a configured live price map loads for a host that only decides, and prices its later calls',
  { meta: { fixture: 'agent-kit.shipped-price-list' } },
  async () => {
    // The live map prices the decisions' model at twice the shipped rate.
    const registry = { 'gpt-4o-mini': { litellm_provider: 'openai', input_cost_per_token: 3e-7 } }
    configurePricing({
      url: `data:application/json,${encodeURIComponent(JSON.stringify(registry))}`,
    })
    const adapter = new UsageReportingAdapter({
      decisions: { urgent: { type: 'predicate', probability: 0.1 } },
    })
    const app = adk({ adapters: { openai: adapter }, defaultModel: openai('gpt-4o-mini') })
    const questions = { urgent: { type: 'predicate', instructions: 'Is it urgent?' } } as const

    await app.decide('Is this urgent?', { questions })
    await vi.waitFor(() => expect(loadedPricing()?.get('gpt-4o-mini')?.pricing.input).toBe(3e-7))
    await app.decide('Is this urgent?', { questions })

    expect(lines.map(({ costUsd, costBasis }) => ({ costUsd, costBasis }))).toEqual([
      {
        costUsd: expect.closeTo(
          1_000_000 * Number(PRICE_LIST['gpt-4o-mini'].input_cost_per_token),
          12,
        ),
        costBasis: 'reported',
      },
      { costUsd: expect.closeTo(0.3, 12), costBasis: 'reported' },
    ])
  },
)
