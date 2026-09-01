import type { ModelUsage, CostEstimate } from '../types'

interface PricingTier {
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWriteInputPerMillion?: number
  reasoningPerMillion?: number
  outputPerMillion: number
  audioInputPerMillion?: number
  audioCachedInputPerMillion?: number
  audioOutputPerMillion?: number
}

export interface ModelPricing extends PricingTier {
  highTier?: PricingTier & { aboveTokens: number }
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5.6-luna': {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    cacheWriteInputPerMillion: 0.25,
    outputPerMillion: 1.2,
  },
  'gpt-5.6-terra': {
    inputPerMillion: 2.0,
    cachedInputPerMillion: 0.2,
    cacheWriteInputPerMillion: 2.5,
    outputPerMillion: 12.0,
  },
  'gpt-5.6-sol': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    cacheWriteInputPerMillion: 6.25,
    outputPerMillion: 30.0,
  },
  'gpt-5.6': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    cacheWriteInputPerMillion: 6.25,
    outputPerMillion: 30.0,
  },
  'gpt-5.2': {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14.0,
  },
  'gpt-5.1': {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10.0,
  },
  'gpt-5': {
    inputPerMillion: 1.25,
    cachedInputPerMillion: 0.125,
    outputPerMillion: 10.0,
  },
  'gpt-5-mini': {
    inputPerMillion: 0.25,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 2.0,
  },
  'gpt-5-nano': {
    inputPerMillion: 0.05,
    cachedInputPerMillion: 0.005,
    outputPerMillion: 0.4,
  },
  'gpt-4.1': {
    inputPerMillion: 2.0,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 8.0,
  },
  'gpt-4.1-mini': {
    inputPerMillion: 0.4,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 1.6,
  },
  'gpt-4.1-nano': {
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 0.4,
  },
  'gpt-4o': {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10.0,
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
  },
  'gemini-3-pro': {
    inputPerMillion: 2.0,
    cachedInputPerMillion: 0.2,
    reasoningPerMillion: 12.0,
    outputPerMillion: 12.0,
    highTier: {
      aboveTokens: 200_000,
      inputPerMillion: 4.0,
      cachedInputPerMillion: 0.4,
      reasoningPerMillion: 18.0,
      outputPerMillion: 18.0,
    },
  },
  'gemini-3-flash': {
    inputPerMillion: 0.5,
    cachedInputPerMillion: 0.05,
    reasoningPerMillion: 3.0,
    outputPerMillion: 3.0,
  },
  'gemini-2.5-pro': {
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
  },
  'gemini-2.5-flash': {
    inputPerMillion: 0.3,
    cachedInputPerMillion: 0.03,
    reasoningPerMillion: 2.5,
    outputPerMillion: 2.5,
  },
  'gemini-2.0-flash': {
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 0.4,
  },
  // --- OpenAI Realtime models ---
  'gpt-realtime-1.5': {
    inputPerMillion: 4.0,
    cachedInputPerMillion: 0.4,
    outputPerMillion: 16.0,
    audioInputPerMillion: 32.0,
    audioCachedInputPerMillion: 0.4,
    audioOutputPerMillion: 64.0,
  },
  'gpt-realtime': {
    inputPerMillion: 4.0,
    cachedInputPerMillion: 0.4,
    outputPerMillion: 16.0,
    audioInputPerMillion: 32.0,
    audioCachedInputPerMillion: 0.4,
    audioOutputPerMillion: 64.0,
  },
  'gpt-realtime-mini': {
    inputPerMillion: 0.6,
    cachedInputPerMillion: 0.06,
    outputPerMillion: 2.4,
    audioInputPerMillion: 10.0,
    audioCachedInputPerMillion: 0.3,
    audioOutputPerMillion: 20.0,
  },
  'gpt-4o-realtime': {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 2.5,
    outputPerMillion: 20.0,
    audioInputPerMillion: 40.0,
    audioCachedInputPerMillion: 2.5,
    audioOutputPerMillion: 80.0,
  },
  'gpt-4o-mini-realtime': {
    inputPerMillion: 0.6,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 2.4,
    audioInputPerMillion: 10.0,
    audioCachedInputPerMillion: 0.3,
    audioOutputPerMillion: 20.0,
  },
  // --- Gemini Realtime / Native Audio models ---
  'gemini-2.5-flash-native-audio': {
    inputPerMillion: 0.5,
    cachedInputPerMillion: 0.05,
    outputPerMillion: 2.0,
    audioInputPerMillion: 3.0,
    audioCachedInputPerMillion: 0.3,
    audioOutputPerMillion: 12.0,
  },
  'gemini-live-2.5-flash-native-audio': {
    inputPerMillion: 0.5,
    cachedInputPerMillion: 0.05,
    outputPerMillion: 2.0,
    audioInputPerMillion: 3.0,
    audioCachedInputPerMillion: 0.3,
    audioOutputPerMillion: 12.0,
  },
  'gemini-live-2.5-flash': {
    inputPerMillion: 0.5,
    cachedInputPerMillion: 0.05,
    outputPerMillion: 2.0,
  },
}

const PRICING_PREFIXES = Object.keys(MODEL_PRICING).toSorted((a, b) => b.length - a.length)

export function getPricing(modelName: string): ModelPricing | null {
  if (MODEL_PRICING[modelName]) {
    return MODEL_PRICING[modelName]
  }
  for (const prefix of PRICING_PREFIXES) {
    if (modelName.startsWith(prefix)) {
      return MODEL_PRICING[prefix]
    }
  }
  return null
}

export function calculateCost(usage: ModelUsage): CostEstimate | null {
  if (!usage.modelName) return null
  const pricing = getPricing(usage.modelName)
  if (!pricing) return null

  const tier: PricingTier =
    pricing.highTier && usage.inputTokens > pricing.highTier.aboveTokens
      ? pricing.highTier
      : pricing

  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - (usage.cachedTokens ?? 0) - (usage.cacheWriteTokens ?? 0),
  )
  const cachedInputTokens = usage.cachedTokens ?? 0
  const cacheWriteInputTokens = usage.cacheWriteTokens ?? 0
  const reasoningTokens = usage.reasoningTokens ?? 0
  const outputTokens = usage.outputTokens

  const uncachedInput = (uncachedInputTokens / 1_000_000) * tier.inputPerMillion
  const cachedInput = (cachedInputTokens / 1_000_000) * tier.cachedInputPerMillion
  const cacheWriteInput =
    (cacheWriteInputTokens / 1_000_000) * (tier.cacheWriteInputPerMillion ?? tier.inputPerMillion)
  const reasoning = (reasoningTokens / 1_000_000) * (tier.reasoningPerMillion ?? 0)
  const output = (outputTokens / 1_000_000) * tier.outputPerMillion

  // Audio tokens (realtime/voice agents)
  const audioInputTokens = usage.audioInputTokens ?? 0
  const audioCachedTokens = usage.audioCachedTokens ?? 0
  const uncachedAudioInput = Math.max(0, audioInputTokens - audioCachedTokens)
  const audioOutputTokens = usage.audioOutputTokens ?? 0

  const audioInput = (uncachedAudioInput / 1_000_000) * (tier.audioInputPerMillion ?? 0)
  const audioCached = (audioCachedTokens / 1_000_000) * (tier.audioCachedInputPerMillion ?? 0)
  const audioOutput = (audioOutputTokens / 1_000_000) * (tier.audioOutputPerMillion ?? 0)

  const totalInputCost =
    uncachedInput + cacheWriteInput + cachedInput + reasoning + audioInput + audioCached
  const totalOutputCost = output + audioOutput

  return {
    inputCost: totalInputCost,
    outputCost: totalOutputCost,
    totalCost: totalInputCost + totalOutputCost,
    currency: 'USD',
  }
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(6)}`
}
