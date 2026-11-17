import type { ModelEndEvent, ModelStartEvent } from '../types/events'
import type { CostBasis } from '../types/runtime'

import {
  calculateCost,
  calculateSessionCost,
  loadedPricing,
  type PricedProvider,
  type PricedUsage,
} from '../providers/pricing'

declare const __ADK_VERSION__: string | undefined

/** The package version the build writes in; `source` when the ADK runs unbuilt, as examples do. */
const ADK_VERSION = typeof __ADK_VERSION__ === 'string' ? __ADK_VERSION__ : 'source'

export interface UsageLogOptions {
  /** Receives each line, its newline included. Standard error by default. */
  write?: (line: string) => void
}

/** What a paid call read and wrote, in tokens. */
interface TokenCounts {
  kind: 'tokens'
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  audioInputTokens: number
  audioOutputTokens: number
}

/**
 * One paid provider call, in the shape secondary care's cost metrics read (`$.event`, `$.costUsd`,
 * `$.model`, `$.operation`). It carries counts and prices only: never a prompt, an output or an
 * error message.
 */
type UsageLine = {
  ts: string
  level: 'info'
  component: 'adk'
  event: 'provider.usage'
  adkVersion: string
} & LineFields

/** What a line says about its call. */
type LineFields = {
  /** The agent that made the call, `decide`, or the ADK site that made it, such as `memory.embed`. */
  operation: string
  invocationId?: string
  provider?: string
  model: string
  /** Absent only when `costBasis` is `unavailable`. */
  costUsd?: number
  costBasis: CostBasis
} & (RequestFields | SessionSeconds)

/** A request, billed by the tokens it read and wrote. */
type RequestFields = TokenCounts & {
  endpointRegion?: string
  serviceTier?: string
  usageBasis: 'reported' | 'estimated' | 'unknown'
  finishReason?: ModelEndEvent['finishReason']
  /** A digest the caller gives to name the request, such as a cache key; never its text. */
  requestKey?: string
  durationMs: number
}

/** A GPT Live session, billed by the seconds it was connected. */
interface SessionSeconds {
  kind: 'session'
  seconds: number
  usageBasis: 'reported' | 'estimated'
  durationMs: number
}

/**
 * Kept on `globalThis` because the CommonJS build bundles each entry point separately, so a host's
 * `configureUsageLog` through one entry would otherwise miss the lines another entry writes.
 */
const USAGE_LOG = Symbol.for('@animahealth/adk/usage-log')
const holder = globalThis as { [USAGE_LOG]?: { write: ((line: string) => void) | null } }
holder[USAGE_LOG] ??= { write: writeToStderr }
const log = holder[USAGE_LOG]

/**
 * Sends each paid call's `provider.usage` line to `options.write` instead of standard error, or
 * pass `false` to write none.
 */
export function configureUsageLog(options: UsageLogOptions | false): void {
  log.write = options === false ? null : (options.write ?? writeToStderr)
}

/**
 * Writes to standard error, which Lambda and ECS ship to CloudWatch like standard output, so a
 * program that speaks a protocol over standard output, such as a JSON-lines CLI or an MCP stdio
 * server, keeps it clean. Reads it at each write, so a host that replaces it, as the terminal UI
 * does, receives the line.
 */
function writeToStderr(line: string): void {
  const stderr = typeof process === 'undefined' ? undefined : process.stderr
  if (stderr?.write) stderr.write(line)
  else console.error(line.trimEnd())
}

function writeLine(fields: LineFields): void {
  const { write } = log
  if (!write) return
  const line = {
    ts: new Date().toISOString(),
    level: 'info',
    component: 'adk',
    event: 'provider.usage',
    ...fields,
    adkVersion: ADK_VERSION,
  } satisfies UsageLine
  try {
    write(`${JSON.stringify(line)}\n`)
  } catch {
    // A log that cannot be written must not fail the call it records.
  }
}

/**
 * Writes one `provider.usage` line for each model call that ends, priced from the price list in
 * use. A `ModelCallObserver`, which `modelCallObservers` returns first.
 */
export function logModelUsage(event: ModelStartEvent | ModelEndEvent): void {
  if (event.type !== 'model_end') return
  logTokenUsage({
    operation: event.agentName,
    invocationId: event.invocationId,
    usage: event.usage,
    finishReason: event.finishReason,
    durationMs: event.durationMs,
  })
}

/**
 * Writes the `provider.usage` line of a request billed by its tokens, such as a model call or an
 * embedding, priced from the price list in use. The ADK writes one for every call it makes; code
 * that calls a provider without the ADK, such as over raw HTTP, writes its own with this, from the
 * usage the provider reported, or with `usage` undefined when it reported none.
 */
export function logTokenUsage({
  operation,
  invocationId,
  usage,
  finishReason,
  requestKey,
  durationMs,
}: {
  operation: string
  invocationId?: string
  usage: PricedUsage | undefined
  finishReason?: ModelEndEvent['finishReason']
  requestKey?: string
  durationMs: number
}): void {
  writeLine({
    operation,
    ...(invocationId && { invocationId }),
    ...usageFields(usage),
    ...costOf(usage),
    ...(finishReason && { finishReason }),
    ...(requestKey && { requestKey }),
    durationMs,
  })
}

/**
 * Writes the `provider.usage` line of a GPT Live session, billed by the seconds it was connected
 * and priced from the price list in use.
 */
export function logSessionUsage({
  operation,
  provider,
  model,
  seconds,
  usageBasis,
}: {
  operation: string
  provider: PricedProvider
  model: string
  seconds: number
  usageBasis: SessionSeconds['usageBasis']
}): void {
  const costUsd = calculateSessionCost(model, seconds, loadedPricing())
  writeLine({
    operation,
    provider,
    model,
    kind: 'session',
    seconds,
    usageBasis,
    durationMs: Math.round(seconds * 1000),
    ...(costUsd === null ? { costBasis: 'unavailable' } : { costUsd, costBasis: usageBasis }),
  })
}

/**
 * Tokens in a request of `characters` characters, at about four a token, the usual rate for
 * English. It sizes a request that never reported its usage.
 */
export function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4)
}

type UsageFields = Pick<LineFields, 'provider' | 'model'> &
  Omit<RequestFields, 'finishReason' | 'durationMs'>

/** The model and its token counts; a call without usage reads as zero tokens, `unknown`. */
function usageFields(usage: PricedUsage | undefined): UsageFields {
  if (!usage) {
    return {
      model: 'unknown',
      ...tokens({ inputTokens: 0, outputTokens: 0 }),
      usageBasis: 'unknown',
    }
  }
  return {
    ...(usage.provider && { provider: usage.provider }),
    model: usage.modelName ?? 'unknown',
    ...(usage.endpointRegion && { endpointRegion: usage.endpointRegion }),
    ...(usage.serviceTier && { serviceTier: usage.serviceTier }),
    ...tokens(usage),
    usageBasis: usage.estimated ? 'estimated' : 'reported',
  }
}

function tokens(usage: Omit<PricedUsage, 'provider'>): TokenCounts {
  return {
    kind: 'tokens',
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    audioInputTokens: usage.audioInputTokens ?? 0,
    audioOutputTokens: usage.audioOutputTokens ?? 0,
  }
}

/**
 * What `usageCost` would charge for the call: the price list's figure, else the provider's own,
 * with the basis of its usage.
 */
function costOf(usage: PricedUsage | undefined): Pick<LineFields, 'costUsd' | 'costBasis'> {
  const costUsd =
    usage && (calculateCost(usage, loadedPricing())?.totalCost ?? usage.reportedCostUSD)
  if (costUsd === undefined) return { costBasis: 'unavailable' }
  return { costUsd, costBasis: usage?.estimated ? 'estimated' : 'reported' }
}
