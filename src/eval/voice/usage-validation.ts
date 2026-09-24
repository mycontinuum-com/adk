import type { CostAccount, UsageSummary } from '../../types/runtime'
import type { LiveVoiceEvalUsage } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAmount(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isCostEstimate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.inputCost) &&
    isFiniteNumber(value.outputCost) &&
    isFiniteNumber(value.totalCost) &&
    value.currency === 'USD'
  )
}

function isModelUsageEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.provider === undefined || typeof value.provider === 'string') &&
    (value.reportedCostUSD === undefined || isFiniteNumber(value.reportedCostUSD)) &&
    typeof value.modelName === 'string' &&
    isFiniteNumber(value.calls) &&
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.cachedTokens) &&
    (value.cacheWriteTokens === undefined || isFiniteNumber(value.cacheWriteTokens)) &&
    isFiniteNumber(value.reasoningTokens) &&
    isFiniteNumber(value.audioInputTokens) &&
    isFiniteNumber(value.audioOutputTokens) &&
    (value.cost === undefined || isCostEstimate(value.cost))
  )
}

/** Checks the structure of a serialized `UsageSummary`. */
export function isUsageSummary(value: unknown): value is UsageSummary {
  return (
    isRecord(value) &&
    (value.reportedCostUSD === undefined || isFiniteNumber(value.reportedCostUSD)) &&
    Array.isArray(value.models) &&
    value.models.every(isModelUsageEntry) &&
    isFiniteNumber(value.totalInputTokens) &&
    isFiniteNumber(value.totalOutputTokens) &&
    isFiniteNumber(value.totalCachedTokens) &&
    (value.totalCacheWriteTokens === undefined || isFiniteNumber(value.totalCacheWriteTokens)) &&
    isFiniteNumber(value.totalReasoningTokens) &&
    isFiniteNumber(value.totalAudioInputTokens) &&
    isFiniteNumber(value.totalAudioOutputTokens) &&
    isFiniteNumber(value.modelCalls) &&
    (value.cost === undefined || isCostEstimate(value.cost))
  )
}

/**
 * Checks a `CostAccount`: an unavailable account has no amount; others have a nonnegative USD
 * amount.
 */
function isCostAccount(value: unknown): value is CostAccount {
  if (!isRecord(value)) return false
  if (value.basis === 'unavailable') return Object.keys(value).length === 1
  return (
    (value.basis === 'reported' || value.basis === 'estimated') &&
    isAmount(value.totalCost) &&
    value.currency === 'USD'
  )
}

function isUsageCost(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.usage === undefined || isUsageSummary(value.usage)) &&
    isCostAccount(value.cost)
  )
}

/** Checks the structure of serialized Live eval usage, including every cost account. */
export function isLiveEvalUsage(value: unknown): value is LiveVoiceEvalUsage {
  return (
    isRecord(value) &&
    isUsageCost(value.backend) &&
    isUsageCost(value.caller) &&
    isRecord(value.voice) &&
    typeof value.voice.modelName === 'string' &&
    (value.voice.seconds === undefined || isAmount(value.voice.seconds)) &&
    isCostAccount(value.voice.cost) &&
    isCostAccount(value.total)
  )
}
