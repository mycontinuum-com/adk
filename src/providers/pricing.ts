import type { ModelUsage } from '../types';

interface PricingTier {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  reasoningPerMillion?: number;
  outputPerMillion: number;
}

export interface ModelPricing extends PricingTier {
  highTier?: PricingTier & { aboveTokens: number };
}

const MODEL_PRICING: Record<string, ModelPricing> = {
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
    highTier: {
      aboveTokens: 200_000,
      inputPerMillion: 1.0,
      cachedInputPerMillion: 0.1,
      reasoningPerMillion: 3.0,
      outputPerMillion: 3.0,
    },
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
};

const PRICING_PREFIXES = Object.keys(MODEL_PRICING).sort(
  (a, b) => b.length - a.length,
);

export function getPricing(modelName: string): ModelPricing | null {
  if (MODEL_PRICING[modelName]) {
    return MODEL_PRICING[modelName];
  }
  for (const prefix of PRICING_PREFIXES) {
    if (modelName.startsWith(prefix)) {
      return MODEL_PRICING[prefix];
    }
  }
  return null;
}

export function calculateCost(
  usage: ModelUsage,
  modelName: string,
): number | null {
  const pricing = getPricing(modelName);
  if (!pricing) return null;

  const tier: PricingTier =
    pricing.highTier && usage.inputTokens > pricing.highTier.aboveTokens
      ? pricing.highTier
      : pricing;

  const uncachedInputTokens = usage.inputTokens - (usage.cachedTokens ?? 0);
  const cachedInputTokens = usage.cachedTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  const outputTokens = usage.outputTokens;

  const uncachedInput =
    (uncachedInputTokens / 1_000_000) * tier.inputPerMillion;
  const cachedInput =
    (cachedInputTokens / 1_000_000) * tier.cachedInputPerMillion;
  const reasoning =
    (reasoningTokens / 1_000_000) * (tier.reasoningPerMillion ?? 0);
  const output = (outputTokens / 1_000_000) * tier.outputPerMillion;

  return uncachedInput + cachedInput + reasoning + output;
}

export function formatCost(cost: number): string {
  return `$${cost.toPrecision(2)}`;
}
