import type { QdrantConfig } from '../memory/types'

import { INDEX } from '../core/adapter-symbol'
import { qdrant as _qdrant, createQdrantIndex } from '../memory/providers/qdrant'

export function qdrant(config: Omit<QdrantConfig, 'provider'>): QdrantConfig {
  const result = _qdrant(config)
  Object.defineProperty(result, INDEX, { value: (c: QdrantConfig) => createQdrantIndex(c) })
  return result
}

export type { QdrantConfig } from '../memory/types'
