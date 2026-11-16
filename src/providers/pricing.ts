import type { ModelUsage, CostAccount, CostEstimate, Provider, UsageSummary } from '../types'

import { PRICE_LIST } from './price-list.gen'

export interface PricingOptions {
  /**
   * A price map in LiteLLM's `model_prices_and_context_window.json` format, fetched at runtime and
   * refreshed in place of the snapshot the ADK ships. Without it the ADK prices from that snapshot
   * and makes no network request.
   */
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

/** A provider the registry prices: the model providers, and Voyage's embeddings. */
export type PricedProvider = Provider | 'voyage'

/** A call's usage as the registry prices it, which may come from a service outside the adapters. */
export type PricedUsage = Omit<ModelUsage, 'provider'> & { provider?: PricedProvider }

/** One service tier's rates. */
interface RateTable extends TokenRates {
  /** Rates that replace the base rates once a request's input exceeds `aboveInputTokens`. */
  readonly tiers: readonly (TokenRates & { readonly aboveInputTokens: number })[]
}

export interface ModelPricing extends RateTable {
  /** USD per second of connected session time, for models billed by duration. */
  readonly sessionPerSecond?: number
  /** The registry key the pricing came from. */
  readonly key: string
  /**
   * Each service tier's own rates, by the suffix the registry names it with, such as `flex`; a rate
   * a tier does not list is the standard one.
   */
  readonly serviceTiers: ReadonlyMap<string, RateTable>
  /** Multipliers for processing in a region, such as OpenAI's `eu` data residency, by region. */
  readonly regionalProcessingUplift: Readonly<Record<string, number>>
  /** Multiplier for a call to a regional rather than the global endpoint, as on Vertex. */
  readonly regionalEndpointUplift?: number
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

/** A rate, optionally above an input size, optionally for the service tier its suffix names. */
const RATE_FIELD = new RegExp(
  `^(${Object.keys(RATE_FIELDS).join('|')})(?:_above_(\\d+)k_tokens)?(?:_([a-z]+))?$`,
)

const PROCESSING_UPLIFT_FIELD = /^regional_processing_uplift_multiplier_(.+)$/

const GOOGLE_REGISTRY_PROVIDERS = ['gemini', 'vertex_ai-language-models', 'vertex_ai']

/**
 * How each provider's model ids appear in the registry; a call with an `endpointRegion` went
 * through Vertex. Routers price upstream, not here.
 */
const REGISTRY_NAMESPACES: Partial<
  Record<
    PricedProvider,
    { providers: readonly string[]; keys: (name: string, endpointRegion?: string) => string[] }
  >
> = {
  openai: { providers: ['openai'], keys: (name) => [name] },
  gemini: {
    providers: GOOGLE_REGISTRY_PROVIDERS,
    keys: (name, endpointRegion) =>
      endpointRegion ? [`vertex_ai/${name}`, name, `gemini/${name}`] : [`gemini/${name}`, name],
  },
  claude: {
    providers: ['vertex_ai-anthropic_models', 'anthropic'],
    keys: (name) => [`vertex_ai/${name}`, name],
  },
  voyage: { providers: ['voyage'], keys: (name) => [`voyage/${name}`] },
}

function rate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ParsedTable {
  readonly base: TokenRates
  readonly above: Map<number, TokenRates>
}

function rateTable({ base, above }: ParsedTable): RateTable {
  return {
    ...base,
    tiers: [...above]
      .map(([aboveInputTokens, rates]) => ({ ...rates, aboveInputTokens }))
      .toSorted((a, b) => a.aboveInputTokens - b.aboveInputTokens),
  }
}

/** The token rates of each service tier, and the regional uplifts, in a registry entry. */
function parseRates(fields: Record<string, unknown>) {
  // The standard rates are under `undefined`, so no tier suffix can name them.
  const tables = new Map<string | undefined, ParsedTable>()
  const regionalProcessingUplift: Record<string, number> = {}
  for (const [field, value] of Object.entries(fields)) {
    const price = rate(value)
    if (price === undefined) continue
    const region = PROCESSING_UPLIFT_FIELD.exec(field)?.[1]
    if (region) regionalProcessingUplift[region] = price
    const match = RATE_FIELD.exec(field)
    const rateName = match && RATE_FIELDS[match[1]]
    if (!rateName) continue
    const tier = match[3]
    let table = tables.get(tier)
    if (!table) {
      table = { base: {}, above: new Map() }
      tables.set(tier, table)
    }
    if (!match[2]) {
      table.base[rateName] = price
      continue
    }
    const aboveInputTokens = Number(match[2]) * 1000
    table.above.set(aboveInputTokens, { ...table.above.get(aboveInputTokens), [rateName]: price })
  }
  const serviceTiers = new Map<string, RateTable>()
  for (const [tier, table] of tables) {
    if (tier !== undefined) serviceTiers.set(tier, rateTable(table))
  }
  return {
    standard: rateTable(tables.get(undefined) ?? { base: {}, above: new Map() }),
    serviceTiers,
    regionalProcessingUplift,
  }
}

function parseEntry(key: string, fields: unknown): CatalogEntry | undefined {
  if (!isRecord(fields)) return undefined
  const registryProvider = fields.litellm_provider
  if (typeof registryProvider !== 'string') return undefined

  const { standard, serviceTiers, regionalProcessingUplift } = parseRates(fields)
  const sessionPerSecond = rate(fields.input_cost_per_second)
  if (
    standard.input === undefined &&
    standard.output === undefined &&
    sessionPerSecond === undefined
  ) {
    return undefined
  }
  const regionalEndpointUplift = rate(fields.regional_endpoint_uplift_multiplier)

  return {
    registryProvider,
    pricing: {
      key,
      ...standard,
      ...(sessionPerSecond !== undefined && { sessionPerSecond }),
      serviceTiers,
      regionalProcessingUplift,
      ...(regionalEndpointUplift !== undefined && { regionalEndpointUplift }),
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
  lookup: { provider?: PricedProvider; modelName: string; endpointRegion?: string },
): ModelPricing | undefined {
  const namespaces = lookup.provider
    ? [REGISTRY_NAMESPACES[lookup.provider]]
    : Object.values(REGISTRY_NAMESPACES)
  for (const name of nameCandidates(lookup.modelName)) {
    for (const namespace of namespaces) {
      if (!namespace) continue
      for (const key of namespace.keys(name, lookup.endpointRegion)) {
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
export function isPriceable<T extends Pick<PricedUsage, 'provider' | 'modelName'>>(
  usage: T | undefined,
): usage is T & { modelName: string } {
  return (
    usage?.modelName !== undefined &&
    (usage.provider === undefined || REGISTRY_NAMESPACES[usage.provider] !== undefined)
  )
}

/**
 * Estimate a call's USD cost from its token counts.
 *
 * @returns `null` without a catalog, for an unpriceable call or unknown model, for a service tier
 *   the registry has no rates for, or when a billed token category has no published rate.
 */
export function calculateCost(
  usage: PricedUsage,
  catalog: PricingCatalog | undefined,
): CostEstimate | null {
  if (!catalog || !isPriceable(usage)) return null
  const pricing = getPricing(catalog, usage)
  if (!pricing) return null

  const rates = ratesFor(pricing, usage)
  if (!rates) return null

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
  const uplift = upliftFor(pricing, usage.endpointRegion)
  const inputCost = sumCharges(charges) * uplift
  const outputCost = sumCharges(outputCharges) * uplift

  return { inputCost, outputCost, totalCost: inputCost + outputCost, currency: 'USD' }
}

/**
 * The rates a call is billed at: its service tier's, then the standard ones it does not list, each
 * replaced above the input size of the largest threshold the call passes. `undefined` for a tier
 * the registry has no rates for, which may cost more than the standard one.
 */
function ratesFor(pricing: ModelPricing, usage: PricedUsage): TokenRates | undefined {
  const above = (table: RateTable) =>
    table.tiers.findLast((t) => usage.inputTokens > t.aboveInputTokens)
  const standard = { ...pricing, ...above(pricing) }
  if (usage.serviceTier === undefined) return standard
  const tier = pricing.serviceTiers.get(usage.serviceTier)
  return tier && { ...standard, ...tier, ...above(tier) }
}

/**
 * What a call's region adds: the regional processing multiplier for its region, and the regional
 * endpoint multiplier for any region but `global`.
 */
function upliftFor(pricing: ModelPricing, endpointRegion: string | undefined): number {
  if (!endpointRegion) return 1
  const processing = pricing.regionalProcessingUplift[endpointRegion] ?? 1
  const endpoint = endpointRegion === 'global' ? 1 : (pricing.regionalEndpointUplift ?? 1)
  return processing * endpoint
}

const DEFAULT_OPTIONS: Required<Omit<PricingOptions, 'url'>> = {
  ttlMs: 60 * 60 * 1000,
  timeoutMs: 5000,
  retryAfterMs: 5 * 60 * 1000,
}

interface PricingState {
  readonly options: Required<Omit<PricingOptions, 'url'>> & Pick<PricingOptions, 'url'>
  loaded?: { readonly catalog: PricingCatalog; readonly fetchedAt: number }
  failedAt?: number
  refreshing?: Promise<PricingCatalog | undefined>
}

let shipped: PricingCatalog | undefined

/** The price list this ADK release ships (`price-list.gen.ts`), parsed on first use. */
function shippedCatalog(): PricingCatalog {
  shipped ??= parsePricingCatalog(PRICE_LIST)
  return shipped
}

/**
 * Kept on `globalThis` because the CommonJS build bundles each entry point separately, so a price
 * map one entry configured or loaded would otherwise not price the calls another entry records.
 */
const PRICING = Symbol.for('@animahealth/adk/pricing')
const holder = globalThis as { [PRICING]?: { state: PricingState | null } }
holder[PRICING] ??= { state: { options: DEFAULT_OPTIONS } }
const shared = holder[PRICING]

/**
 * Price from a live map at `options.url` instead of the shipped snapshot, or pass `false` to
 * disable cost estimation.
 */
export function configurePricing(options: PricingOptions | false): void {
  shared.state = options === false ? null : { options: { ...DEFAULT_OPTIONS, ...options } }
}

async function fetchCatalog({
  url,
  timeoutMs,
}: {
  url: string
  timeoutMs: number
}): Promise<PricingCatalog> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parsePricingCatalog(await response.json())
}

function refresh(current: PricingState, url: string): Promise<PricingCatalog | undefined> {
  current.refreshing ??= fetchCatalog({ url, timeoutMs: current.options.timeoutMs })
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
 * Resolve the pricing catalog: the shipped snapshot, or a live map once one is configured and has
 * loaded. Never rejects. A live map that has not loaded, or cannot be reached, leaves the snapshot
 * in use; a stale live map is served while it refreshes in the background.
 *
 * @param options.maxWaitMs - Stop waiting for a first live fetch after this long; it keeps running.
 * @returns `undefined` only when pricing is disabled.
 */
export async function loadPricing(
  options: { maxWaitMs?: number } = {},
): Promise<PricingCatalog | undefined> {
  const current = shared.state
  if (!current) return undefined
  const { url } = current.options
  if (url === undefined) return shippedCatalog()
  const now = Date.now()
  const backingOff =
    current.failedAt !== undefined && now - current.failedAt < current.options.retryAfterMs
  if (current.loaded) {
    const expired = now - current.loaded.fetchedAt > current.options.ttlMs
    if (expired && !backingOff) void refresh(current, url)
    return current.loaded.catalog
  }
  if (backingOff) return shippedCatalog()
  return (
    (await settleWithin(refresh(current, url), options.maxWaitMs ?? Infinity)) ?? shippedCatalog()
  )
}

/**
 * The catalog in use now, without waiting for a fetch: a loaded live map, else the shipped
 * snapshot; `undefined` only when pricing is disabled. A configured live map that has not loaded,
 * or has gone stale, starts loading in the background, so every path that prices a call keeps it
 * current.
 */
export function loadedPricing(): PricingCatalog | undefined {
  const current = shared.state
  if (!current) return undefined
  if (current.options.url !== undefined) void loadPricing()
  return current.loaded?.catalog ?? shippedCatalog()
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
 * registry or, failing that, from the charge its provider reported. The total is `estimated` when a
 * call was cut off and counted at its estimated input; a call without known or estimated usage, or
 * any model without a charge, makes it unavailable.
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
  return { basis: usage.estimatedCalls ? 'estimated' : 'reported', totalCost, currency: 'USD' }
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
