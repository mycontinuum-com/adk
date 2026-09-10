export { memory, collectionSpec, normalizeFilter } from './memory'

export { pgvector } from './providers/pgvector'
export { inMemoryIndex } from './providers/inMemoryIndex'
export { sqliteVec } from './providers/sqliteVec'

export type {
  Memory,
  MemoryVariant,
  MemoryConfig,
  MetadataUpdate,
  EmbeddingModel,
  VoyageModel,
  QdrantConfig,
  PgVectorConfig,
  Embedder,
  VectorIndex,
  VectorFilter,
  FilterInput,
  VectorCondition,
  Match,
  GetResult,
  SearchResult,
  SearchOptions,
  ScrollResult,
  SampleOptions,
  SampleResult,
  SlicedSampleResult,
  CollectionSpec,
  UpsertItem,
  SliceConfig,
  SlicedMemoryConfig,
  SlicedMemory,
  SlicedVariantAccessor,
  SliceAccessor,
  SlicedMatchUnion,
  SlicedSearchResult,
  SlicedGetUnion,
  PgPool,
} from './types'
