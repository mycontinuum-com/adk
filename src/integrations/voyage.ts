import type { VoyageModel } from '../memory/types'

import { EMBEDDER } from '../core/adapter-symbol'
import { voyage as _voyage, createVoyageEmbedder } from '../memory/providers/voyage'

export function voyage(name: string, config: Omit<VoyageModel, 'provider' | 'name'>): VoyageModel {
  const result = _voyage(name, config)
  Object.defineProperty(result, EMBEDDER, { value: (c: VoyageModel) => createVoyageEmbedder(c) })
  return result
}

export type { VoyageModel, VoyageSageMakerConfig } from '../memory/types'
