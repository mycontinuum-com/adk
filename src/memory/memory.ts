import type { z } from 'zod'

import type { ContextRenderer, FunctionTool } from '../types/runnables'
import type {
  Memory,
  MemoryVariant,
  MemoryConfig,
  CollectionSpec,
  Embedder,
  VectorIndex,
  VectorFilter,
  VectorCondition,
  FilterInput,
  VoyageModel,
  QdrantConfig,
  PgVectorConfig,
  SqliteVecConfig,
  EmbeddingModel,
  SearchOptions,
  SearchResult,
  ScrollResult,
  SampleOptions,
  SampleResult,
  UpsertItem,
  Match,
  Point,
  GetResult,
  MetadataUpdate,
  ContextConfig,
  ToolConfig,
  DistanceMatrixPair,
  SliceConfig,
  SlicedMemoryConfig,
  SlicedMemory,
  SlicedSubset,
  SlicedVariantAccessor,
  SliceAccessor,
  InferSliceMeta,
} from './types'

import { EMBEDDER, INDEX, getSymbol } from '../core/adapter-symbol'
import { createMemoryContext } from './context'
import { normalizeFilter } from './filter'
import { createPgVectorIndex } from './providers/pgvector'
import { representativeSample, representativeSampleFromVectors } from './sample'
import { createMemoryTool } from './tool'

function isPgVectorConfig(obj: unknown): obj is PgVectorConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).provider === 'pgvector'
  )
}

function isVoyageConfig(obj: unknown): obj is VoyageModel {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).provider === 'voyage'
  )
}

function isSqliteVecConfig(obj: unknown): obj is SqliteVecConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).provider === 'sqlite-vec'
  )
}

function lazySqliteVecIndex(config: SqliteVecConfig): VectorIndex {
  return lazyProxy<VectorIndex>(async () => {
    const { createSqliteVecIndex } = await import('./providers/sqliteVec.js')
    return createSqliteVecIndex(config)
  })
}

function isQdrantConfig(obj: unknown): obj is QdrantConfig {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).provider === 'qdrant'
  )
}

function resolveEmbedder(model: EmbeddingModel): Embedder {
  const factory = getSymbol<(m: EmbeddingModel) => Embedder>(model, EMBEDDER)
  if (factory) return factory(model)
  if (isVoyageConfig(model)) return lazyVoyageEmbedder(model)
  return model as Embedder
}

function lazyVoyageEmbedder(model: VoyageModel): Embedder {
  const proxy = lazyProxy<Embedder>(async () => {
    const { createVoyageEmbedder } = await import('./providers/voyage.js')
    return createVoyageEmbedder(model)
  })
  return { dimensions: model.dimensions, modelName: model.name, embed: proxy.embed }
}

function resolveIndex(
  index: VectorIndex | QdrantConfig | PgVectorConfig | SqliteVecConfig,
): VectorIndex {
  const factory = getSymbol<(i: typeof index) => VectorIndex>(index, INDEX)
  if (factory) return factory(index)
  if (isQdrantConfig(index)) return lazyQdrantIndex(index)
  if (isPgVectorConfig(index)) return createPgVectorIndex(index)
  if (isSqliteVecConfig(index)) return lazySqliteVecIndex(index)
  return index as VectorIndex
}

function lazyProxy<T extends object>(load: () => Promise<T>): T {
  // The in-flight promise is what is memoized, never the resolved value: concurrent first calls
  // must share one load, or each would get its own provider instance (its own database for
  // ':memory:' backends) and writes would silently split between them.
  let loading: Promise<T> | undefined
  return new Proxy({} as T, {
    get(_, prop) {
      return async (...args: unknown[]) => {
        // Closing what was never opened is a no-op — not a reason to instantiate the provider.
        if (prop === 'close' && loading === undefined) return undefined
        const resolved = await (loading ??= load())
        return (resolved as any)[prop](...args)
      }
    },
  })
}

function lazyQdrantIndex(config: QdrantConfig): VectorIndex {
  return lazyProxy<VectorIndex>(async () => {
    const { createQdrantIndex } = await import('./providers/qdrant.js')
    return createQdrantIndex(config)
  })
}

const EMBED_BATCH_SIZE = 128
const MATRIX_THRESHOLD = 256
const VARIANT_PREFIX = '_variant_'
const SLICE_PREFIX = '_slice_'
const SLICE_KIND_KEY = '_slice_kind'

function contentKey(variantName: string): string {
  return `${VARIANT_PREFIX}${variantName}`
}

function isReservedKey(key: string): boolean {
  return key === '_original_id' || key.startsWith(VARIANT_PREFIX) || key.startsWith(SLICE_PREFIX)
}

function extractContent(
  metadata: Record<string, unknown>,
  variantName: string,
): {
  content: string
  kind: string | undefined
  cleaned: Record<string, unknown>
} {
  const key = contentKey(variantName)
  const content = typeof metadata[key] === 'string' ? (metadata[key] as string) : ''
  const kind =
    typeof metadata[SLICE_KIND_KEY] === 'string' ? (metadata[SLICE_KIND_KEY] as string) : undefined
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (!isReservedKey(k)) {
      cleaned[k] = v
    }
  }
  return { content, kind, cleaned }
}

export { normalizeFilter } from './filter'

function isAsymmetric(
  model: MemoryConfig['model'],
): model is { index: EmbeddingModel; query: EmbeddingModel } {
  return typeof model === 'object' && model !== null && 'index' in model && 'query' in model
}

function vectorKey(modelName: string | undefined, variantName: string): string {
  return modelName != null && modelName !== '' ? `${modelName}_${variantName}` : variantName
}

/**
 * Compute the vector/index specification for a collection without creating anything. The returned
 * {@link CollectionSpec} drives provisioning scripts, Terraform generators, or migration jobs.
 *
 * `slices` accepts the same slice config you pass to {@link memory} (e.g. `{ medication: { metadata:
 * z.object({…}) }, problem: {} }`). Only the presence of slice keys is used — the metadata schemas
 * themselves are not inspected — so you can share a single config object between `memory()` and
 * `collectionSpec()`.
 */
export function collectionSpec(config: {
  model: MemoryConfig['model']
  collection: string
  variants?: string[]
  slices?: Record<string, SliceConfig>
}): CollectionSpec {
  const variantNames = config.variants ?? ['default']
  const indexEmbedder = isAsymmetric(config.model)
    ? resolveEmbedder(config.model.index)
    : resolveEmbedder(config.model)

  const vectors: Record<string, { dimensions: number; distance: 'Cosine' }> = {}
  for (const name of variantNames) {
    vectors[vectorKey(indexEmbedder.modelName, name)] = {
      dimensions: indexEmbedder.dimensions,
      distance: 'Cosine',
    }
  }

  const textIndexes = variantNames.map((name) => contentKey(name))
  const payloadIndexes = config.slices ? [SLICE_KIND_KEY] : undefined

  return {
    collection: config.collection,
    vectors,
    textIndexes,
    ...(payloadIndexes ? { payloadIndexes } : {}),
  }
}

function createVariant<TMetadata extends Record<string, unknown>>(opts: {
  embedder: Embedder | { index: Embedder; query: Embedder }
  vectorIndex: VectorIndex
  collection: string
  variantName: string
  contentVariantName?: string
  metadataSchema?: z.ZodType<TMetadata>
  injectMetadata?: Record<string, unknown>
  injectFilter?: VectorCondition | VectorFilter
  variantNames?: string[]
}): MemoryVariant<TMetadata> {
  const { embedder, vectorIndex, collection, variantName, metadataSchema } = opts
  const contentVarName = opts.contentVariantName ?? variantName
  const queryEmbedder = 'query' in embedder ? embedder.query : embedder
  const indexEmbedder = 'index' in embedder ? embedder.index : embedder
  const expectedDimensions = indexEmbedder.dimensions
  const vectorName = vectorKey(indexEmbedder.modelName, variantName)

  function validateMetadata(metadata: TMetadata): TMetadata {
    if (metadataSchema) {
      return metadataSchema.parse(metadata) as TMetadata
    }
    return metadata
  }

  function validateEmbeddings(
    embeddings: number[][],
    expectedCount: number,
    operation: string,
  ): number[][] {
    if (embeddings.length !== expectedCount) {
      throw new Error(
        `${operation} expected ${expectedCount} embedding${expectedCount === 1 ? '' : 's'}, got ${embeddings.length}.`,
      )
    }
    for (let i = 0; i < embeddings.length; i++) {
      if (embeddings[i].length !== expectedDimensions) {
        throw new Error(
          `${operation} embedding dimension mismatch at index ${i}: got ${embeddings[i].length}, expected ${expectedDimensions}.`,
        )
      }
    }
    return embeddings
  }

  async function search(text: string, options?: SearchOptions): Promise<SearchResult<TMetadata>> {
    let filter: VectorFilter | undefined = normalizeFilter(options?.filter)
    if (opts.injectFilter) {
      filter = {
        ...filter,
        must: [...(filter?.must ?? []), opts.injectFilter],
      }
    }
    if (options?.contains) {
      const cond: VectorCondition = {
        key: contentKey(variantName),
        text: { contains: options.contains },
      }
      filter = { ...filter, must: [...(filter?.must ?? []), cond] }
    }

    const result = await queryEmbedder.embed([text], {
      inputType: 'query',
    })
    const embedding = validateEmbeddings(result.embeddings, 1, 'search')[0]

    const rawMatches = await vectorIndex.search(collection, embedding, {
      topK: options?.topK,
      filter,
      variant: vectorName,
      minScore: options?.minScore,
    })

    const matches: Match<TMetadata>[] = rawMatches.map((m) => {
      const { content, kind, cleaned } = extractContent(
        m.metadata as Record<string, unknown>,
        contentVarName,
      )
      return {
        id: m.id,
        score: m.score,
        content,
        kind,
        metadata: cleaned as TMetadata,
      }
    })

    return { matches, embedding }
  }

  async function get(ids: string[]): Promise<GetResult<TMetadata>[]> {
    if (ids.length === 0) return []
    const points = await vectorIndex.get(collection, ids, {
      variant: vectorName,
    })
    return points.map((p) => {
      const { content, kind, cleaned } = extractContent(
        p.metadata as Record<string, unknown>,
        contentVarName,
      )
      return {
        id: p.id,
        content,
        kind,
        metadata: cleaned as TMetadata,
      }
    })
  }

  return {
    context(config: ContextConfig<TMetadata>): ContextRenderer {
      return createMemoryContext({ ...config, search })
    },

    tool(config: ToolConfig<TMetadata>): FunctionTool {
      return createMemoryTool({ ...config, search })
    },

    returning(name: string): MemoryVariant<TMetadata> {
      if (opts.variantNames && !opts.variantNames.includes(name)) {
        throw new Error(
          `Unknown variant "${name}". Available variants: ${opts.variantNames.join(', ')}`,
        )
      }
      return createVariant<TMetadata>({ ...opts, contentVariantName: name })
    },

    search,
    get,

    async upsert(items: UpsertItem<TMetadata> | UpsertItem<TMetadata>[]): Promise<void> {
      const arr = Array.isArray(items) ? items : [items]
      if (arr.length === 0) return

      for (const item of arr) {
        if (item.metadata) {
          for (const key of Object.keys(item.metadata as Record<string, unknown>)) {
            if (isReservedKey(key)) {
              throw new Error(`Metadata key "${key}" is reserved for internal use.`)
            }
          }
        }
      }

      const needsEmbedding = arr.filter((item) => item.embedding == null)
      const hasEmbedding = arr.filter((item) => item.embedding != null)

      const embeddedItems: Array<{
        id: string
        content: string
        embedding: number[]
        metadata?: TMetadata
      }> = []

      for (let i = 0; i < needsEmbedding.length; i += EMBED_BATCH_SIZE) {
        const chunk = needsEmbedding.slice(i, i + EMBED_BATCH_SIZE)
        const texts = chunk.map((item) => item.content)
        const result = await indexEmbedder.embed(texts, {
          inputType: 'document',
        })
        const embeddings = validateEmbeddings(result.embeddings, chunk.length, 'upsert')
        for (let j = 0; j < chunk.length; j++) {
          embeddedItems.push({
            id: chunk[j].id,
            content: chunk[j].content,
            embedding: embeddings[j],
            metadata: chunk[j].metadata ? validateMetadata(chunk[j].metadata!) : undefined,
          })
        }
      }

      const precomputedItems = hasEmbedding.map((item) => {
        if (item.embedding!.length !== expectedDimensions) {
          throw new Error(
            `Embedding dimension mismatch for "${item.id}": got ${item.embedding!.length}, expected ${expectedDimensions}.`,
          )
        }
        return {
          id: item.id,
          content: item.content,
          embedding: item.embedding!,
          metadata: item.metadata ? validateMetadata(item.metadata) : undefined,
        }
      })

      const allItems = [...embeddedItems, ...precomputedItems]
      const cKey = contentKey(variantName)

      const points: Point[] = allItems.map((item) => ({
        id: item.id,
        embedding: item.embedding,
        metadata: {
          ...(item.metadata as Record<string, unknown>),
          ...opts.injectMetadata,
          [cKey]: item.content,
        },
      }))

      await vectorIndex.upsert(collection, points, { variant: vectorName })
    },

    async updateMetadata(id: string, metadata: MetadataUpdate<TMetadata>): Promise<void> {
      const update = metadata as Record<string, unknown>
      for (const key of Object.keys(update)) {
        if (isReservedKey(key)) {
          throw new Error(
            `Cannot modify reserved key "${key}" via updateMetadata. Use upsert() to change content.`,
          )
        }
      }
      await vectorIndex.updateMetadata(collection, id, update)
    },

    async deleteByFilter(filter: FilterInput): Promise<void> {
      let normalizedFilter = normalizeFilter(filter)
      if (opts.injectFilter) {
        normalizedFilter = {
          ...normalizedFilter,
          must: [...(normalizedFilter?.must ?? []), opts.injectFilter],
        }
      }
      if (!normalizedFilter) return
      await vectorIndex.deleteByFilter(collection, normalizedFilter)
    },

    async sample(n: number, options?: SampleOptions): Promise<SampleResult<TMetadata>> {
      const pool = options?.pool ?? n * 5
      if (n > pool) {
        throw new Error(`Cannot sample ${n} from pool of ${pool}`)
      }
      if (n <= 0) {
        return { matches: [] }
      }

      let normalizedFilter = normalizeFilter(options?.filter)
      if (opts.injectFilter) {
        normalizedFilter = {
          ...normalizedFilter,
          must: [...(normalizedFilter?.must ?? []), opts.injectFilter],
        }
      }

      let pairs: DistanceMatrixPair[] = []
      let vectorMap: Map<string, number[]> | undefined
      let weights: Map<string, number> | undefined
      let embedding: number[] | undefined
      let candidateIds: string[] | undefined

      const useLocalDiversity = pool > MATRIX_THRESHOLD * 5

      if (options?.query) {
        const embedResult = await queryEmbedder.embed([options.query], {
          inputType: 'query',
        })
        embedding = validateEmbeddings(embedResult.embeddings, 1, 'sample')[0]
        const searchMatches = await vectorIndex.search(collection, embedding, {
          topK: pool,
          filter: normalizedFilter,
          variant: vectorName,
        })
        candidateIds = searchMatches.map((m) => m.id)
        weights = new Map(searchMatches.map((m) => [m.id, Math.pow(m.score, options.gravity ?? 1)]))

        if (useLocalDiversity) {
          const scrollResult = await vectorIndex.scroll(collection, {
            filter: {
              must: [{ has_id: candidateIds }, ...(normalizedFilter?.must ?? [])],
            },
            variant: vectorName,
            limit: candidateIds.length,
            includeVectors: true,
          })
          vectorMap = new Map<string, number[]>()
          for (const p of scrollResult.points) {
            if (p.embedding) vectorMap.set(p.id, p.embedding)
          }
        } else {
          const matrixResult = await vectorIndex.distanceMatrix(collection, {
            filter: {
              must: [{ has_id: candidateIds }, ...(normalizedFilter?.must ?? [])],
            },
            sample: candidateIds.length,
            limit: Math.max(0, candidateIds.length - 1),
            variant: vectorName,
          })
          pairs = matrixResult.pairs
        }
      } else if (useLocalDiversity) {
        let scrolled: ScrollResult['points'] = []
        let offset: string | undefined
        const batchSize = Math.min(pool, 1000)
        while (scrolled.length < pool) {
          const result = await vectorIndex.scroll(collection, {
            filter: normalizedFilter,
            variant: vectorName,
            limit: Math.min(batchSize, pool - scrolled.length),
            offset,
            includeVectors: true,
          })
          scrolled = scrolled.concat(result.points)
          if (!result.nextOffset || result.points.length === 0) break
          offset = result.nextOffset
        }
        vectorMap = new Map<string, number[]>()
        for (const p of scrolled) {
          if (p.embedding) vectorMap.set(p.id, p.embedding)
        }
        candidateIds = scrolled.map((p) => p.id)
      } else {
        const matrixResult = await vectorIndex.distanceMatrix(collection, {
          sample: pool,
          limit: pool - 1,
          filter: normalizedFilter,
          variant: vectorName,
        })
        pairs = matrixResult.pairs
      }

      if (pairs.length === 0 && !vectorMap && !candidateIds) {
        const fallback = await vectorIndex.scroll(collection, {
          filter: normalizedFilter,
          variant: vectorName,
          limit: pool,
        })
        candidateIds = fallback.points.map((p) => p.id)
      }

      const available = new Set<string>()
      if (vectorMap) {
        vectorMap.forEach((_, id) => available.add(id))
      } else if (candidateIds) {
        for (const id of candidateIds) available.add(id)
      }
      for (const p of pairs) {
        available.add(p.a)
        available.add(p.b)
      }
      if (n > available.size) {
        throw new Error(
          `Cannot sample ${n}: only ${available.size} points available in "${collection}" (requested pool: ${pool})`,
        )
      }

      let selectedIds: string[]
      if (vectorMap && vectorMap.size > 0) {
        selectedIds = representativeSampleFromVectors(
          vectorMap,
          n,
          weights ? { weights } : undefined,
        )
      } else if (pairs.length > 0) {
        selectedIds = representativeSample(pairs, n, weights ? { weights } : undefined)
      } else {
        const ids = candidateIds ?? Array.from(available)
        selectedIds = weights
          ? ids
              .slice()
              .toSorted((a, b) => (weights!.get(b) ?? 1) - (weights!.get(a) ?? 1))
              .slice(0, n)
          : ids.slice(0, n)
      }

      const points = await vectorIndex.get(collection, selectedIds, {
        variant: vectorName,
      })
      const idToData = new Map(
        points.map((p) => {
          const { content, kind, cleaned } = extractContent(p.metadata, contentVarName)
          return [p.id, { content, kind, metadata: cleaned as TMetadata }] as const
        }),
      )
      const matches: Match<TMetadata>[] = selectedIds.map((id) => {
        const data = idToData.get(id)
        return {
          id,
          score: weights?.get(id) ?? 1,
          content: data?.content ?? '',
          kind: data?.kind,
          metadata: data?.metadata ?? ({} as TMetadata),
        }
      })
      return embedding != null ? { matches, embedding } : { matches }
    },
  }
}

export function memory<TSlices extends Record<string, SliceConfig>>(
  config: SlicedMemoryConfig<TSlices>,
): SlicedMemory<TSlices>
export function memory<TMetadata extends Record<string, unknown> = Record<string, unknown>>(
  config: MemoryConfig<TMetadata>,
): Memory<TMetadata>
export function memory(
  config: MemoryConfig | SlicedMemoryConfig<Record<string, SliceConfig>>,
): Memory | SlicedMemory<Record<string, SliceConfig>> {
  if ('slices' in config && config.slices) {
    return createSlicedMemory(config as SlicedMemoryConfig<Record<string, SliceConfig>>)
  }
  return createNonSlicedMemory(config as MemoryConfig)
}

function resolveEmbedders(
  model: MemoryConfig['model'],
): Embedder | { index: Embedder; query: Embedder } {
  if (isAsymmetric(model)) {
    const indexEmbedder = resolveEmbedder(model.index)
    const queryEmbedder = resolveEmbedder(model.query)
    if (indexEmbedder.dimensions !== queryEmbedder.dimensions) {
      throw new Error(
        `Asymmetric embedding dimension mismatch: index (${indexEmbedder.dimensions}) !== query (${queryEmbedder.dimensions}).`,
      )
    }
    return { index: indexEmbedder, query: queryEmbedder }
  }
  return resolveEmbedder(model)
}

function getIndexEmbedder(embedder: Embedder | { index: Embedder; query: Embedder }): Embedder {
  return 'index' in embedder ? embedder.index : embedder
}

function createCollectionOps(
  resolvedIndex: VectorIndex,
  collection: string,
  defaultVectorName: string,
) {
  return {
    async delete(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      await resolvedIndex.delete(collection, ids)
    },
    async scroll(options?: {
      filter?: FilterInput
      limit?: number
      offset?: string
      includeVectors?: boolean
    }): Promise<ScrollResult> {
      return resolvedIndex.scroll(collection, {
        ...options,
        filter: normalizeFilter(options?.filter),
        variant: defaultVectorName,
      })
    },
    async count(options?: { filter?: FilterInput }): Promise<number> {
      return resolvedIndex.count(collection, {
        ...options,
        filter: normalizeFilter(options?.filter),
        variant: defaultVectorName,
      })
    },
    async close(): Promise<void> {
      await resolvedIndex.close?.()
    },
  }
}

function createSlicedMemory<TSlices extends Record<string, SliceConfig>>(
  config: SlicedMemoryConfig<TSlices>,
): SlicedMemory<TSlices> {
  const resolvedIndex = resolveIndex(config.index)
  const resolvedEmbedder = resolveEmbedders(config.model)
  const variantNames = config.variants ?? ['default']
  const defaultVariantName = variantNames[0]
  const defaultVectorName = vectorKey(
    getIndexEmbedder(resolvedEmbedder).modelName,
    defaultVariantName,
  )

  const sliceMap = {} as {
    [K in keyof TSlices & string]: SliceAccessor<InferSliceMeta<TSlices[K]>>
  }

  for (const sliceName of Object.keys(config.slices) as (keyof TSlices & string)[]) {
    const sliceConfig = config.slices[sliceName]
    const sliceFilter: VectorCondition = {
      key: SLICE_KIND_KEY,
      match: { value: sliceName },
    }
    const sliceInject = { [SLICE_KIND_KEY]: sliceName }

    const sliceVariants: Record<
      string,
      MemoryVariant<InferSliceMeta<TSlices[typeof sliceName]>>
    > = {}
    for (const vName of variantNames) {
      sliceVariants[vName] = createVariant<InferSliceMeta<TSlices[typeof sliceName]>>({
        embedder: resolvedEmbedder,
        vectorIndex: resolvedIndex,
        collection: config.collection,
        variantName: vName,
        metadataSchema: sliceConfig.metadata as
          | z.ZodType<InferSliceMeta<TSlices[typeof sliceName]>>
          | undefined,
        injectMetadata: sliceInject,
        injectFilter: sliceFilter,
        variantNames,
      })
    }

    sliceMap[sliceName] = {
      ...sliceVariants[defaultVariantName],
      variant: sliceVariants,
    } as SliceAccessor<InferSliceMeta<TSlices[typeof sliceName]>>
  }

  const crossTypeVariants: Record<string, MemoryVariant<Record<string, unknown>>> = {}
  for (const vName of variantNames) {
    crossTypeVariants[vName] = createVariant<Record<string, unknown>>({
      embedder: resolvedEmbedder,
      vectorIndex: resolvedIndex,
      collection: config.collection,
      variantName: vName,
      variantNames,
    })
  }

  const defaultCross = crossTypeVariants[defaultVariantName]

  function wrapCrossTypeVariant(
    v: MemoryVariant<Record<string, unknown>>,
  ): SlicedVariantAccessor<TSlices> {
    return {
      search: v.search as unknown as SlicedVariantAccessor<TSlices>['search'],
      sample: v.sample as unknown as SlicedVariantAccessor<TSlices>['sample'],
      get: v.get as unknown as SlicedVariantAccessor<TSlices>['get'],
      deleteByFilter: v.deleteByFilter,
      context: v.context as unknown as SlicedVariantAccessor<TSlices>['context'],
      tool: v.tool as unknown as SlicedVariantAccessor<TSlices>['tool'],
      returning(name: string) {
        return wrapCrossTypeVariant(v.returning(name))
      },
    }
  }

  const variantMap: Record<string, SlicedVariantAccessor<TSlices>> = {}
  for (const vName of variantNames) {
    variantMap[vName] = wrapCrossTypeVariant(crossTypeVariants[vName])
  }

  function createSubset<K extends keyof TSlices & string>(
    names: K[],
  ): SlicedSubset<Pick<TSlices, K>> {
    const sliceFilter: VectorFilter = {
      should: names.map((n) => ({
        key: SLICE_KIND_KEY,
        match: { value: n },
      })),
    }
    const subset = createVariant<Record<string, unknown>>({
      embedder: resolvedEmbedder,
      vectorIndex: resolvedIndex,
      collection: config.collection,
      variantName: defaultVariantName,
      injectFilter: sliceFilter,
      variantNames,
    })
    return {
      search: subset.search as unknown as SlicedSubset<Pick<TSlices, K>>['search'],
      sample: subset.sample as unknown as SlicedSubset<Pick<TSlices, K>>['sample'],
      get: subset.get as unknown as SlicedSubset<Pick<TSlices, K>>['get'],
      deleteByFilter: subset.deleteByFilter,
      context: subset.context as unknown as SlicedSubset<Pick<TSlices, K>>['context'],
      tool: subset.tool as unknown as SlicedSubset<Pick<TSlices, K>>['tool'],
    }
  }

  return {
    embedder: resolvedEmbedder,
    index: resolvedIndex,
    collection: config.collection,
    slice: sliceMap,
    slices: createSubset,
    variant: variantMap,
    search: defaultCross.search as unknown as SlicedMemory<TSlices>['search'],
    sample: defaultCross.sample as unknown as SlicedMemory<TSlices>['sample'],
    get: defaultCross.get as unknown as SlicedMemory<TSlices>['get'],
    deleteByFilter: defaultCross.deleteByFilter,
    context: defaultCross.context as unknown as SlicedMemory<TSlices>['context'],
    tool: defaultCross.tool as unknown as SlicedMemory<TSlices>['tool'],
    ...createCollectionOps(resolvedIndex, config.collection, defaultVectorName),
  }
}

function createNonSlicedMemory<TMetadata extends Record<string, unknown> = Record<string, unknown>>(
  config: MemoryConfig<TMetadata>,
): Memory<TMetadata> {
  const resolvedIndex = resolveIndex(config.index)
  const resolvedEmbedder = resolveEmbedders(config.model)
  const variantNames = config.variants ?? ['default']
  const defaultVectorName = vectorKey(getIndexEmbedder(resolvedEmbedder).modelName, variantNames[0])

  const variantMap: Record<string, MemoryVariant<TMetadata>> = {}
  for (const name of variantNames) {
    variantMap[name] = createVariant<TMetadata>({
      embedder: resolvedEmbedder,
      vectorIndex: resolvedIndex,
      collection: config.collection,
      variantName: name,
      metadataSchema: config.metadata,
      variantNames,
    })
  }

  const defaultVariant = variantMap[variantNames[0]]

  return {
    embedder: resolvedEmbedder,
    index: resolvedIndex,
    collection: config.collection,
    variant: variantMap,
    context: defaultVariant.context,
    tool: defaultVariant.tool,
    returning: defaultVariant.returning,
    search: defaultVariant.search,
    sample: defaultVariant.sample,
    get: defaultVariant.get,
    upsert: defaultVariant.upsert,
    updateMetadata: defaultVariant.updateMetadata,
    deleteByFilter: defaultVariant.deleteByFilter,
    ...createCollectionOps(resolvedIndex, config.collection, defaultVectorName),
  }
}
