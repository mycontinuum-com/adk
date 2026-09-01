import type { VectorIndex, VectorMatch, DistanceMatrixResult, ScrollResult } from '../types'

import { cosineSimilarity, matchesFilter, mergeMetadata, prunePairs } from '../filter'

export function inMemoryIndex(): VectorIndex {
  const embeddings = new Map<string, Map<string, Map<string, number[]>>>()
  const metadataStore = new Map<string, Map<string, Record<string, unknown>>>()

  function getEmbeddings(collection: string) {
    if (!embeddings.has(collection)) embeddings.set(collection, new Map())
    return embeddings.get(collection)!
  }

  function getMetadata(collection: string) {
    if (!metadataStore.has(collection)) metadataStore.set(collection, new Map())
    return metadataStore.get(collection)!
  }

  return {
    async search(collection, embedding, options) {
      const coll = getEmbeddings(collection)
      const meta = getMetadata(collection)
      const variant = options?.variant
      const results: VectorMatch[] = []

      for (const [id, variants] of coll) {
        if (variant && !variants.has(variant)) continue
        const vec = variant ? variants.get(variant)! : variants.values().next().value
        if (!vec) continue
        const m = meta.get(id) ?? {}
        if (!matchesFilter(options?.filter, id, m)) continue
        const score = cosineSimilarity(embedding, vec)
        if (options?.minScore != null && score < options.minScore) continue
        results.push({ id, score, metadata: m })
      }

      results.sort((a, b) => b.score - a.score)
      return results.slice(0, options?.topK ?? 10)
    },

    async upsert(collection, points, options) {
      const coll = getEmbeddings(collection)
      const meta = getMetadata(collection)
      const variant = options?.variant ?? 'default'

      for (const p of points) {
        if (!coll.has(p.id)) coll.set(p.id, new Map())
        coll.get(p.id)!.set(variant, p.embedding)
        if (p.metadata) {
          meta.set(p.id, mergeMetadata(meta.get(p.id) ?? {}, p.metadata))
        } else if (!meta.has(p.id)) {
          meta.set(p.id, {})
        }
      }
    },

    async delete(collection, ids) {
      const coll = getEmbeddings(collection)
      const meta = getMetadata(collection)
      for (const id of ids) {
        coll.delete(id)
        meta.delete(id)
      }
    },

    async deleteByFilter(collection, filter) {
      const coll = getEmbeddings(collection)
      const meta = getMetadata(collection)
      const toDelete: string[] = []
      for (const [id] of coll) {
        if (matchesFilter(filter, id, meta.get(id) ?? {})) {
          toDelete.push(id)
        }
      }
      for (const id of toDelete) {
        coll.delete(id)
        meta.delete(id)
      }
    },

    async updateMetadata(collection, id, update) {
      const meta = getMetadata(collection)
      meta.set(id, mergeMetadata(meta.get(id) ?? {}, update))
    },

    async distanceMatrix(collection, options) {
      const coll = getEmbeddings(collection)
      const meta = getMetadata(collection)
      const variant = options?.variant

      function getVec(id: string): number[] | undefined {
        const variants = coll.get(id)
        if (!variants) return undefined
        return variant ? variants.get(variant) : variants.values().next().value
      }

      let poolIds = Array.from(coll.keys()).filter((id) => {
        if (variant && !coll.get(id)?.has(variant)) return false
        return matchesFilter(options?.filter, id, meta.get(id) ?? {})
      })

      if (options?.sample != null && options.sample < poolIds.length) {
        poolIds = poolIds.slice(0, options.sample)
      }

      const pairs: DistanceMatrixResult['pairs'] = []
      for (let i = 0; i < poolIds.length; i++) {
        const aVec = getVec(poolIds[i])
        if (!aVec) continue
        for (let j = i + 1; j < poolIds.length; j++) {
          const bVec = getVec(poolIds[j])
          if (!bVec) continue
          pairs.push({
            a: poolIds[i],
            b: poolIds[j],
            score: cosineSimilarity(aVec, bVec),
          })
        }
      }

      if (options?.limit != null) {
        return { pairs: prunePairs(pairs, options.limit) }
      }

      return { pairs }
    },

    async get(collection, ids, options) {
      const meta = getMetadata(collection)
      const coll = getEmbeddings(collection)
      const variant = options?.variant
      return ids.map((id) => {
        const hasVariant = !variant || coll.get(id)?.has(variant)
        return { id, metadata: hasVariant ? (meta.get(id) ?? {}) : {} }
      })
    },

    async scroll(collection, options): Promise<ScrollResult> {
      const coll = getEmbeddings(collection)
      const meta = getMetadata(collection)
      const variant = options?.variant
      const limit = options?.limit ?? 100
      const offset = options?.offset ? parseInt(options.offset, 10) : 0

      const filtered = Array.from(coll.entries()).filter(([id, variants]) => {
        if (variant && !variants.has(variant)) return false
        return matchesFilter(options?.filter, id, meta.get(id) ?? {})
      })

      const page = filtered.slice(offset, offset + limit)

      const points = page.map(([id, variants]) => {
        const point: ScrollResult['points'][number] = {
          id,
          metadata: meta.get(id) ?? {},
        }
        if (options?.includeVectors) {
          const vec = variant ? variants.get(variant) : variants.values().next().value
          if (vec) point.embedding = vec
        }
        return point
      })

      const nextIdx = offset + limit

      return {
        points,
        ...(nextIdx < filtered.length ? { nextOffset: String(nextIdx) } : {}),
      }
    },

    async count(collection, options): Promise<number> {
      const coll = getEmbeddings(collection)
      const meta = getMetadata(collection)
      const variant = options?.variant

      let total = 0
      for (const [id, variants] of coll) {
        if (variant && !variants.has(variant)) continue
        if (!matchesFilter(options?.filter, id, meta.get(id) ?? {})) continue
        total++
      }
      return total
    },

    async close() {},
  }
}
