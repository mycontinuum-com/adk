import type { z } from 'zod'

import type { RetryConfig } from '../types/runnables'
import type { ContextRenderer, RenderContext, FunctionTool } from '../types/runnables'

// ---------------------------------------------------------------------------
// Filter types — shared across all providers
// ---------------------------------------------------------------------------

export interface VectorCondition {
  key: string
  match?: { value: unknown }
  text?: { contains: string | string[] }
  range?: {
    gt?: number | string
    gte?: number | string
    lt?: number | string
    lte?: number | string
  }
}

export interface HasIdCondition {
  has_id: string[]
}

export interface VectorFilter {
  must?: (VectorCondition | HasIdCondition | VectorFilter)[]
  should?: (VectorCondition | VectorFilter)[]
  must_not?: (VectorCondition | VectorFilter)[]
}

export type FilterInput = VectorFilter | Record<string, string | number | boolean>

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

export interface VoyageSageMakerConfig {
  endpointName: string
  region?: string
}

export interface VoyageModel {
  provider: 'voyage'
  name: string
  dimensions: number
  apiKey?: string
  outputFormat?: 'float' | 'int8' | 'binary'
  batchSize?: number
  retry?: RetryConfig
  sagemaker?: VoyageSageMakerConfig
}

export interface QdrantConfig {
  provider: 'qdrant'
  url: string
  apiKey?: string
  batchSize?: number
  retry?: RetryConfig
}

export interface PgPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  end?(): Promise<void>
  on?(event: 'error', listener: (err: Error) => void): void
}

export interface PgVectorConfig {
  provider: 'pgvector'
  connectionString: string
  schema?: string
  pool?: PgPool
  batchSize?: number
  retry?: RetryConfig
}

export interface SqliteVecConfig {
  provider: 'sqlite-vec'
  /** Database file path; `':memory:'` for an ephemeral index. */
  path: string
}

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface Embedder {
  readonly dimensions: number
  readonly modelName?: string
  embed(input: string[], options?: { inputType?: 'query' | 'document' }): Promise<EmbedResult>
}

export interface EmbedResult {
  embeddings: number[][]
  model: string
  usage?: { totalTokens: number }
}

/**
 * Write operation semantics: - `upsert`: named vectors not in the payload are preserved. Metadata
 * uses merge semantics — provided keys are merged into existing metadata, omitted keys are
 * preserved. - `updateMetadata`: provided keys are merged, `null` values delete the key.
 */
export interface DistanceMatrixPair {
  a: string
  b: string
  score: number
}

export interface DistanceMatrixResult {
  pairs: DistanceMatrixPair[]
}

export interface VectorIndex {
  search(
    collection: string,
    embedding: number[],
    options?: {
      topK?: number
      filter?: VectorFilter
      variant?: string
      minScore?: number
    },
  ): Promise<VectorMatch[]>
  upsert(collection: string, points: Point[], options?: { variant?: string }): Promise<void>
  delete(collection: string, ids: string[]): Promise<void>
  deleteByFilter(collection: string, filter: VectorFilter): Promise<void>
  updateMetadata(collection: string, id: string, metadata: Record<string, unknown>): Promise<void>
  distanceMatrix(
    collection: string,
    options?: {
      sample?: number
      limit?: number
      filter?: VectorFilter
      variant?: string
    },
  ): Promise<DistanceMatrixResult>
  get(
    collection: string,
    ids: string[],
    options?: { variant?: string },
  ): Promise<Array<{ id: string; metadata: Record<string, unknown> }>>
  scroll(
    collection: string,
    options?: {
      filter?: VectorFilter
      limit?: number
      offset?: string
      variant?: string
      includeVectors?: boolean
    },
  ): Promise<ScrollResult>
  count(
    collection: string,
    options?: {
      filter?: VectorFilter
      variant?: string
    },
  ): Promise<number>
  close?(): Promise<void>
}

export interface ScrollResult {
  points: Array<{
    id: string
    metadata: Record<string, unknown>
    embedding?: number[]
  }>
  nextOffset?: string
}

export interface VectorMatch<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  score: number
  metadata: TMetadata
}

export interface Match<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends VectorMatch<TMetadata> {
  content: string
  kind?: string
}

export interface Point {
  id: string
  embedding: number[]
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Memory config and options
// ---------------------------------------------------------------------------

export type EmbeddingModel = Embedder | VoyageModel

export type MetadataUpdate<T> = { [K in keyof T]?: T[K] | null }

export interface MemoryConfig<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  model: EmbeddingModel | { index: EmbeddingModel; query: EmbeddingModel }
  index: VectorIndex | QdrantConfig | PgVectorConfig | SqliteVecConfig
  collection: string
  variants?: string[]
  metadata?: z.ZodType<TMetadata>
}

export interface SearchOptions {
  topK?: number
  filter?: FilterInput
  minScore?: number
  contains?: string | string[]
}

export interface ContextConfig<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  query: (ctx: RenderContext) => string
  topK?: number
  filter?: FilterInput | ((ctx: RenderContext) => FilterInput)
  minScore?: number
  render?: (matches: Match<TMetadata>[]) => string
}

export interface ToolConfig<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  name?: string
  description: string
  topK?: number
  minScore?: number
  filter?: FilterInput | ((ctx: { state: Record<string, unknown> }) => FilterInput)
  render?: (matches: Match<TMetadata>[]) => string
}

export interface UpsertItem<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  content: string
  embedding?: number[]
  metadata?: TMetadata
}

export interface SearchResult<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  matches: Match<TMetadata>[]
  embedding: number[]
}

export interface SampleOptions {
  query?: string
  pool?: number
  /** 0 = pure diversity, 1 = linear relevance (default), >1 = stronger query bias. */
  gravity?: number
  filter?: FilterInput
}

export interface SampleResult<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  matches: Match<TMetadata>[]
  embedding?: number[]
}

// ---------------------------------------------------------------------------
// Collection spec
// ---------------------------------------------------------------------------

export interface CollectionSpec {
  collection: string
  vectors: Record<string, { dimensions: number; distance: 'Cosine' }>
  textIndexes: string[]
  payloadIndexes?: string[]
}

// ---------------------------------------------------------------------------
// Memory interfaces
// ---------------------------------------------------------------------------

export interface GetResult<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  content: string
  kind?: string
  metadata: TMetadata
}

export interface MemoryVariant<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  context(config: ContextConfig<TMetadata>): ContextRenderer
  tool(config: ToolConfig<TMetadata>): FunctionTool
  returning(variantName: string): MemoryVariant<TMetadata>
  search(text: string, options?: SearchOptions): Promise<SearchResult<TMetadata>>
  sample(n: number, options?: SampleOptions): Promise<SampleResult<TMetadata>>
  get(ids: string[]): Promise<GetResult<TMetadata>[]>
  upsert(items: UpsertItem<TMetadata> | UpsertItem<TMetadata>[]): Promise<void>
  updateMetadata(id: string, metadata: MetadataUpdate<TMetadata>): Promise<void>
  deleteByFilter(filter: FilterInput): Promise<void>
}

export interface Memory<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MemoryVariant<TMetadata> {
  readonly embedder: Embedder | { index: Embedder; query: Embedder }
  readonly index: VectorIndex
  readonly collection: string
  readonly variant: Record<string, MemoryVariant<TMetadata>>
  delete(ids: string[]): Promise<void>
  scroll(options?: {
    filter?: FilterInput
    limit?: number
    offset?: string
    includeVectors?: boolean
  }): Promise<ScrollResult>
  count(options?: { filter?: FilterInput }): Promise<number>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Sliced memory
// ---------------------------------------------------------------------------

export interface SliceConfig<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  metadata?: z.ZodType<TMetadata>
}

export type InferSliceMeta<T> = T extends {
  metadata: z.ZodType<infer M extends Record<string, unknown>>
}
  ? M
  : Record<string, unknown>

export type SlicedMatchUnion<TSlices> = {
  [K in keyof TSlices & string]: Match<InferSliceMeta<TSlices[K]>> & {
    kind: K
  }
}[keyof TSlices & string]

export interface SlicedSearchResult<TSlices> {
  matches: SlicedMatchUnion<TSlices>[]
  embedding: number[]
}

export interface SliceAccessor<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MemoryVariant<TMetadata> {
  readonly variant: Record<string, MemoryVariant<TMetadata>>
}

export interface SlicedMemoryConfig<TSlices extends Record<string, SliceConfig>> {
  model: EmbeddingModel | { index: EmbeddingModel; query: EmbeddingModel }
  index: VectorIndex | QdrantConfig | PgVectorConfig | SqliteVecConfig
  collection: string
  variants?: string[]
  slices: TSlices
}

export interface SlicedSampleResult<TSlices> {
  matches: SlicedMatchUnion<TSlices>[]
  embedding?: number[]
}

export type SlicedGetUnion<TSlices> = {
  [K in keyof TSlices & string]: GetResult<InferSliceMeta<TSlices[K]>> & {
    kind: K
  }
}[keyof TSlices & string]

export interface SlicedSubset<TSlices extends Record<string, SliceConfig>> {
  search(text: string, options?: SearchOptions): Promise<SlicedSearchResult<TSlices>>
  sample(n: number, options?: SampleOptions): Promise<SlicedSampleResult<TSlices>>
  get(ids: string[]): Promise<SlicedGetUnion<TSlices>[]>
  deleteByFilter(filter: FilterInput): Promise<void>
  context(
    config: ContextConfig<Record<string, unknown>> & {
      render?: (matches: SlicedMatchUnion<TSlices>[]) => string
    },
  ): ContextRenderer
  tool(
    config: ToolConfig<Record<string, unknown>> & {
      render?: (matches: SlicedMatchUnion<TSlices>[]) => string
    },
  ): FunctionTool
}

export interface SlicedVariantAccessor<
  TSlices extends Record<string, SliceConfig>,
> extends SlicedSubset<TSlices> {
  returning(variantName: string): SlicedVariantAccessor<TSlices>
}

export interface SlicedMemory<TSlices extends Record<string, SliceConfig>> {
  readonly embedder: Embedder | { index: Embedder; query: Embedder }
  readonly index: VectorIndex
  readonly collection: string
  readonly slice: {
    [K in keyof TSlices & string]: SliceAccessor<InferSliceMeta<TSlices[K]>>
  }
  slices<K extends keyof TSlices & string>(names: K[]): SlicedSubset<Pick<TSlices, K>>
  readonly variant: Record<string, SlicedVariantAccessor<TSlices>>
  search(text: string, options?: SearchOptions): Promise<SlicedSearchResult<TSlices>>
  sample(n: number, options?: SampleOptions): Promise<SlicedSampleResult<TSlices>>
  get(ids: string[]): Promise<SlicedGetUnion<TSlices>[]>
  delete(ids: string[]): Promise<void>
  deleteByFilter(filter: FilterInput): Promise<void>
  context(
    config: ContextConfig<Record<string, unknown>> & {
      render?: (matches: SlicedMatchUnion<TSlices>[]) => string
    },
  ): ContextRenderer
  tool(
    config: ToolConfig<Record<string, unknown>> & {
      render?: (matches: SlicedMatchUnion<TSlices>[]) => string
    },
  ): FunctionTool
  scroll(options?: {
    filter?: FilterInput
    limit?: number
    offset?: string
    includeVectors?: boolean
  }): Promise<ScrollResult>
  count(options?: { filter?: FilterInput }): Promise<number>
  close(): Promise<void>
}
