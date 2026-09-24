import type { ModelUsage } from '../types'

import { summarizeModelUsage } from '../core/runner'
import {
  calculateCost,
  calculateSessionCost,
  configurePricing,
  formatCost,
  getPricing,
  loadPricing,
  parsePricingCatalog,
  usageCost,
} from './pricing'

const REGISTRY = {
  sample_spec: { input_cost_per_token: 0, litellm_provider: 'one of https://docs.litellm.ai' },
  'gpt-4o': {
    litellm_provider: 'openai',
    input_cost_per_token: 2.5e-6,
    cache_read_input_token_cost: 1.25e-6,
    output_cost_per_token: 1e-5,
  },
  'gpt-5.6': {
    litellm_provider: 'openai',
    input_cost_per_token: 4e-6,
    cache_read_input_token_cost: 4e-7,
    cache_creation_input_token_cost: 5e-6,
    output_cost_per_token: 2e-5,
    input_cost_per_token_above_272k_tokens: 8e-6,
    output_cost_per_token_above_272k_tokens: 3e-5,
    input_cost_per_token_priority: 8e-6,
  },
  'gpt-realtime-1.5': {
    litellm_provider: 'openai',
    input_cost_per_token: 4e-6,
    cache_read_input_token_cost: 4e-7,
    output_cost_per_token: 1.6e-5,
    input_cost_per_audio_token: 3.2e-5,
    cache_read_input_audio_token_cost: 4e-7,
    output_cost_per_audio_token: 6.4e-5,
  },
  'gpt-4o-mini': {
    litellm_provider: 'openai',
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 6e-7,
  },
  'gpt-live-1': {
    litellm_provider: 'openai',
    input_cost_per_second: 0.000833333333333,
    mode: 'realtime',
  },
  'gemini/gemini-2.5-pro': {
    litellm_provider: 'gemini',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
  },
  'gemini-2.5-pro': {
    litellm_provider: 'vertex_ai-language-models',
    input_cost_per_token: 9e-6,
    output_cost_per_token: 9e-5,
  },
  'claude-opus-5-5': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 4e-6,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 5e-6,
    output_cost_per_token: 2e-5,
  },
  'anthropic.claude-haiku-9': {
    litellm_provider: 'bedrock',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
  },
}

const catalog = parsePricingCatalog(REGISTRY)

function cost(usage: ModelUsage) {
  return calculateCost(usage, catalog)
}

describe('calculateCost', () => {
  it('prices uncached and cached input separately from output', () => {
    expect(
      cost({
        provider: 'openai',
        modelName: 'gpt-4o',
        inputTokens: 1000,
        cachedTokens: 600,
        outputTokens: 500,
      }),
    ).toEqual({
      inputCost: 400 * 2.5e-6 + 600 * 1.25e-6,
      outputCost: 500 * 1e-5,
      totalCost: 400 * 2.5e-6 + 600 * 1.25e-6 + 500 * 1e-5,
      currency: 'USD',
    })
  })

  it('bills cache writes at the published write rate, or the input rate when none is published', () => {
    const usage = { inputTokens: 2000, cacheWriteTokens: 1000, outputTokens: 0 }
    expect(cost({ ...usage, provider: 'openai', modelName: 'gpt-5.6' })?.inputCost).toBeCloseTo(
      1000 * 4e-6 + 1000 * 5e-6,
      12,
    )
    expect(cost({ ...usage, provider: 'openai', modelName: 'gpt-4o' })?.inputCost).toBeCloseTo(
      2000 * 2.5e-6,
      12,
    )
  })

  it('switches to the long-context tier once input exceeds its threshold', () => {
    const usage = { provider: 'openai', modelName: 'gpt-5.6', outputTokens: 1000 } satisfies Omit<
      ModelUsage,
      'inputTokens'
    >
    expect(cost({ ...usage, inputTokens: 272_000 })?.totalCost).toBeCloseTo(
      272_000 * 4e-6 + 1000 * 2e-5,
      12,
    )
    expect(cost({ ...usage, inputTokens: 272_001 })?.totalCost).toBeCloseTo(
      272_001 * 8e-6 + 1000 * 3e-5,
      12,
    )
  })

  it('bills Gemini thinking tokens on top of output, but not OpenAI reasoning already in output', () => {
    expect(
      cost({
        provider: 'gemini',
        modelName: 'gemini-2.5-pro',
        inputTokens: 1000,
        reasoningTokens: 2000,
        outputTokens: 500,
      })?.outputCost,
    ).toBeCloseTo(2500 * 1e-5, 12)
    expect(
      cost({
        provider: 'openai',
        modelName: 'gpt-4o',
        inputTokens: 0,
        reasoningTokens: 400,
        outputTokens: 500,
      })?.outputCost,
    ).toBeCloseTo(500 * 1e-5, 12)
  })

  it('bills realtime audio tokens at audio rates without also billing them as text', () => {
    // 1000 input = 200 text (all cached) + 800 audio (300 cached); 600 output = 100 text + 500 audio.
    const estimate = cost({
      provider: 'openai',
      modelName: 'gpt-realtime-1.5',
      inputTokens: 1000,
      audioInputTokens: 800,
      cachedTokens: 500,
      audioCachedTokens: 300,
      outputTokens: 600,
      audioOutputTokens: 500,
    })
    expect(estimate?.inputCost).toBeCloseTo(200 * 4e-7 + 500 * 3.2e-5 + 300 * 4e-7, 12)
    expect(estimate?.outputCost).toBeCloseTo(100 * 1.6e-5 + 500 * 6.4e-5, 12)
  })

  it('omits the estimate when billed tokens have no published rate', () => {
    expect(
      cost({
        provider: 'openai',
        modelName: 'gpt-4o',
        inputTokens: 100,
        audioInputTokens: 50,
        outputTokens: 10,
      }),
    ).toBeNull()
  })

  it('omits the estimate for unknown models, routers, missing names and an absent catalog', () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    expect(cost({ ...usage, provider: 'openai', modelName: 'unknown-model' })).toBeNull()
    expect(cost({ ...usage, provider: 'eurouter', modelName: 'gpt-4o' })).toBeNull()
    expect(cost(usage)).toBeNull()
    expect(calculateCost({ ...usage, modelName: 'gpt-4o' }, undefined)).toBeNull()
  })
})

describe('calculateSessionCost', () => {
  it('prices connected seconds at the registry per-second rate, including dated ids', () => {
    expect(calculateSessionCost('gpt-live-1', 90, catalog)).toBe(0.075)
    expect(calculateSessionCost('gpt-live-1-2026-09-01', 120, catalog)).toBe(0.1)
  })

  it('is null without a per-second rate, a catalog or a valid duration', () => {
    expect(calculateSessionCost('gpt-live-10', 90, catalog)).toBeNull()
    expect(calculateSessionCost('gpt-4o', 90, catalog)).toBeNull()
    expect(calculateSessionCost('gpt-live-1', 90, undefined)).toBeNull()
    expect(calculateSessionCost('gpt-live-1', -1, catalog)).toBeNull()
  })
})

describe('usageCost', () => {
  it('adds registry-priced and provider-reported charges from different models', () => {
    const usage = summarizeModelUsage(
      [
        { provider: 'openai', modelName: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 },
        {
          provider: 'chat-completions',
          modelName: 'self-hosted',
          inputTokens: 10,
          outputTokens: 10,
          reportedCostUSD: 0.02,
        },
      ],
      catalog,
    )
    expect(usage?.cost).toBeUndefined()
    expect(usage?.reportedCostUSD).toBeUndefined()
    const account = usageCost(usage)
    expect(account.basis).toBe('reported')
    expect(account.basis !== 'unavailable' && account.totalCost).toBeCloseTo(0.17, 12)
  })

  it('is unavailable when a call has unknown usage, and zero with no calls', () => {
    const known: ModelUsage = {
      provider: 'openai',
      modelName: 'gpt-4o-mini',
      inputTokens: 1,
      outputTokens: 0,
    }
    expect(usageCost(summarizeModelUsage([known, undefined], catalog))).toEqual({
      basis: 'unavailable',
    })
    expect(usageCost(summarizeModelUsage([undefined], catalog))).toEqual({ basis: 'unavailable' })
    expect(usageCost(undefined)).toEqual({ basis: 'reported', totalCost: 0, currency: 'USD' })
  })
})

describe('getPricing', () => {
  it('resolves dated snapshots and Vertex deployment ids to their base model', () => {
    expect(getPricing(catalog, { provider: 'openai', modelName: 'gpt-4o-2024-11-20' })?.key).toBe(
      'gpt-4o',
    )
    expect(
      getPricing(catalog, { provider: 'claude', modelName: 'claude-opus-5-5@20260922' })?.key,
    ).toBe('claude-opus-5-5')
  })

  it("prefers the provider's own registry namespace", () => {
    expect(getPricing(catalog, { provider: 'gemini', modelName: 'gemini-2.5-pro' })?.key).toBe(
      'gemini/gemini-2.5-pro',
    )
    expect(getPricing(catalog, { provider: 'openai', modelName: 'gemini-2.5-pro' })).toBeUndefined()
  })

  it('searches first-party namespaces when the provider is unknown, never resellers', () => {
    expect(getPricing(catalog, { modelName: 'claude-opus-5-5' })?.key).toBe('claude-opus-5-5')
    expect(getPricing(catalog, { modelName: 'anthropic.claude-haiku-9' })).toBeUndefined()
  })
})

describe('parsePricingCatalog', () => {
  it('rejects a registry without token prices', () => {
    expect(() => parsePricingCatalog([])).toThrow('not a JSON object')
    expect(() => parsePricingCatalog({ sample_spec: {} })).toThrow('no token prices')
  })
})

describe('loadPricing', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => Response.json(REGISTRY))
    configurePricing({ url: 'https://prices.test/registry.json', ttlMs: 1000, retryAfterMs: 5000 })
  })

  afterEach(() => {
    configurePricing(false)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetches the registry once for concurrent callers', async () => {
    const [first, second] = await Promise.all([loadPricing(), loadPricing()])
    expect(first).toBe(second)
    expect(getPricing(first!, { provider: 'openai', modelName: 'gpt-4o' })?.input).toBe(2.5e-6)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://prices.test/registry.json')
  })

  it('serves the stale catalog while refreshing it in the background', async () => {
    const stale = await loadPricing()
    vi.advanceTimersByTime(1001)
    fetchMock.mockImplementation(async () =>
      Response.json({
        ...REGISTRY,
        'gpt-9': { litellm_provider: 'openai', input_cost_per_token: 1 },
      }),
    )
    expect(await loadPricing()).toBe(stale)
    await vi.waitFor(async () => {
      const fresh = await loadPricing()
      expect(getPricing(fresh!, { provider: 'openai', modelName: 'gpt-9' })).toBeDefined()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns no catalog when the registry fails, and backs off before retrying', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    expect(await loadPricing()).toBeUndefined()
    expect(await loadPricing()).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('adk.pricing.unavailable', {
      url: 'https://prices.test/registry.json',
      error: 'HTTP 503',
    })

    vi.advanceTimersByTime(5001)
    fetchMock.mockImplementation(async () => Response.json(REGISTRY))
    expect(await loadPricing()).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops waiting for a first fetch after maxWaitMs and keeps it for later calls', async () => {
    let respond = (_: Response) => {}
    fetchMock.mockImplementation(() => new Promise((resolve) => (respond = resolve)))

    const waiting = loadPricing({ maxWaitMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await waiting).toBeUndefined()

    respond(Response.json(REGISTRY))
    await vi.waitFor(async () => expect(await loadPricing()).toBeDefined())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not fetch when pricing is disabled', async () => {
    configurePricing(false)
    expect(await loadPricing()).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('formatCost', () => {
  it('formats small costs with 6 decimal places', () => {
    expect(formatCost(0.0005)).toBe('$0.000500')
    expect(formatCost(0.005)).toBe('$0.005000')
  })

  it('formats medium costs with 4 decimal places', () => {
    expect(formatCost(0.05)).toBe('$0.0500')
    expect(formatCost(0.5)).toBe('$0.5000')
  })

  it('formats large costs with 2 decimal places', () => {
    expect(formatCost(1.234)).toBe('$1.23')
    expect(formatCost(12.34)).toBe('$12.34')
    expect(formatCost(100)).toBe('$100.00')
    expect(formatCost(1234.5)).toBe('$1234.50')
  })
})
