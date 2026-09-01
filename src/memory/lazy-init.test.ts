import { describe, expect, test } from 'vitest'

import type { Embedder } from './types'

import { memory } from './memory'
import { sqliteVec } from './providers/sqliteVec'

// A lazily-resolved provider must resolve to ONE instance no matter how the first calls interleave.
// `':memory:'` is the mode that turns a double-resolve into silent data loss: each resolution is a
// distinct database, and the writes that landed in the losing one vanish.
const stubEmbedder = (dims = 4): Embedder => ({
  dimensions: dims,
  modelName: 'stub',
  async embed(input) {
    return {
      embeddings: input.map((text, i) =>
        Array.from({ length: dims }, (_, d) => (text.length + i + d) % 7),
      ),
      model: 'stub',
    }
  },
})

describe('lazy provider initialization', () => {
  test('concurrent first operations share one resolved index', async () => {
    const mem = memory({
      model: stubEmbedder(),
      index: sqliteVec({ path: ':memory:' }),
      collection: 'lazy_race',
    })
    try {
      await Promise.all([
        mem.upsert({ id: 'a', content: 'first item' }),
        mem.upsert({ id: 'b', content: 'second item' }),
      ])
      expect(await mem.count()).toBe(2)
    } finally {
      await mem.close()
    }
  })

  test('close() on a never-used lazy index does not instantiate the provider', async () => {
    const mem = memory({
      model: stubEmbedder(),
      index: sqliteVec({ path: '/nonexistent-root-path/should-never-be-created/vectors.db' }),
      collection: 'lazy_untouched',
    })
    // A provider load would mkdir that unwritable path and throw; a true no-op resolves.
    await expect(mem.close()).resolves.toBeUndefined()
  })
})
