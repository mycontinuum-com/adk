import { createHash } from 'node:crypto'

import type { RetryConfig } from '../../types/runnables'
import type {
  VectorIndex,
  QdrantConfig,
  VectorFilter,
  VectorCondition,
  HasIdCondition,
  DistanceMatrixResult,
  ScrollResult,
} from '../types'

import { withRetry } from '../../core/retry'

const ID_KEY = '_original_id'
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

function uuidv5(name: string, ns: Buffer): string {
  const hash = createHash('sha1').update(ns).update(name).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

const ADK_NS = Buffer.from('0f6f7d7df59e5ba9a47bbd991189e8f6', 'hex')

function mapId(id: string): { qdrantId: string | number; original?: string } {
  const num = Number(id)
  if (!isNaN(num) && Number.isSafeInteger(num) && num >= 0) {
    return { qdrantId: num }
  }
  if (UUID_RE.test(id)) return { qdrantId: id }
  return { qdrantId: uuidv5(id, ADK_NS), original: id }
}

function recoverOriginalId(qdrantId: string | number, payload?: Record<string, unknown>): string {
  if (payload && typeof payload[ID_KEY] === 'string') {
    return payload[ID_KEY] as string
  }
  return String(qdrantId)
}

function stripIdField(payload: Record<string, unknown>): Record<string, unknown> {
  if (!(ID_KEY in payload)) return payload
  const { [ID_KEY]: _, ...rest } = payload
  return rest
}

function mapPoint(p: { id: string | number; payload?: Record<string, unknown> }): {
  id: string
  metadata: Record<string, unknown>
} {
  const payload = (p.payload ?? {}) as Record<string, unknown>
  return {
    id: recoverOriginalId(p.id, payload),
    metadata: stripIdField(payload),
  }
}

const DEFAULT_BATCH_SIZE = 128
const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
}

let proxyDispatcherConfigured = false

function configureQdrantProxyDispatcherFromEnv(): void {
  if (proxyDispatcherConfigured) return

  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy

  if (!proxyUrl) {
    proxyDispatcherConfigured = true
    return
  }

  try {
    const module = require('node:module') as typeof import('node:module')
    const path = require('node:path') as typeof import('node:path')

    const qdrantIndexPath = require.resolve('@qdrant/js-client-rest')
    const qdrantDispatcherPath = path.join(path.dirname(qdrantIndexPath), 'dispatcher.js')
    const qdrantRequire = module.createRequire(qdrantDispatcherPath)
    const { ProxyAgent, setGlobalDispatcher } = qdrantRequire('undici') as {
      ProxyAgent: new (proxy: string) => unknown
      setGlobalDispatcher: (dispatcher: unknown) => void
    }
    const qdrantDispatcherModule = require(qdrantDispatcherPath) as {
      createDispatcher?: (connections?: number) => unknown
    }
    const proxyDispatcher = new ProxyAgent(proxyUrl)

    if (typeof qdrantDispatcherModule.createDispatcher === 'function') {
      qdrantDispatcherModule.createDispatcher = () => proxyDispatcher
    }

    const globalFetch = globalThis.fetch as
      | ((input: unknown, init?: Record<string, unknown>) => Promise<unknown>)
      | undefined
    if (
      typeof globalFetch === 'function' &&
      !(globalFetch as { __adkProxyWrapped?: boolean }).__adkProxyWrapped
    ) {
      const wrappedFetch = ((input: unknown, init?: Record<string, unknown>) =>
        globalFetch(input, {
          ...init,
          dispatcher: proxyDispatcher,
        })) as typeof globalThis.fetch & {
        __adkProxyWrapped?: boolean
      }
      wrappedFetch.__adkProxyWrapped = true
      globalThis.fetch = wrappedFetch
    }

    setGlobalDispatcher(proxyDispatcher)
  } catch {
    // No-op: if undici is unavailable, retain default dispatcher behavior.
  } finally {
    proxyDispatcherConfigured = true
  }
}

export function qdrant(config: Omit<QdrantConfig, 'provider'>): QdrantConfig {
  return { provider: 'qdrant', ...config }
}

function splitQdrantMetadata(metadata: Record<string, unknown>): {
  set: Record<string, unknown>
  remove: string[]
} {
  const set: Record<string, unknown> = {}
  const remove: string[] = []
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null) remove.push(key)
    else if (value !== undefined) set[key] = value
  }
  return { set, remove }
}

export function createQdrantIndex(config: QdrantConfig, injectedClient?: unknown): VectorIndex {
  const retryConfig = config.retry ?? DEFAULT_RETRY
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
  let client: unknown = injectedClient ?? null

  function getClient() {
    if (!client) {
      configureQdrantProxyDispatcherFromEnv()
      const { QdrantClient } = require('@qdrant/js-client-rest') as {
        QdrantClient: new (opts: {
          url: string
          apiKey?: string
          port?: number
        }) => QdrantClientType
      }
      const parsedUrl = new URL(config.url)
      const defaultPort =
        parsedUrl.port.length > 0
          ? undefined
          : parsedUrl.protocol === 'https:'
            ? 443
            : parsedUrl.protocol === 'http:'
              ? 80
              : undefined
      client = new QdrantClient({
        url: config.url,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(defaultPort !== undefined ? { port: defaultPort } : {}),
      })
    }
    return client as QdrantClientType
  }

  function transformEntry(entry: VectorCondition | HasIdCondition | VectorFilter): unknown {
    if ('has_id' in entry) {
      const hasId = entry as HasIdCondition
      return { has_id: hasId.has_id.map((id) => mapId(id).qdrantId) }
    }
    if ('key' in entry) {
      const cond = entry as VectorCondition
      if (cond.text) {
        const terms = [cond.text.contains].flat()
        if (terms.length === 1) return { key: cond.key, match: { text: terms[0] } }
        return {
          should: terms.map((t) => ({ key: cond.key, match: { text: t } })),
        }
      }
      return cond
    }
    return transformFilter(entry as VectorFilter)
  }

  function transformFilter(filter?: VectorFilter): unknown {
    if (!filter) return undefined
    return {
      ...(filter.must ? { must: filter.must.map(transformEntry) } : {}),
      ...(filter.should ? { should: filter.should.map(transformEntry) } : {}),
      ...(filter.must_not ? { must_not: filter.must_not.map(transformEntry) } : {}),
    }
  }

  return {
    async search(collection, embedding, options) {
      return withRetry(async () => {
        const qdrantClient = getClient()
        const results = await qdrantClient.query(collection, {
          query: embedding,
          ...(options?.variant ? { using: options.variant } : {}),
          limit: options?.topK ?? 10,
          ...(options?.filter ? { filter: transformFilter(options.filter) } : {}),
          ...(options?.minScore ? { score_threshold: options.minScore } : {}),
          with_payload: true,
          with_vector: false,
        })

        return (results.points ?? []).map((p: QdrantScoredPoint) => ({
          ...mapPoint(p),
          score: p.score ?? 0,
        }))
      }, retryConfig)
    },

    async upsert(collection, points, options) {
      const qdrantClient = getClient()
      const variant = options?.variant

      for (let i = 0; i < points.length; i += batchSize) {
        const chunk = points.slice(i, i + batchSize)
        const mapped = chunk.map((p) => ({ point: p, ...mapId(p.id) }))
        await withRetry(async () => {
          const operations: unknown[] = []

          if (variant) {
            // When upserting a named variant, create any new points first,
            // then update_vectors for all so other named vectors are preserved.
            const existing = await qdrantClient.retrieve(collection, {
              ids: mapped.map((m) => m.qdrantId),
              with_payload: false,
              with_vector: false,
            })
            const existingIds = new Set(existing.map((p) => String(p.id)))
            const newMapped = mapped.filter((m) => !existingIds.has(String(m.qdrantId)))

            if (newMapped.length > 0) {
              operations.push({
                upsert: {
                  points: newMapped.map(({ point: p, qdrantId }) => ({
                    id: qdrantId,
                    vector: { [variant]: p.embedding },
                  })),
                },
              })
            }
            operations.push({
              update_vectors: {
                points: mapped.map(({ point: p, qdrantId }) => ({
                  id: qdrantId,
                  vector: { [variant]: p.embedding },
                })),
              },
            })
          } else {
            operations.push({
              upsert: {
                points: mapped.map(({ point: p, qdrantId }) => ({
                  id: qdrantId,
                  vector: p.embedding,
                })),
              },
            })
          }

          for (const { point: p, qdrantId, original } of mapped) {
            const { set, remove } = splitQdrantMetadata(p.metadata ?? {})
            if (original) set[ID_KEY] = original
            if (Object.keys(set).length > 0) {
              operations.push({
                set_payload: { payload: set, points: [qdrantId] },
              })
            }
            if (remove.length > 0) {
              operations.push({
                delete_payload: { keys: remove, points: [qdrantId] },
              })
            }
          }

          await qdrantClient.batchUpdate(collection, {
            wait: true,
            operations,
          })
        }, retryConfig)
      }
    },

    async delete(collection, ids) {
      return withRetry(async () => {
        const qdrantClient = getClient()
        await qdrantClient.delete(collection, {
          wait: true,
          points: ids.map((id) => mapId(id).qdrantId),
        })
      }, retryConfig)
    },

    async deleteByFilter(collection, filter) {
      return withRetry(async () => {
        const qdrantClient = getClient()
        await qdrantClient.delete(collection, {
          wait: true,
          filter: transformFilter(filter),
        })
      }, retryConfig)
    },

    async updateMetadata(collection, id, metadata) {
      return withRetry(async () => {
        const qdrantClient = getClient()
        const { qdrantId } = mapId(id)
        const { set, remove } = splitQdrantMetadata(metadata)

        if (Object.keys(set).length > 0) {
          await qdrantClient.setPayload(collection, {
            wait: true,
            points: [qdrantId],
            payload: set,
          })
        }

        if (remove.length > 0) {
          await qdrantClient.deletePayload(collection, {
            wait: true,
            points: [qdrantId],
            keys: remove,
          })
        }
      }, retryConfig)
    },

    async distanceMatrix(collection, options) {
      return withRetry(async (): Promise<DistanceMatrixResult> => {
        const qdrantClient = getClient()

        let reverseMap: Map<string, string> | undefined
        const hasIdCond = options?.filter?.must?.find((c): c is HasIdCondition => 'has_id' in c)
        if (hasIdCond) {
          reverseMap = new Map(hasIdCond.has_id.map((id) => [String(mapId(id).qdrantId), id]))
        }

        const response = await qdrantClient.searchMatrixPairs(collection, {
          ...(options?.sample != null ? { sample: options.sample } : {}),
          ...(options?.limit != null ? { limit: options.limit } : {}),
          ...(options?.filter ? { filter: transformFilter(options.filter) } : {}),
          ...(options?.variant ? { using: options.variant } : {}),
        })
        const raw = response.result?.pairs ?? []

        if (!reverseMap && raw.length > 0) {
          const uniqueIds = new Set<string | number>()
          for (const p of raw) {
            uniqueIds.add(p.a)
            uniqueIds.add(p.b)
          }
          const retrieved = await qdrantClient.retrieve(collection, {
            ids: Array.from(uniqueIds),
            with_payload: true,
            with_vector: false,
          })
          reverseMap = new Map(
            (retrieved ?? []).map(
              (pt: { id: string | number; payload?: Record<string, unknown> }) => [
                String(pt.id),
                recoverOriginalId(pt.id, pt.payload),
              ],
            ),
          )
        }

        const pairs = raw.map((p: { a: string | number; b: string | number; score: number }) => ({
          a: reverseMap?.get(String(p.a)) ?? String(p.a),
          b: reverseMap?.get(String(p.b)) ?? String(p.b),
          score: p.score,
        }))
        return { pairs }
      }, retryConfig)
    },

    async get(collection, ids, _options) {
      return withRetry(async () => {
        const qdrantClient = getClient()
        const mappings = ids.map((id) => ({ id, ...mapId(id) }))
        const qdrantIds = mappings.map((m) => m.qdrantId)

        const response = await qdrantClient.retrieve(collection, {
          ids: qdrantIds,
          with_payload: true,
          with_vector: false,
        })

        const byQdrantId = new Map(
          (response ?? []).map((p: { id: string | number; payload?: Record<string, unknown> }) => [
            String(p.id),
            mapPoint(p),
          ]),
        )

        return mappings.map(({ qdrantId, id }) => {
          const result = byQdrantId.get(String(qdrantId))
          if (!result) throw new Error(`Point "${id}" not found in collection`)
          return result
        })
      }, retryConfig)
    },

    async scroll(collection, options): Promise<ScrollResult> {
      return withRetry(async () => {
        const qdrantClient = getClient()
        const variant = options?.variant
        const response = await qdrantClient.scroll(collection, {
          limit: options?.limit ?? 100,
          ...(options?.offset ? { offset: mapId(options.offset).qdrantId } : {}),
          ...(options?.filter ? { filter: transformFilter(options.filter) } : {}),
          with_payload: true,
          with_vector: options?.includeVectors ? (variant ? [variant] : true) : false,
        })

        const result = response.result ?? response
        const rawPoints = result.points ?? []

        const points: ScrollResult['points'] = rawPoints.map(
          (p: {
            id: string | number
            payload?: Record<string, unknown>
            vector?: number[] | Record<string, number[]>
          }) => {
            const point: ScrollResult['points'][number] = mapPoint(p)
            if (options?.includeVectors && p.vector) {
              if (Array.isArray(p.vector)) {
                point.embedding = p.vector
              } else if (variant && p.vector[variant]) {
                point.embedding = p.vector[variant]
              }
            }
            return point
          },
        )

        const nextOffset = result.next_page_offset
        return {
          points,
          ...(nextOffset != null ? { nextOffset: String(nextOffset) } : {}),
        }
      }, retryConfig)
    },

    async count(collection, options): Promise<number> {
      return withRetry(async () => {
        const qdrantClient = getClient()
        const response = await qdrantClient.count(collection, {
          ...(options?.filter ? { filter: transformFilter(options.filter) } : {}),
          exact: true,
        })
        const result = response.result ?? response
        return result.count ?? 0
      }, retryConfig)
    },

    async close() {
      client = null
    },
  }
}

interface QdrantScoredPoint {
  id: string | number
  score?: number
  payload?: Record<string, unknown>
}

interface QdrantClientType {
  query(
    collection: string,
    opts: Record<string, unknown>,
  ): Promise<{ points?: QdrantScoredPoint[] }>
  upsert(collection: string, opts: Record<string, unknown>): Promise<unknown>
  batchUpdate(collection: string, opts: Record<string, unknown>): Promise<unknown>
  delete(collection: string, opts: Record<string, unknown>): Promise<unknown>
  setPayload(collection: string, opts: Record<string, unknown>): Promise<unknown>
  deletePayload(collection: string, opts: Record<string, unknown>): Promise<unknown>
  searchMatrixPairs(
    collection: string,
    opts: Record<string, unknown>,
  ): Promise<{
    result?: {
      pairs?: Array<{ a: string | number; b: string | number; score: number }>
    }
  }>
  retrieve(
    collection: string,
    opts: Record<string, unknown>,
  ): Promise<Array<{ id: string | number; payload?: Record<string, unknown> }>>
  scroll(
    collection: string,
    opts: Record<string, unknown>,
  ): Promise<{
    result?: {
      points?: Array<{
        id: string | number
        payload?: Record<string, unknown>
        vector?: number[] | Record<string, number[]>
      }>
      next_page_offset?: string | number | null
    }
    points?: Array<{
      id: string | number
      payload?: Record<string, unknown>
      vector?: number[] | Record<string, number[]>
    }>
    next_page_offset?: string | number | null
  }>
  count(
    collection: string,
    opts: Record<string, unknown>,
  ): Promise<{
    result?: { count?: number }
    count?: number
  }>
}
