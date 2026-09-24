import type { ModelUsage, CostAccount, CostEstimate, Provider, UsageSummary } from '../types'

/**
 * LiteLLM's community-maintained price map: authless JSON keyed by provider model id, updated as
 * providers release and reprice models, with the realtime audio rates voice agents need.
 */
const DEFAULT_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

export interface PricingOptions {
  /** A price map in LiteLLM's `model_prices_and_context_window.json` format. */
  url?: string
  /** Age after which the next lookup refreshes the catalog in the background. */
  ttlMs?: number
  timeoutMs?: number
  /** Wait before retrying after a failed fetch, so an outage does not delay every run. */
  retryAfterMs?: number
}

/** USD per token. An absent rate means the registry does not price that category. */
interface TokenRates {
  input?: number
  cachedInput?: number
  cacheWriteInput?: number
  output?: number
  reasoning?: number
  audioInput?: number
  audioCachedInput?: number
  audioOutput?: number
}

export interface ModelPricing extends TokenRates {
  /** USD per second of connected session time, for models billed by duration. */
  readonly sessionPerSecond?: number
  /** The registry key the pricing came from. */
  readonly key: string
  /** Rates that replace the base rates once a request's input exceeds `aboveInputTokens`. */
  readonly tiers: readonly (TokenRates & { readonly aboveInputTokens: number })[]
  /** Google reports thinking tokens outside the output count, so they are billed on top of it. */
  readonly reasoningBilledSeparately: boolean
}

interface CatalogEntry {
  readonly registryProvider: string
  readonly pricing: ModelPricing
}

export type PricingCatalog = ReadonlyMap<string, CatalogEntry>

const RATE_FIELDS: Record<string, keyof TokenRates> = {
  input_cost_per_token: 'input',
  cache_read_input_token_cost: 'cachedInput',
  cache_creation_input_token_cost: 'cacheWriteInput',
  output_cost_per_token: 'output',
  output_cost_per_reasoning_token: 'reasoning',
  input_cost_per_audio_token: 'audioInput',
  cache_read_input_audio_token_cost: 'audioCachedInput',
  output_cost_per_audio_token: 'audioOutput',
}

const TIER_FIELD = /^(.+)_above_(\d+)k_tokens$/

const GOOGLE_REGISTRY_PROVIDERS = ['gemini', 'vertex_ai-language-models']

/** How each ADK provider's model ids appear in the registry. Routers price upstream, not here. */
const REGISTRY_NAMESPACES: Partial<
  Record<Provider, { providers: readonly string[]; keys: (name: string) => string[] }>
> = {
  openai: { providers: ['openai'], keys: (name) => [name] },
  gemini: {
    providers: GOOGLE_REGISTRY_PROVIDERS,
    keys: (name) => [`gemini/${name}`, name],
  },
  claude: {
    providers: ['vertex_ai-anthropic_models', 'anthropic'],
    keys: (name) => [`vertex_ai/${name}`, name],
  },
}

function rate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(key: string, fields: unknown): CatalogEntry | undefined {
  if (!isRecord(fields)) return undefined
  const registryProvider = fields.litellm_provider
  if (typeof registryProvider !== 'string') return undefined

  const base: TokenRates = {}
  const tiers = new Map<number, TokenRates>()
  for (const [field, value] of Object.entries(fields)) {
    const price = rate(value)
    if (price === undefined) continue
    const tierMatch = TIER_FIELD.exec(field)
    const rateName = RATE_FIELDS[tierMatch ? tierMatch[1] : field]
    if (!rateName) continue
    if (!tierMatch) {
      base[rateName] = price
      continue
    }
    const aboveInputTokens = Number(tierMatch[2]) * 1000
    tiers.set(aboveInputTokens, { ...tiers.get(aboveInputTokens), [rateName]: price })
  }
  const sessionPerSecond = rate(fields.input_cost_per_second)
  if (base.input === undefined && base.output === undefined && sessionPerSecond === undefined) {
    return undefined
  }

  return {
    registryProvider,
    pricing: {
      key,
      ...base,
      ...(sessionPerSecond !== undefined && { sessionPerSecond }),
      tiers: [...tiers]
        .map(([aboveInputTokens, rates]) => ({ ...rates, aboveInputTokens }))
        .toSorted((a, b) => a.aboveInputTokens - b.aboveInputTokens),
      reasoningBilledSeparately: GOOGLE_REGISTRY_PROVIDERS.includes(registryProvider),
    },
  }
}

/**
 * Parse a LiteLLM-format price map into a catalog keyed by registry model id. Entries without a
 * provider or any token rate are skipped.
 *
 * @throws When `raw` is not an object or contains no priced entries.
 */
export function parsePricingCatalog(raw: unknown): PricingCatalog {
  if (!isRecord(raw)) {
    throw new Error('Pricing registry is not a JSON object')
  }
  const catalog = new Map<string, CatalogEntry>()
  for (const [key, value] of Object.entries(raw)) {
    const entry = parseEntry(key, value)
    if (entry) catalog.set(key, entry)
  }
  if (catalog.size === 0) throw new Error('Pricing registry contains no token prices')
  return catalog
}

/** Snapshot and deployment suffixes a registry may only list under the base model id. */
const VERSION_SUFFIX = /(@.*|-\d{4}-\d{2}-\d{2}|-\d{8}|-\d{3}|-latest|-v\d+(:\d+)?)$/

function nameCandidates(modelName: string): string[] {
  const names = [modelName]
  let name = modelName
  while (VERSION_SUFFIX.test(name)) {
    name = name.replace(VERSION_SUFFIX, '')
    names.push(name)
  }
  return names
}

/**
 * Find a model's pricing in its provider's registry namespaces, falling back from dated or
 * `@version` ids to the base model. Without a provider, every first-party namespace is searched.
 *
 * @returns `undefined` when no first-party entry matches.
 */
export function getPricing(
  catalog: PricingCatalog,
  lookup: { provider?: Provider; modelName: string },
): ModelPricing | undefined {
  const namespaces = lookup.provider
    ? [REGISTRY_NAMESPACES[lookup.provider]]
    : Object.values(REGISTRY_NAMESPACES)
  for (const name of nameCandidates(lookup.modelName)) {
    for (const namespace of namespaces) {
      if (!namespace) continue
      for (const key of namespace.keys(name)) {
        const entry = catalog.get(key)
        if (entry && namespace.providers.includes(entry.registryProvider)) return entry.pricing
      }
    }
  }
  return undefined
}

type Charge = [tokens: number, rate: number | undefined]

function sumCharges(charges: readonly Charge[]): number {
  return charges.reduce((total, [tokens, perToken]) => total + tokens * (perToken ?? 0), 0)
}

/** Whether a call could be priced from the registry, so callers only load it when needed. */
export function isPriceable(
  usage: ModelUsage | undefined,
): usage is ModelUsage & { modelName: string } {
  return (
    usage?.modelName !== undefined &&
    (usage.provider === undefined || REGISTRY_NAMESPACES[usage.provider] !== undefined)
  )
}

/**
 * Estimate a call's USD cost from its token counts.
 *
 * @returns `null` without a catalog, for an unpriceable call or unknown model, or when a billed
 *   token category has no published rate.
 */
export function calculateCost(
  usage: ModelUsage,
  catalog: PricingCatalog | undefined,
): CostEstimate | null {
  if (!catalog || !isPriceable(usage)) return null
  const pricing = getPricing(catalog, { provider: usage.provider, modelName: usage.modelName })
  if (!pricing) return null

  const tier = pricing.tiers.findLast((t) => usage.inputTokens > t.aboveInputTokens)
  const rates: TokenRates = { ...pricing, ...tier }

  // Audio, cached and cache-write counts are subsets of the reported input and output totals.
  const audioInput = usage.audioInputTokens ?? 0
  const audioCached = Math.min(usage.audioCachedTokens ?? 0, audioInput)
  const audioOutput = usage.audioOutputTokens ?? 0
  const cached = Math.max(0, (usage.cachedTokens ?? 0) - audioCached)
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const textInput = Math.max(0, usage.inputTokens - audioInput - cached - cacheWrite)
  const textOutput = Math.max(0, usage.outputTokens - audioOutput)
  const reasoning = pricing.reasoningBilledSeparately ? (usage.reasoningTokens ?? 0) : 0

  const charges: Charge[] = [
    [textInput, rates.input],
    [cached, rates.cachedInput ?? rates.input],
    [cacheWrite, rates.cacheWriteInput ?? rates.input],
    [audioInput - audioCached, rates.audioInput],
    [audioCached, rates.audioCachedInput ?? rates.audioInput],
  ]
  const outputCharges: Charge[] = [
    [textOutput, rates.output],
    [reasoning, rates.reasoning ?? rates.output],
    [audioOutput, rates.audioOutput],
  ]
  // A billed category without a published rate would understate the total, so price none of it.
  if ([...charges, ...outputCharges].some(([tokens, r]) => tokens > 0 && r === undefined)) {
    return null
  }
  const inputCost = sumCharges(charges)
  const outputCost = sumCharges(outputCharges)

  return { inputCost, outputCost, totalCost: inputCost + outputCost, currency: 'USD' }
}

const DEFAULT_OPTIONS: Required<PricingOptions> = {
  url: DEFAULT_PRICING_URL,
  ttlMs: 60 * 60 * 1000,
  timeoutMs: 5000,
  retryAfterMs: 5 * 60 * 1000,
}

interface PricingState {
  readonly options: Required<PricingOptions>
  loaded?: { readonly catalog: PricingCatalog; readonly fetchedAt: number }
  failedAt?: number
  refreshing?: Promise<PricingCatalog | undefined>
}

let state: PricingState | null = { options: DEFAULT_OPTIONS }

/** Point cost estimation at another price map, or pass `false` to disable it. */
export function configurePricing(options: PricingOptions | false): void {
  state = options === false ? null : { options: { ...DEFAULT_OPTIONS, ...options } }
}

async function fetchCatalog(options: Required<PricingOptions>): Promise<PricingCatalog> {
  const response = await fetch(options.url, { signal: AbortSignal.timeout(options.timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parsePricingCatalog(await response.json())
}

function refresh(current: PricingState): Promise<PricingCatalog | undefined> {
  current.refreshing ??= fetchCatalog(current.options)
    .then(
      (catalog) => {
        current.loaded = { catalog, fetchedAt: Date.now() }
        current.failedAt = undefined
        return catalog
      },
      (error: unknown) => {
        current.failedAt = Date.now()
        console.warn('adk.pricing.unavailable', {
          url: current.options.url,
          error: error instanceof Error ? error.message : String(error),
        })
        return current.loaded?.catalog
      },
    )
    .finally(() => {
      current.refreshing = undefined
    })
  return current.refreshing
}

/** How long a finished run waits for a first catalog before returning without a cost. */
export const RESULT_PRICING_WAIT_MS = 1000

function settleWithin<T>(work: Promise<T>, maxWaitMs: number): Promise<T | undefined> {
  if (!Number.isFinite(maxWaitMs)) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  const elapsed = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), maxWaitMs)
  })
  return Promise.race([work, elapsed]).finally(() => clearTimeout(timer))
}

/**
 * Resolve the live pricing catalog. Never rejects: when the registry is unreachable, costs are
 * omitted rather than guessed. A stale catalog is served while it refreshes in the background.
 *
 * @param options.maxWaitMs - Stop waiting for a first fetch after this long; it keeps running.
 */
export async function loadPricing(
  options: { maxWaitMs?: number } = {},
): Promise<PricingCatalog | undefined> {
  const current = state
  if (!current) return undefined
  const now = Date.now()
  const backingOff =
    current.failedAt !== undefined && now - current.failedAt < current.options.retryAfterMs
  if (current.loaded) {
    const expired = now - current.loaded.fetchedAt > current.options.ttlMs
    if (expired && !backingOff) void refresh(current)
    return current.loaded.catalog
  }
  if (backingOff) return undefined
  return settleWithin(refresh(current), options.maxWaitMs ?? Infinity)
}

/**
 * USD cost of `seconds` of connected session time, for voice models billed by duration rather than
 * tokens, such as GPT Live.
 *
 * @returns `null` without a catalog, for a model the registry does not price per second, or for an
 *   invalid duration.
 */
export function calculateSessionCost(
  modelName: string,
  seconds: number,
  catalog: PricingCatalog | undefined,
): number | null {
  const perSecond = catalog && getPricing(catalog, { modelName })?.sessionPerSecond
  if (perSecond === undefined || !Number.isFinite(seconds) || seconds < 0) return null
  // Registries publish per-minute prices as repeating per-second decimals; whole micro-dollars per
  // minute keep a $0.05/minute rate exact.
  const microUsdPerMinute = Math.round(perSecond * 60 * 1_000_000)
  return (seconds * microUsdPerMinute) / 60 / 1_000_000
}

/**
 * Prices a token usage summary. No model calls cost nothing. Each model is priced from the pricing
 * registry or, failing that, from the charge its provider reported; a call without known usage or
 * any model without a charge makes the whole figure unavailable.
 */
export function usageCost(usage: UsageSummary | undefined): CostAccount {
  if (!usage) return { basis: 'reported', totalCost: 0, currency: 'USD' }
  let totalCost = 0
  let calls = 0
  for (const model of usage.models) {
    const charge = model.cost?.totalCost ?? model.reportedCostUSD
    if (charge === undefined) return { basis: 'unavailable' }
    totalCost += charge
    calls += model.calls
  }
  if (calls !== usage.modelCalls) return { basis: 'unavailable' }
  return { basis: 'reported', totalCost, currency: 'USD' }
}

/** Adds costs. The result is only as strong as its weakest component. */
export function sumCosts(accounts: readonly CostAccount[]): CostAccount {
  let totalCost = 0
  let estimated = false
  for (const account of accounts) {
    if (account.basis === 'unavailable') return { basis: 'unavailable' }
    totalCost += account.totalCost
    estimated ||= account.basis === 'estimated'
  }
  return { basis: estimated ? 'estimated' : 'reported', totalCost, currency: 'USD' }
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(6)}`
}

/** Formats a cost with its basis, for example `$0.0750 (reported)` or `unavailable`. */
export function formatCostAccount(account: CostAccount): string {
  return account.basis === 'unavailable'
    ? 'unavailable'
    : `${formatCost(account.totalCost)} (${account.basis})`
}
