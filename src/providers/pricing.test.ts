import type { ModelUsage } from '../types'

import { summarizeModelUsage } from '../core/runner'
import { getPricing, calculateCost, formatCost, usageCost } from './pricing'

describe('pricing', () => {
  describe('getPricing', () => {
    it('returns exact match for known model', () => {
      const pricing = getPricing('gpt-4o')
      expect(pricing).toEqual({
        inputPerMillion: 2.5,
        cachedInputPerMillion: 1.25,
        outputPerMillion: 10.0,
      })
    })

    it('returns prefix match for versioned model', () => {
      const pricing = getPricing('gpt-4o-2024-11-20')
      expect(pricing).toEqual({
        inputPerMillion: 2.5,
        cachedInputPerMillion: 1.25,
        outputPerMillion: 10.0,
      })
    })

    it('returns null for unknown model', () => {
      const pricing = getPricing('unknown-model-xyz')
      expect(pricing).toBeNull()
    })

    it('matches longer prefix first', () => {
      const pricing = getPricing('gpt-4o-mini-2024-11-20')
      expect(pricing).toEqual({
        inputPerMillion: 0.15,
        cachedInputPerMillion: 0.075,
        outputPerMillion: 0.6,
      })
    })

    it('returns pricing with reasoning tokens for gemini-2.5-pro', () => {
      const pricing = getPricing('gemini-2.5-pro')
      expect(pricing).toEqual({
        inputPerMillion: 1.25,
        cachedInputPerMillion: 0.125,
        reasoningPerMillion: 10.0,
        outputPerMillion: 10.0,
        highTier: {
          aboveTokens: 200_000,
          inputPerMillion: 2.5,
          cachedInputPerMillion: 0.25,
          reasoningPerMillion: 15.0,
          outputPerMillion: 15.0,
        },
      })
    })
  })

  describe('calculateCost', () => {
    it('calculates cost for simple usage', () => {
      const usage: ModelUsage = {
        modelName: 'gpt-4o',
        inputTokens: 1000,
        outputTokens: 500,
      }
      const cost = calculateCost(usage)
      expect(cost).not.toBeNull()
      expect(cost!.inputCost).toBeCloseTo(0.0025, 6)
      expect(cost!.outputCost).toBeCloseTo(0.005, 6)
      expect(cost!.totalCost).toBeCloseTo(0.0025 + 0.005, 6)
      expect(cost!.currency).toBe('USD')
    })

    it('accounts for cached tokens', () => {
      const usage: ModelUsage = {
        modelName: 'gpt-4o',
        inputTokens: 1000,
        cachedTokens: 600,
        outputTokens: 500,
      }
      const cost = calculateCost(usage)
      const expectedUncachedInput = (400 / 1_000_000) * 2.5
      const expectedCachedInput = (600 / 1_000_000) * 1.25
      const expectedOutput = (500 / 1_000_000) * 10.0
      expect(cost).not.toBeNull()
      expect(cost!.inputCost).toBeCloseTo(expectedUncachedInput + expectedCachedInput, 6)
      expect(cost!.outputCost).toBeCloseTo(expectedOutput, 6)
      expect(cost!.totalCost).toBeCloseTo(
        expectedUncachedInput + expectedCachedInput + expectedOutput,
        6,
      )
    })

    it('accounts for cache-write tokens at the ordinary rate when no write rate is configured', () => {
      const usage: ModelUsage = {
        modelName: 'gpt-4o',
        inputTokens: 1000,
        cacheWriteTokens: 600,
        outputTokens: 500,
      }
      const cost = calculateCost(usage)
      const expectedOrdinaryInput = (400 / 1_000_000) * 2.5
      const expectedCacheWriteInput = (600 / 1_000_000) * 2.5
      const expectedOutput = (500 / 1_000_000) * 10.0
      expect(cost).not.toBeNull()
      expect(cost!.inputCost).toBeCloseTo(expectedOrdinaryInput + expectedCacheWriteInput, 6)
      expect(cost!.outputCost).toBeCloseTo(expectedOutput, 6)
    })

    it('accounts for GPT-5.6 cache-write tokens at the 1.25x write rate', () => {
      const usage: ModelUsage = {
        modelName: 'gpt-5.6-luna',
        inputTokens: 2000,
        cacheWriteTokens: 1000,
        outputTokens: 1000,
      }
      const cost = calculateCost(usage)
      const expectedOrdinaryInput = (1000 / 1_000_000) * 0.2
      const expectedCacheWriteInput = (1000 / 1_000_000) * 0.25
      const expectedOutput = (1000 / 1_000_000) * 1.2
      expect(cost).not.toBeNull()
      expect(cost!.inputCost).toBeCloseTo(expectedOrdinaryInput + expectedCacheWriteInput, 6)
      expect(cost!.outputCost).toBeCloseTo(expectedOutput, 6)
    })

    it('accounts for reasoning tokens', () => {
      const usage: ModelUsage = {
        modelName: 'gemini-2.5-pro',
        inputTokens: 1000,
        reasoningTokens: 2000,
        outputTokens: 500,
      }
      const cost = calculateCost(usage)
      const expectedInput = (1000 / 1_000_000) * 1.25
      const expectedReasoning = (2000 / 1_000_000) * 10.0
      const expectedOutput = (500 / 1_000_000) * 10.0
      expect(cost).not.toBeNull()
      expect(cost!.inputCost).toBeCloseTo(expectedInput + expectedReasoning, 6)
      expect(cost!.outputCost).toBeCloseTo(expectedOutput, 6)
      expect(cost!.totalCost).toBeCloseTo(expectedInput + expectedReasoning + expectedOutput, 6)
    })

    it('returns null for unknown model', () => {
      const usage: ModelUsage = {
        modelName: 'unknown-model',
        inputTokens: 1000,
        outputTokens: 500,
      }
      const cost = calculateCost(usage)
      expect(cost).toBeNull()
    })

    it('returns null when modelName is missing', () => {
      const usage: ModelUsage = {
        inputTokens: 1000,
        outputTokens: 500,
      }
      const cost = calculateCost(usage)
      expect(cost).toBeNull()
    })
  })

  describe('Realtime audio usage', () => {
    it('prices audio and cached audio inside the input total once, at audio rates', () => {
      const cost = calculateCost({
        modelName: 'gpt-realtime',
        inputTokens: 1_100_000,
        cachedTokens: 500_000,
        audioInputTokens: 1_000_000,
        audioCachedTokens: 500_000,
        outputTokens: 1_000_000,
        audioOutputTokens: 1_000_000,
      })
      // Text $4/M on 100k, audio $32/M on 500k, cached audio $0.40/M on 500k, audio out $64/M on 1M.
      expect(cost!.inputCost).toBeCloseTo(0.4 + 16 + 0.2, 10)
      expect(cost!.outputCost).toBeCloseTo(64, 10)
    })
  })

  describe('usageCost', () => {
    it('adds table-priced and provider-reported charges from different models', () => {
      const usage = summarizeModelUsage([
        { provider: 'openai', modelName: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 },
        {
          provider: 'chat-completions',
          modelName: 'self-hosted',
          inputTokens: 10,
          outputTokens: 10,
          reportedCostUSD: 0.02,
        },
      ])
      expect(usage?.cost).toBeUndefined()
      expect(usage?.reportedCostUSD).toBeUndefined()
      const cost = usageCost(usage)
      expect(cost.basis).toBe('reported')
      expect(cost.basis !== 'unavailable' && cost.totalCost).toBeCloseTo(0.17, 12)
    })

    it('is unavailable when a call has unknown usage, and zero with no calls', () => {
      expect(
        usageCost(
          summarizeModelUsage([
            { provider: 'openai', modelName: 'gpt-4o-mini', inputTokens: 1, outputTokens: 0 },
            undefined,
          ]),
        ),
      ).toEqual({ basis: 'unavailable' })
      expect(usageCost(summarizeModelUsage([undefined]))).toEqual({ basis: 'unavailable' })
      expect(usageCost(undefined)).toEqual({ basis: 'reported', totalCost: 0, currency: 'USD' })
    })
  })

  describe('formatCost', () => {
    it('formats sub-cent costs with 6 decimal places', () => {
      expect(formatCost(0.0005)).toBe('$0.000500')
      expect(formatCost(0.005)).toBe('$0.005000')
    })

    it('formats cent-level costs with 4 decimal places', () => {
      expect(formatCost(0.05)).toBe('$0.0500')
      expect(formatCost(0.5)).toBe('$0.5000')
    })

    it('formats dollar-level costs with 2 decimal places', () => {
      expect(formatCost(1.234)).toBe('$1.23')
      expect(formatCost(12.34)).toBe('$12.34')
      expect(formatCost(100)).toBe('$100.00')
      expect(formatCost(1234.5)).toBe('$1234.50')
    })
  })
})
