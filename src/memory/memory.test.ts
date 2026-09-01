import { vi } from 'vitest'
import { z } from 'zod'

import type { RenderContext } from '../types/runnables'
import type {
  Embedder,
  VectorIndex,
  VectorMatch,
  DistanceMatrixPair,
  HasIdCondition,
} from './types'

import { qdrant } from '../integrations/qdrant'
import { voyage } from '../integrations/voyage'
import { memory, normalizeFilter, collectionSpec } from './memory'
import { inMemoryIndex } from './providers/inMemoryIndex'
import { pgvector } from './providers/pgvector'
import { representativeSample, estimateDensity } from './sample'

const metadataSchema = z.object({
  org: z.string(),
  theme: z.string(),
  status: z.enum(['open', 'in-progress', 'closed']),
})

type TestMetadata = z.infer<typeof metadataSchema>

const STUB_MODEL = 'test-model'

function createStubEmbedder(dims = 4, modelName = STUB_MODEL): Embedder {
  return {
    dimensions: dims,
    modelName,
    async embed(input, _options) {
      return {
        embeddings: input.map((_, i) => Array.from({ length: dims }, (_row, d) => i + d * 0.1)),
        model: modelName,
        usage: { totalTokens: input.join('').length },
      }
    },
  }
}

function stubVectorKey(variant: string): string {
  return `${STUB_MODEL}_${variant}`
}

interface StoredPoint {
  id: string
  vectors: Record<string, number[]>
  metadata: Record<string, unknown>
}

function createStubIndex(): VectorIndex & {
  stored: Map<string, StoredPoint>
  metadataUpdates: Array<{ id: string; metadata: Record<string, unknown> }>
  deleteByFilterCalls: Array<{ filter: unknown }>
} {
  const stored = new Map<string, StoredPoint>()
  const metadataUpdates: Array<{
    id: string
    metadata: Record<string, unknown>
  }> = []
  const deleteByFilterCalls: Array<{ filter: unknown }> = []

  return {
    stored,
    metadataUpdates,
    deleteByFilterCalls,

    async search(_collection, _embedding, options) {
      const results: VectorMatch[] = []
      for (const [, point] of stored) {
        const variant = options?.variant
        if (variant && !point.vectors[variant]) continue

        results.push({
          id: point.id,
          score: 0.95,
          metadata: point.metadata,
        })
      }
      return results.slice(0, options?.topK ?? 10)
    },

    async upsert(_collection, newPoints, options) {
      const variant = options?.variant
      for (const p of newPoints) {
        const existing = stored.get(p.id)
        const vectors = existing ? { ...existing.vectors } : {}
        if (variant) vectors[variant] = p.embedding
        const existingMeta = existing?.metadata ?? {}
        const merged = p.metadata ? { ...existingMeta } : existingMeta
        if (p.metadata) {
          for (const [key, value] of Object.entries(p.metadata)) {
            if (value === null) delete merged[key]
            else if (value !== undefined) merged[key] = value
          }
        }
        stored.set(p.id, {
          id: p.id,
          vectors,
          metadata: merged,
        })
      }
    },

    async delete(_collection, ids) {
      for (const id of ids) stored.delete(id)
    },

    async deleteByFilter(_collection, filter) {
      deleteByFilterCalls.push({ filter })
      stored.clear()
    },

    async updateMetadata(_collection, id, metadata) {
      metadataUpdates.push({ id, metadata })
      const existing = stored.get(id)
      if (!existing) return
      const merged: Record<string, unknown> = { ...existing.metadata }
      for (const [key, value] of Object.entries(metadata)) {
        if (value === null) {
          delete merged[key]
        } else if (value !== undefined) {
          merged[key] = value
        }
      }
      stored.set(id, { ...existing, metadata: merged })
    },

    async distanceMatrix(_collection, options) {
      let poolIds: string[]
      const hasIdCond = options?.filter?.must?.find((c): c is HasIdCondition => 'has_id' in c)
      if (hasIdCond) {
        poolIds = hasIdCond.has_id
      } else {
        const all = Array.from(stored.keys())
        const sample = options?.sample ?? all.length
        poolIds = all.slice(0, sample)
      }
      const pairs: DistanceMatrixPair[] = []
      for (let i = 0; i < poolIds.length; i++) {
        for (let j = i + 1; j < poolIds.length; j++) {
          const a = poolIds[i]
          const b = poolIds[j]
          const score = 0.5
          pairs.push({ a, b, score })
        }
      }
      return { pairs }
    },

    async get(_collection, ids, options) {
      return ids.map((id) => {
        const p = stored.get(id)
        const variant = options?.variant
        const hasVariant = !variant || !!p?.vectors?.[variant]
        return {
          id,
          metadata: hasVariant ? (p?.metadata ?? {}) : ({} as Record<string, unknown>),
        }
      })
    },

    async scroll(_collection, options) {
      const limit = options?.limit ?? 100
      const offset = options?.offset ? parseInt(options.offset, 10) : 0
      const entries = Array.from(stored.entries())
      const page = entries.slice(offset, offset + limit)
      const points = page.map(([id, point]) => ({
        id,
        metadata: point.metadata,
      }))
      const nextIdx = offset + limit
      return {
        points,
        ...(nextIdx < entries.length ? { nextOffset: String(nextIdx) } : {}),
      }
    },

    async count() {
      return stored.size
    },

    async close() {},
  }
}

function createMockRenderContext(overrides?: {
  invocationId?: string
  state?: Record<string, unknown>
}): RenderContext {
  return {
    invocationId: overrides?.invocationId ?? 'inv-1',
    agentName: 'test-agent',
    session: {} as never,
    state: overrides?.state ?? ({} as never),
    agent: {} as never,
    events: [],
    functionTools: [],
    providerTools: [],
  } as unknown as RenderContext
}

describe('memory', () => {
  describe('factory', () => {
    it('creates a memory instance with custom embedder and index', () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'test',
      })

      expect(mem.collection).toBe('test')
      expect(mem.embedder).toBeDefined()
      expect(mem.index).toBeDefined()
    })

    it('validates asymmetric embedding dimensions match', () => {
      expect(() =>
        memory({
          model: {
            index: createStubEmbedder(1024),
            query: createStubEmbedder(512),
          },
          index: createStubIndex(),
          collection: 'test',
        }),
      ).toThrow(/dimension mismatch/i)
    })

    it('accepts asymmetric embedders with matching dimensions', () => {
      const mem = memory({
        model: {
          index: createStubEmbedder(1024),
          query: createStubEmbedder(1024),
        },
        index: createStubIndex(),
        collection: 'test',
      })

      expect((mem.embedder as { index: Embedder; query: Embedder }).index.dimensions).toBe(1024)
    })
  })

  describe('normalizeFilter', () => {
    it('returns undefined for undefined input', () => {
      expect(normalizeFilter(undefined)).toBeUndefined()
    })

    it('passes through full VectorFilter syntax', () => {
      const filter = { must: [{ key: 'org', match: { value: 'acme' } }] }
      expect(normalizeFilter(filter)).toBe(filter)
    })

    it('passes through VectorFilter with should', () => {
      const filter = { should: [{ key: 'org', match: { value: 'acme' } }] }
      expect(normalizeFilter(filter)).toBe(filter)
    })

    it('passes through VectorFilter with must_not', () => {
      const filter = {
        must_not: [{ key: 'status', match: { value: 'closed' } }],
      }
      expect(normalizeFilter(filter)).toBe(filter)
    })

    it('expands shorthand to must conditions', () => {
      expect(normalizeFilter({ org: 'acme' })).toEqual({
        must: [{ key: 'org', match: { value: 'acme' } }],
      })
    })

    it('expands multiple shorthand keys', () => {
      const result = normalizeFilter({ org: 'acme', status: 'open' })
      expect(result?.must).toHaveLength(2)
      expect(result?.must).toEqual(
        expect.arrayContaining([
          { key: 'org', match: { value: 'acme' } },
          { key: 'status', match: { value: 'open' } },
        ]),
      )
    })

    it('supports numeric shorthand values', () => {
      expect(normalizeFilter({ score: 42 })).toEqual({
        must: [{ key: 'score', match: { value: 42 } }],
      })
    })

    it('supports boolean shorthand values', () => {
      expect(normalizeFilter({ active: true })).toEqual({
        must: [{ key: 'active', match: { value: true } }],
      })
    })

    it('returns undefined for empty shorthand', () => {
      expect(normalizeFilter({})).toBeUndefined()
    })
  })

  describe('search', () => {
    it('embeds text, searches index, and returns matches + embedding', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('questionnaire')]: [1, 2, 3, 4] },
        metadata: { org: 'org-1', theme: 'eczema', status: 'open' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
        metadata: metadataSchema,
      })

      const { matches, embedding } = await mem.search('patient with rash', {
        topK: 10,
      })

      expect(matches).toHaveLength(1)
      expect(matches[0].id).toBe('p1')
      expect(matches[0].metadata.org).toBe('org-1')
      expect(embedding).toHaveLength(4)
    })

    it('accepts filter shorthand', async () => {
      const idx = createStubIndex()
      const searchSpy = vi.spyOn(idx, 'search')
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'acme', _variant_default: 'test' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.search('query', { filter: { org: 'acme' } })

      expect(searchSpy).toHaveBeenCalledWith(
        'test',
        expect.any(Array),
        expect.objectContaining({
          filter: { must: [{ key: 'org', match: { value: 'acme' } }] },
        }),
      )
    })

    it('throws when embedder returns no query embedding', async () => {
      const embedder = createStubEmbedder()
      vi.spyOn(embedder, 'embed').mockResolvedValue({
        embeddings: [],
        model: STUB_MODEL,
      })
      const mem = memory({
        model: embedder,
        index: createStubIndex(),
        collection: 'test',
      })
      await expect(mem.search('query')).rejects.toThrow(/expected 1 embedding/i)
    })
  })

  describe('upsert', () => {
    it('embeds content and upserts to index with correct variant', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
        metadata: metadataSchema,
      })

      await mem.upsert({
        id: 'req-1',
        content: 'patient presenting with eczema',
        metadata: { org: 'org-1', theme: 'eczema', status: 'open' },
      })

      const point = idx.stored.get('req-1')!
      expect(point).toBeDefined()
      expect(point.vectors).toHaveProperty(stubVectorKey('questionnaire'))
      expect(point.metadata.org).toBe('org-1')
    })

    it('accepts pre-computed embedding and skips embedder', async () => {
      const idx = createStubIndex()
      const embedder = createStubEmbedder()
      const embedSpy = vi.spyOn(embedder, 'embed')

      const mem = memory({
        model: embedder,
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
      })

      await mem.upsert({
        id: 'req-2',
        content: 'pre-computed content',
        embedding: [0.1, 0.2, 0.3, 0.4],
        metadata: { org: 'org-1' },
      })

      expect(embedSpy).not.toHaveBeenCalled()
      const point = idx.stored.get('req-2')!
      expect(point.vectors[stubVectorKey('questionnaire')]).toEqual([0.1, 0.2, 0.3, 0.4])
    })

    it('batches content items into a single embed call', async () => {
      const embedder = createStubEmbedder()
      const embedSpy = vi.spyOn(embedder, 'embed')
      const idx = createStubIndex()

      const mem = memory({
        model: embedder,
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
      })

      await mem.upsert([
        { id: 'r1', content: 'text 1', metadata: { org: 'o1' } },
        { id: 'r2', content: 'text 2', metadata: { org: 'o2' } },
        { id: 'r3', content: 'text 3', metadata: { org: 'o3' } },
      ])

      expect(embedSpy).toHaveBeenCalledTimes(1)
      expect(embedSpy).toHaveBeenCalledWith(['text 1', 'text 2', 'text 3'], {
        inputType: 'document',
      })
      expect(idx.stored.size).toBe(3)
    })

    it('rejects pre-computed embeddings with wrong dimensions', async () => {
      const mem = memory({
        model: createStubEmbedder(4),
        index: createStubIndex(),
        collection: 'requests',
        variants: ['questionnaire'],
      })

      await expect(
        mem.upsert({
          id: 'bad',
          content: 'text',
          embedding: [0.1, 0.2],
        }),
      ).rejects.toThrow(/dimension mismatch/i)
    })

    it('handles empty array without calling embedder', async () => {
      const embedder = createStubEmbedder()
      const embedSpy = vi.spyOn(embedder, 'embed')

      const mem = memory({
        model: embedder,
        index: createStubIndex(),
        collection: 'requests',
        variants: ['questionnaire'],
      })

      await mem.upsert([])
      expect(embedSpy).not.toHaveBeenCalled()
    })

    it('handles mixed content and pre-computed items in one call', async () => {
      const embedder = createStubEmbedder()
      const embedSpy = vi.spyOn(embedder, 'embed')
      const idx = createStubIndex()

      const mem = memory({
        model: embedder,
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
      })

      await mem.upsert([
        { id: 'r1', content: 'text content' },
        {
          id: 'r2',
          content: 'pre-computed text',
          embedding: [0.1, 0.2, 0.3, 0.4],
        },
      ])

      expect(embedSpy).toHaveBeenCalledTimes(1)
      expect(embedSpy).toHaveBeenCalledWith(['text content'], {
        inputType: 'document',
      })
      expect(idx.stored.size).toBe(2)
      expect(idx.stored.get('r1')!.vectors).toHaveProperty(stubVectorKey('questionnaire'))
      expect(idx.stored.get('r2')!.vectors[stubVectorKey('questionnaire')]).toEqual([
        0.1, 0.2, 0.3, 0.4,
      ])
    })

    it('stores embeddings under key model_variant when embedder has modelName', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(4, STUB_MODEL),
        index: idx,
        collection: 'c',
        variants: ['questionnaire'],
      })
      await mem.upsert({
        id: 'x',
        content: 'text',
        metadata: {},
      })
      const point = idx.stored.get('x')!
      expect(point.vectors[stubVectorKey('questionnaire')]).toBeDefined()
      expect(point.vectors['questionnaire']).toBeUndefined()
    })

    it('validates metadata against schema on write', async () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'requests',
        variants: ['questionnaire'],
        metadata: metadataSchema,
      })

      await expect(
        mem.upsert({
          id: 'bad',
          content: 'text',
          metadata: {
            org: 123,
            theme: 'eczema',
            status: 'open',
          } as unknown as TestMetadata,
        }),
      ).rejects.toThrow()
    })

    it('throws when embedder returns wrong number of document embeddings', async () => {
      const embedder = createStubEmbedder()
      vi.spyOn(embedder, 'embed').mockResolvedValue({
        embeddings: [[0, 0, 0, 0]],
        model: STUB_MODEL,
      })
      const mem = memory({
        model: embedder,
        index: createStubIndex(),
        collection: 'test',
      })
      await expect(
        mem.upsert([
          { id: 'a', content: 'first' },
          { id: 'b', content: 'second' },
        ]),
      ).rejects.toThrow(/expected 2 embeddings/i)
    })
  })

  describe('variant', () => {
    it('creates a variant that writes to a different named vector', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'requests',
        variants: ['questionnaire', 'full'],
      })
      const memFull = mem.variant.full

      await mem.upsert({
        id: 'req-1',
        content: 'questionnaire content',
        metadata: { org: 'o1' },
      })
      await memFull.upsert({
        id: 'req-1',
        content: 'full content',
        metadata: { org: 'o1', status: 'closed' },
      })

      const point = idx.stored.get('req-1')!
      expect(point.vectors).toHaveProperty(stubVectorKey('questionnaire'))
      expect(point.vectors).toHaveProperty(stubVectorKey('full'))
      expect(point.metadata.status).toBe('closed')
    })

    it('returning() throws for unknown variant name', () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'test',
        variants: ['summary', 'detailed'],
      })

      expect(() => mem.variant.summary.returning('nonexistent')).toThrow(
        /unknown variant "nonexistent"/i,
      )
    })

    it('returning() accepts valid variant names', () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'test',
        variants: ['summary', 'detailed'],
      })

      expect(() => mem.variant.summary.returning('detailed')).not.toThrow()
      expect(() => mem.returning('summary')).not.toThrow()
    })
  })

  describe('updateMetadata', () => {
    it('merges metadata without touching embeddings', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
        metadata: metadataSchema,
      })

      await mem.upsert({
        id: 'req-1',
        content: 'text',
        metadata: { org: 'o1', theme: 'eczema', status: 'open' },
      })

      await mem.updateMetadata('req-1', { status: 'closed' })

      const point = idx.stored.get('req-1')!
      expect(point.metadata.status).toBe('closed')
      expect(point.metadata.org).toBe('o1')
      expect(point.vectors).toHaveProperty(stubVectorKey('questionnaire'))
    })

    it('deletes keys when set to null', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
      })

      await mem.upsert({
        id: 'req-1',
        content: 'text',
        metadata: { org: 'o1', extra: 'value' },
      })

      await mem.updateMetadata('req-1', { extra: null } as Record<string, unknown>)

      const point = idx.stored.get('req-1')!
      expect(point.metadata).not.toHaveProperty('extra')
      expect(point.metadata.org).toBe('o1')
    })

    it('is accessible from variant instances', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'requests',
        variants: ['questionnaire', 'full'],
      })
      const memFull = mem.variant.full

      await mem.upsert({
        id: 'req-1',
        content: 'text',
        metadata: { org: 'o1', status: 'open' },
      })

      await memFull.updateMetadata('req-1', { status: 'closed' } as Record<string, unknown>)

      const point = idx.stored.get('req-1')!
      expect(point.metadata.status).toBe('closed')
    })
  })

  describe('delete', () => {
    it('removes points by id', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'text a', metadata: { org: 'x' } },
        { id: 'b', content: 'text b', metadata: { org: 'y' } },
      ])

      expect(idx.stored.size).toBe(2)
      await mem.delete(['a'])
      expect(idx.stored.size).toBe(1)
      expect(idx.stored.has('b')).toBe(true)
    })

    it('no-ops on empty array', async () => {
      const idx = createStubIndex()
      const deleteSpy = vi.spyOn(idx, 'delete')
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.delete([])
      expect(deleteSpy).not.toHaveBeenCalled()
    })
  })

  describe('deleteByFilter', () => {
    it('normalizes shorthand filter and delegates to index', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([{ id: 'a', content: 'text', metadata: { org: 'acme' } }])

      await mem.deleteByFilter({ org: 'acme' })

      expect(idx.deleteByFilterCalls).toHaveLength(1)
      expect(idx.deleteByFilterCalls[0].filter).toEqual({
        must: [{ key: 'org', match: { value: 'acme' } }],
      })
    })

    it('passes through full filter syntax', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const filter = { must: [{ key: 'status', match: { value: 'closed' } }] }
      await mem.deleteByFilter(filter)

      expect(idx.deleteByFilterCalls).toHaveLength(1)
      expect(idx.deleteByFilterCalls[0].filter).toEqual(filter)
    })
  })

  describe('context', () => {
    it('returns a ContextRenderer function', () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'requests',
        variants: ['questionnaire'],
      })

      const renderer = mem.context({
        query: () => 'search query',
        topK: 10,
      })

      expect(typeof renderer).toBe('function')
    })

    it('embeds query, searches index, and appends a system event', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const renderer = mem.context({
        query: () => 'search text',
        topK: 10,
      })

      const ctx = createMockRenderContext()
      const result = await renderer(ctx)

      expect(result.events).toHaveLength(1)
      const event = result.events[0] as { type: string; text: string }
      expect(event.type).toBe('system')
      expect(event.text).toContain('p1')
    })

    it('uses custom render when provided', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const renderer = mem.context({
        query: () => 'search',
        render: (matches) => matches.map((m) => m.id).join(','),
      })

      const result = await renderer(createMockRenderContext())
      const event = result.events[0] as { text: string }
      expect(event.text).toBe('p1')
    })

    it('returns ctx unchanged when query is empty', async () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'test',
      })

      const renderer = mem.context({ query: () => '' })
      const ctx = createMockRenderContext()
      const result = await renderer(ctx)

      expect(result).toBe(ctx)
    })

    it('returns ctx unchanged when no matches found', async () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'test',
      })

      const renderer = mem.context({ query: () => 'anything' })
      const ctx = createMockRenderContext()
      const result = await renderer(ctx)

      expect(result).toBe(ctx)
    })
  })

  describe('tool', () => {
    it('returns a FunctionTool with name, description, and schema', () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'requests',
        variants: ['questionnaire'],
      })

      const tool = mem.tool({
        description: 'Search similar requests',
        topK: 10,
      })

      expect(tool.name).toBe('memory_search')
      expect(tool.description).toBe('Search similar requests')
      expect(tool.schema).toBeDefined()
    })

    it('accepts a custom name', () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'requests',
        variants: ['questionnaire'],
      })

      const tool = mem.tool({
        name: 'find_similar_requests',
        description: 'Search similar requests',
        topK: 10,
      })

      expect(tool.name).toBe('find_similar_requests')
    })

    it('embeds query, searches index, and returns rendered matches', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const tool = mem.tool({ description: 'Search memory' })

      const result = await tool.execute!({
        args: { query: 'test query' },
        state: {},
      } as never)

      expect(result).toContain('id="p1"')
    })

    it('applies dynamic filter with state context', async () => {
      const idx = createStubIndex()
      const searchSpy = vi.spyOn(idx, 'search')
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const tool = mem.tool({
        description: 'Search memory',
        filter: (ctx) => ({
          must: [{ key: 'org', match: { value: ctx.state.orgId } }],
        }),
      })

      await tool.execute!({
        args: { query: 'test' },
        state: { orgId: 'o1' },
      } as never)

      expect(searchSpy).toHaveBeenCalledWith(
        'test',
        expect.any(Array),
        expect.objectContaining({
          filter: { must: [{ key: 'org', match: { value: 'o1' } }] },
        }),
      )
    })

    it('uses custom render when provided', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const tool = mem.tool({
        description: 'Search memory',
        render: (matches) => matches.map((m) => m.id).join(','),
      })

      const result = await tool.execute!({
        args: { query: 'test' },
        state: {},
      } as never)

      expect(result).toBe('p1')
    })
  })

  describe('scroll', () => {
    it('scrolls through all points in pages', async () => {
      const idx = inMemoryIndex()
      const embedder = createStubEmbedder()
      const mem = memory({
        model: embedder,
        index: idx,
        collection: 'test',
      })
      await mem.upsert([
        { id: 'a', content: 'hello' },
        { id: 'b', content: 'world' },
        { id: 'c', content: 'foo' },
      ])
      const page1 = await mem.scroll({ limit: 2 })
      expect(page1.points).toHaveLength(2)
      expect(page1.nextOffset).toBeDefined()

      const page2 = await mem.scroll({ limit: 2, offset: page1.nextOffset })
      expect(page2.points).toHaveLength(1)
      expect(page2.nextOffset).toBeUndefined()
    })

    it('returns empty for empty collection', async () => {
      const idx = inMemoryIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })
      const page = await mem.scroll()
      expect(page.points).toHaveLength(0)
      expect(page.nextOffset).toBeUndefined()
    })

    it('includes vectors when includeVectors is true', async () => {
      const idx = inMemoryIndex()
      const embedder = createStubEmbedder()
      const mem = memory({
        model: embedder,
        index: idx,
        collection: 'test',
      })
      await mem.upsert([{ id: 'a', content: 'hello' }])
      const page = await mem.scroll({ includeVectors: true })
      expect(page.points).toHaveLength(1)
      expect(page.points[0].embedding).toBeDefined()
      expect(page.points[0].embedding!.length).toBe(embedder.dimensions)
    })

    it('omits vectors by default', async () => {
      const idx = inMemoryIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })
      await mem.upsert([{ id: 'a', content: 'hello' }])
      const page = await mem.scroll()
      expect(page.points[0].embedding).toBeUndefined()
    })
  })

  describe('count', () => {
    it('returns point count', async () => {
      const idx = inMemoryIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })
      await mem.upsert([
        { id: 'a', content: 'hello' },
        { id: 'b', content: 'world' },
      ])
      expect(await mem.count()).toBe(2)
    })

    it('returns 0 for empty collection', async () => {
      const idx = inMemoryIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })
      expect(await mem.count()).toBe(0)
    })
  })

  describe('provider factories', () => {
    it('voyage() returns a VoyageModel config', () => {
      const config = voyage('voyage-4', { dimensions: 1024 })
      expect(config.provider).toBe('voyage')
      expect(config.name).toBe('voyage-4')
      expect(config.dimensions).toBe(1024)
    })

    it('voyage() accepts optional config', () => {
      const config = voyage('voyage-4', {
        dimensions: 512,
        outputFormat: 'int8',
      })
      expect(config.dimensions).toBe(512)
      expect(config.outputFormat).toBe('int8')
    })

    it('qdrant() returns a QdrantConfig', () => {
      const config = qdrant({ url: 'http://localhost:6333' })
      expect(config.provider).toBe('qdrant')
      expect(config.url).toBe('http://localhost:6333')
    })
  })

  describe('escape hatches', () => {
    it('exposes index and collection for direct operations', () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'requests',
        variants: ['v'],
      })

      expect(mem.index).toBe(idx)
      expect(mem.collection).toBe('requests')
    })
  })

  describe('slices', () => {
    const medSchema = z.object({ drug: z.string() })
    const probSchema = z.object({ icd10: z.string() })

    function createSlicedMem(idx?: ReturnType<typeof createStubIndex>) {
      const index = idx ?? createStubIndex()
      return {
        index,
        mem: memory({
          model: createStubEmbedder(),
          index,
          collection: 'records',
          slices: {
            medication: { metadata: medSchema },
            problem: { metadata: probSchema },
          },
        }),
      }
    }

    it('injects _slice_kind on upsert', async () => {
      const { index, mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin 500mg',
        metadata: { drug: 'Metformin' },
      })

      const point = index.stored.get('med-1')!
      expect(point.metadata['_slice_kind']).toBe('medication')
    })

    it('rejects user metadata with _slice_ prefix', async () => {
      const { mem } = createSlicedMem()
      await expect(
        mem.slice.medication.upsert({
          id: 'bad',
          content: 'text',
          metadata: { drug: 'x', _slice_evil: 'hack' } as never,
        }),
      ).rejects.toThrow(/reserved/i)
    })

    it('per-slice search filters by _slice_kind', async () => {
      const { index, mem } = createSlicedMem()

      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.problem.upsert({
        id: 'prob-1',
        content: 'Hypertension',
        metadata: { icd10: 'I10' },
      })

      const searchSpy = vi.spyOn(index, 'search')
      await mem.slice.medication.search('cardiac')

      expect(searchSpy).toHaveBeenCalledWith(
        'records',
        expect.any(Array),
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: '_slice_kind', match: { value: 'medication' } }]),
          }),
        }),
      )
    })

    it('per-slice search strips _slice_kind from metadata', async () => {
      const { mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })

      const { matches } = await mem.slice.medication.search('Metformin')
      expect(matches[0].metadata).not.toHaveProperty('_slice_kind')
      expect(matches[0].metadata.drug).toBe('Metformin')
    })

    it('cross-type search returns matches with kind', async () => {
      const { mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.problem.upsert({
        id: 'prob-1',
        content: 'Hypertension',
        metadata: { icd10: 'I10' },
      })

      const { matches } = await mem.search('cardiac')
      expect(matches.length).toBeGreaterThan(0)
      for (const match of matches) {
        expect(match.kind).toBeDefined()
        expect(['medication', 'problem']).toContain(match.kind)
      }
    })

    it('cross-type search supports discriminated union narrowing', async () => {
      const { mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.problem.upsert({
        id: 'prob-1',
        content: 'Hypertension',
        metadata: { icd10: 'I10' },
      })

      const { matches } = await mem.search('query')
      for (const match of matches) {
        switch (match.kind) {
          case 'medication':
            expect(match.metadata.drug).toBeDefined()
            break
          case 'problem':
            expect(match.metadata.icd10).toBeDefined()
            break
        }
      }
    })

    it('collectionSpec includes _slice_kind payload index when slices declared', () => {
      const spec = collectionSpec({
        model: createStubEmbedder(),
        collection: 'records',
        slices: { medication: {}, problem: {} },
      })
      expect(spec.payloadIndexes).toEqual(['_slice_kind'])
    })

    it('collectionSpec omits payload index when no slices', () => {
      const spec = collectionSpec({
        model: createStubEmbedder(),
        collection: 'records',
      })
      expect(spec.payloadIndexes).toBeUndefined()
    })

    it('per-slice context renderer injects slice-filtered results', async () => {
      const { mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin 500mg',
        metadata: { drug: 'Metformin' },
      })

      const renderer = mem.slice.medication.context({
        query: () => 'cardiac drugs',
        topK: 5,
      })

      const ctx = createMockRenderContext()
      const result = await renderer(ctx)
      expect(result.events.length).toBeGreaterThan(ctx.events.length)
    })

    it('per-slice tool returns slice-filtered results', async () => {
      const { mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin 500mg',
        metadata: { drug: 'Metformin' },
      })

      const tool = mem.slice.medication.tool({
        description: 'Search medications',
      })
      expect(tool.name).toBe('memory_search')
      expect(tool.description).toBe('Search medications')
    })

    it('both axes: slice + variant composition', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'records',
        variants: ['summary', 'detailed'],
        slices: {
          medication: { metadata: medSchema },
          problem: { metadata: probSchema },
        },
      })

      await mem.slice.medication.variant.summary.upsert({
        id: 'med-1',
        content: 'Metformin summary',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.medication.variant.detailed.upsert({
        id: 'med-1',
        content: 'Metformin detailed clinical narrative',
        metadata: { drug: 'Metformin' },
      })

      const point = idx.stored.get('med-1')!
      expect(point.metadata['_slice_kind']).toBe('medication')
      expect(point.vectors).toHaveProperty(stubVectorKey('summary'))
      expect(point.vectors).toHaveProperty(stubVectorKey('detailed'))
    })

    it('cross-type search on a specific variant', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'records',
        variants: ['summary', 'detailed'],
        slices: {
          medication: { metadata: medSchema },
        },
      })

      await mem.slice.medication.variant.summary.upsert({
        id: 'med-1',
        content: 'Metformin summary',
        metadata: { drug: 'Metformin' },
      })

      const { matches } = await mem.variant.summary.search('Metformin')
      expect(matches.length).toBeGreaterThan(0)
    })

    it('per-slice deleteByFilter injects _slice_kind into filter', async () => {
      const { index, mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.problem.upsert({
        id: 'prob-1',
        content: 'Hypertension',
        metadata: { icd10: 'I10' },
      })

      await mem.slice.medication.deleteByFilter({ drug: 'Metformin' })

      expect(index.deleteByFilterCalls).toHaveLength(1)
      expect(index.deleteByFilterCalls[0].filter).toEqual({
        must: expect.arrayContaining([
          { key: 'drug', match: { value: 'Metformin' } },
          { key: '_slice_kind', match: { value: 'medication' } },
        ]),
      })
    })

    it('top-level sliced memory delete removes points by id', async () => {
      const { index, mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.problem.upsert({
        id: 'prob-1',
        content: 'Hypertension',
        metadata: { icd10: 'I10' },
      })

      expect(index.stored.size).toBe(2)
      await mem.delete(['med-1'])
      expect(index.stored.size).toBe(1)
      expect(index.stored.has('prob-1')).toBe(true)
    })

    it('top-level sliced memory deleteByFilter crosses all slices', async () => {
      const { index, mem } = createSlicedMem()
      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })

      await mem.deleteByFilter({
        must: [{ key: 'drug', match: { value: 'Metformin' } }],
      })

      expect(index.deleteByFilterCalls).toHaveLength(1)
      const filter = index.deleteByFilterCalls[0].filter as { must: unknown[] }
      const hasSliceCondition = filter.must.some(
        (c: unknown) =>
          typeof c === 'object' &&
          c !== null &&
          'key' in c &&
          (c as { key: string }).key === '_slice_kind',
      )
      expect(hasSliceCondition).toBe(false)
    })

    it('sliced memory variants expose get, sample, and returning', async () => {
      const idx = createStubIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'records',
        variants: ['summary', 'detailed'],
        slices: {
          medication: { metadata: medSchema },
          problem: { metadata: probSchema },
        },
      })

      await mem.slice.medication.variant.summary.upsert({
        id: 'med-1',
        content: 'Metformin summary',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.medication.variant.detailed.upsert({
        id: 'med-1',
        content: 'Metformin detailed clinical narrative',
        metadata: { drug: 'Metformin' },
      })

      const getResult = await mem.variant.summary.get(['med-1'])
      expect(getResult).toHaveLength(1)
      expect(getResult[0].content).toBe('Metformin summary')

      const view = mem.variant.summary.returning('detailed')
      const { matches } = await view.search('Metformin')
      expect(matches).toHaveLength(1)
      expect(matches[0].content).toBe('Metformin detailed clinical narrative')
    })

    it('sliced memory variants.returning() throws for unknown variant', () => {
      const mem = memory({
        model: createStubEmbedder(),
        index: createStubIndex(),
        collection: 'records',
        slices: {
          medication: { metadata: medSchema },
        },
      })

      expect(() => mem.variant.default.returning('nonexistent')).toThrow(
        /unknown variant "nonexistent"/i,
      )
    })

    it('slices() injects _slice_kind should-filter for selected slices', async () => {
      const { index, mem } = createSlicedMem()
      const searchSpy = vi.spyOn(index, 'search')

      await mem.slices(['medication']).search('query')

      expect(searchSpy).toHaveBeenCalledWith(
        'records',
        expect.any(Array),
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([
              {
                should: [{ key: '_slice_kind', match: { value: 'medication' } }],
              },
            ]),
          }),
        }),
      )
    })
  })

  describe('representativeSample', () => {
    it('returns correct count and no duplicate IDs', () => {
      const pairs: DistanceMatrixPair[] = [
        { a: '1', b: '2', score: 0.5 },
        { a: '1', b: '3', score: 0.5 },
        { a: '2', b: '3', score: 0.5 },
      ]
      const selected = representativeSample(pairs, 2)
      expect(selected).toHaveLength(2)
      expect(new Set(selected).size).toBe(2)
    })

    it('first selected point is the densest when geometry is known', () => {
      const pairs: DistanceMatrixPair[] = [
        { a: 'center', b: 'a', score: 0.9 },
        { a: 'center', b: 'b', score: 0.9 },
        { a: 'center', b: 'c', score: 0.9 },
        { a: 'a', b: 'b', score: 0.5 },
        { a: 'a', b: 'c', score: 0.5 },
        { a: 'b', b: 'c', score: 0.5 },
      ]
      const density = estimateDensity(pairs, 3)
      const centerDensity = density.get('center') ?? 0
      const aDensity = density.get('a') ?? 0
      expect(centerDensity).toBeGreaterThan(aDensity)
      const selected = representativeSample(pairs, 1)
      expect(selected[0]).toBe('center')
    })

    it('n=1 returns single id', () => {
      const pairs: DistanceMatrixPair[] = [{ a: '1', b: '2', score: 0.5 }]
      const selected = representativeSample(pairs, 1)
      expect(selected).toHaveLength(1)
      expect(['1', '2']).toContain(selected[0])
    })

    it('n=pool returns all ids', () => {
      const pairs: DistanceMatrixPair[] = [
        { a: '1', b: '2', score: 0.5 },
        { a: '1', b: '3', score: 0.5 },
        { a: '2', b: '3', score: 0.5 },
      ]
      const selected = representativeSample(pairs, 3)
      expect(selected).toHaveLength(3)
      expect(new Set(selected)).toEqual(new Set(['1', '2', '3']))
    })

    it('throws when n > pool size', () => {
      const pairs: DistanceMatrixPair[] = [{ a: '1', b: '2', score: 0.5 }]
      expect(() => representativeSample(pairs, 3)).toThrow(/Cannot sample 3 from pool of 2/)
    })

    it('weights influence selection', () => {
      const pairs: DistanceMatrixPair[] = [
        { a: '1', b: '2', score: 0.5 },
        { a: '1', b: '3', score: 0.5 },
        { a: '2', b: '3', score: 0.5 },
      ]
      const weights = new Map<string, number>([
        ['1', 0.01],
        ['2', 10],
        ['3', 1],
      ])
      const selected = representativeSample(pairs, 1, { weights })
      expect(selected[0]).toBe('2')
    })
  })

  describe('sample', () => {
    it('collection-wide: returns typed SampleResult with matches', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1', theme: 't1' },
      })
      idx.stored.set('p2', {
        id: 'p2',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1', theme: 't2' },
      })
      idx.stored.set('p3', {
        id: 'p3',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: { org: 'o1', theme: 't3' },
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const result = await mem.sample(2, { pool: 3 })

      expect(result.matches).toHaveLength(2)
      expect(result.embedding).toBeUndefined()
      result.matches.forEach((m) => {
        expect(idx.stored.has(m.id)).toBe(true)
      })
    })

    it('query-focused: calls search then distanceMatrix with has_id, returns embedding', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('questionnaire')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })
      idx.stored.set('p2', {
        id: 'p2',
        vectors: { [stubVectorKey('questionnaire')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })
      idx.stored.set('p3', {
        id: 'p3',
        vectors: { [stubVectorKey('questionnaire')]: [1, 2, 3, 4] },
        metadata: { org: 'o1' },
      })

      const embedder = createStubEmbedder()
      const embedSpy = vi.spyOn(embedder, 'embed')
      const searchSpy = vi.spyOn(idx, 'search')
      const matrixSpy = vi.spyOn(idx, 'distanceMatrix'!)

      const mem = memory({
        model: embedder,
        index: idx,
        collection: 'requests',
        variants: ['questionnaire'],
      })

      const result = await mem.sample(2, {
        query: 'test query',
        pool: 3,
      })

      expect(embedSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy).toHaveBeenCalledWith(
        'requests',
        expect.any(Array),
        expect.objectContaining({
          topK: 3,
          variant: stubVectorKey('questionnaire'),
        }),
      )
      expect(matrixSpy).toHaveBeenCalledWith(
        'requests',
        expect.objectContaining({
          variant: stubVectorKey('questionnaire'),
          filter: expect.objectContaining({
            must: expect.arrayContaining([expect.objectContaining({ has_id: expect.any(Array) })]),
          }),
        }),
      )
      expect(result.matches).toHaveLength(2)
      expect(result.embedding).toBeDefined()
      expect(result.embedding).toHaveLength(4)
    })

    it('throws when n > pool', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: {},
      })

      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await expect(mem.sample(10, { pool: 5 })).rejects.toThrow(/Cannot sample 10 from pool of 5/)
    })

    it('supports n=1 when candidate pool has one point', async () => {
      const idx = createStubIndex()
      idx.stored.set('p1', {
        id: 'p1',
        vectors: { [stubVectorKey('default')]: [1, 2, 3, 4] },
        metadata: {},
      })
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })
      const result = await mem.sample(1, { query: 'one', pool: 1 })
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0].id).toBe('p1')
    })
  })

  describe('inMemoryIndex', () => {
    const createIndex = () => inMemoryIndex()

    it('search returns matches sorted by cosine similarity', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'first', metadata: { org: 'o1' } },
        { id: 'b', content: 'second', metadata: { org: 'o2' } },
      ])

      const result = await mem.search('query')
      expect(result.matches).toHaveLength(2)
      expect(result.matches[0].score).toBeGreaterThanOrEqual(result.matches[1].score)
      expect(result.embedding).toHaveLength(4)
    })

    it('upsert preserves metadata per entity across variants', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
        variants: ['v1', 'v2'],
      })
      const v2 = mem.variant.v2

      await mem.upsert({ id: 'x', content: 'text', metadata: { k: 'val' } })
      await v2.upsert({ id: 'x', content: 'other text' })

      const result = await idx.get('test', ['x'])
      expect(result[0].metadata.k).toBe('val')
    })

    it('updateMetadata merges and deletes null keys', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert({
        id: 'x',
        content: 'text',
        metadata: { a: '1', b: '2' },
      })
      await mem.updateMetadata('x', { b: null, c: '3' } as Record<string, unknown>)

      const result = await idx.get('test', ['x'])
      expect(result[0].metadata.a).toBe('1')
      expect(result[0].metadata.c).toBe('3')
      expect(result[0].metadata).not.toHaveProperty('b')
    })

    it('search respects filters', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'text a', metadata: { org: 'acme' } },
        { id: 'b', content: 'text b', metadata: { org: 'other' } },
      ])

      const result = await mem.search('query', {
        filter: { must: [{ key: 'org', match: { value: 'acme' } }] },
      })
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0].id).toBe('a')
    })

    it('distanceMatrix returns pairwise scores', async () => {
      const idx = await createIndex()
      await idx.upsert(
        'test',
        [
          { id: 'a', embedding: [1, 0, 0, 0] },
          { id: 'b', embedding: [0, 1, 0, 0] },
          { id: 'c', embedding: [1, 0, 0, 0] },
        ],
        { variant: 'v' },
      )

      const result = await idx.distanceMatrix('test', {
        variant: 'v',
        sample: 3,
      })
      expect(result.pairs).toHaveLength(3)
      const acPair = result.pairs.find(
        (p) => (p.a === 'a' && p.b === 'c') || (p.a === 'c' && p.b === 'a'),
      )
      expect(acPair!.score).toBeCloseTo(1.0)
    })

    it('distanceMatrix respects limit parameter', async () => {
      const idx = await createIndex()
      await idx.upsert(
        'test',
        [
          { id: 'a', embedding: [1, 0, 0, 0] },
          { id: 'b', embedding: [0.9, 0.44, 0, 0] },
          { id: 'c', embedding: [0, 0, 1, 0] },
        ],
        { variant: 'v' },
      )

      const full = await idx.distanceMatrix('test', {
        variant: 'v',
        sample: 3,
      })
      expect(full.pairs).toHaveLength(3)

      const limited = await idx.distanceMatrix('test', {
        variant: 'v',
        sample: 3,
        limit: 1,
      })
      expect(limited.pairs.length).toBeLessThan(3)
    })

    it('sample works end-to-end', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'first', metadata: { org: 'o1' } },
        { id: 'b', content: 'second', metadata: { org: 'o1' } },
        { id: 'c', content: 'third', metadata: { org: 'o1' } },
      ])

      const result = await mem.sample(2, { pool: 3 })
      expect(result.matches).toHaveLength(2)
      expect(new Set(result.matches.map((m) => m.id)).size).toBe(2)
    })

    it('mem.delete removes points by id', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'text a', metadata: { org: 'x' } },
        { id: 'b', content: 'text b', metadata: { org: 'y' } },
      ])

      await mem.delete(['a'])
      expect(await mem.count()).toBe(1)
      const { matches } = await mem.search('query')
      expect(matches).toHaveLength(1)
      expect(matches[0].id).toBe('b')
    })

    it('mem.deleteByFilter removes matching points', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'text a', metadata: { org: 'acme' } },
        { id: 'b', content: 'text b', metadata: { org: 'other' } },
      ])

      await mem.deleteByFilter({ org: 'acme' })
      expect(await mem.count()).toBe(1)
      const { matches } = await mem.search('query')
      expect(matches).toHaveLength(1)
      expect(matches[0].id).toBe('b')
    })

    it('delete removes points', async () => {
      const idx = await createIndex()
      await idx.upsert('test', [{ id: 'x', embedding: [1, 0], metadata: { k: 'v' } }], {
        variant: 'v',
      })
      await idx.delete('test', ['x'])
      const result = await idx.get('test', ['x'])
      expect(result[0].metadata).toEqual({})
    })

    it('deleteByFilter removes matching points', async () => {
      const idx = await createIndex()
      await idx.upsert(
        'test',
        [
          { id: 'a', embedding: [1, 0], metadata: { org: 'x' } },
          { id: 'b', embedding: [0, 1], metadata: { org: 'y' } },
        ],
        { variant: 'v' },
      )
      await idx.deleteByFilter('test', {
        must: [{ key: 'org', match: { value: 'x' } }],
      })
      const results = await idx.search('test', [1, 0], { variant: 'v' })
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('b')
    })

    it('scroll paginates through all points', async () => {
      const idx = await createIndex()
      await idx.upsert(
        'test',
        [
          { id: 'a', embedding: [1, 0], metadata: { x: 1 } },
          { id: 'b', embedding: [0, 1], metadata: { x: 2 } },
          { id: 'c', embedding: [1, 1], metadata: { x: 3 } },
        ],
        { variant: 'v' },
      )

      const page1 = await idx.scroll!('test', { variant: 'v', limit: 2 })
      expect(page1.points).toHaveLength(2)
      expect(page1.nextOffset).toBeDefined()

      const page2 = await idx.scroll!('test', {
        variant: 'v',
        limit: 2,
        offset: page1.nextOffset,
      })
      expect(page2.points).toHaveLength(1)
      expect(page2.nextOffset).toBeUndefined()
    })

    it('scroll returns vectors when includeVectors is true', async () => {
      const idx = await createIndex()
      await idx.upsert('test', [{ id: 'a', embedding: [1, 0] }], {
        variant: 'v',
      })

      const withVec = await idx.scroll!('test', {
        variant: 'v',
        includeVectors: true,
      })
      expect(withVec.points[0].embedding).toBeDefined()
      expect(withVec.points[0].embedding!.length).toBe(2)

      const withoutVec = await idx.scroll!('test', { variant: 'v' })
      expect(withoutVec.points[0].embedding).toBeUndefined()
    })

    it('scroll filters by metadata', async () => {
      const idx = await createIndex()
      await idx.upsert(
        'test',
        [
          { id: 'a', embedding: [1, 0], metadata: { org: 'x' } },
          { id: 'b', embedding: [0, 1], metadata: { org: 'y' } },
        ],
        { variant: 'v' },
      )
      const page = await idx.scroll!('test', {
        variant: 'v',
        filter: { must: [{ key: 'org', match: { value: 'x' } }] },
      })
      expect(page.points).toHaveLength(1)
      expect(page.points[0].id).toBe('a')
    })

    it('count returns total points', async () => {
      const idx = await createIndex()
      await idx.upsert(
        'test',
        [
          { id: 'a', embedding: [1, 0], metadata: { org: 'x' } },
          { id: 'b', embedding: [0, 1], metadata: { org: 'y' } },
        ],
        { variant: 'v' },
      )
      expect(await idx.count!('test', { variant: 'v' })).toBe(2)
    })

    it('count respects filter', async () => {
      const idx = await createIndex()
      await idx.upsert(
        'test',
        [
          { id: 'a', embedding: [1, 0], metadata: { org: 'x' } },
          { id: 'b', embedding: [0, 1], metadata: { org: 'y' } },
        ],
        { variant: 'v' },
      )
      expect(
        await idx.count!('test', {
          variant: 'v',
          filter: { must: [{ key: 'org', match: { value: 'x' } }] },
        }),
      ).toBe(1)
    })

    it('count returns 0 for empty collection', async () => {
      const idx = await createIndex()
      expect(await idx.count!('test', { variant: 'v' })).toBe(0)
    })

    it('search respects datetime range filters with string bounds', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        {
          id: 'old',
          content: 'old item',
          metadata: { createdAt: '2025-01-15T00:00:00Z' },
        },
        {
          id: 'mid',
          content: 'mid item',
          metadata: { createdAt: '2026-01-15T00:00:00Z' },
        },
        {
          id: 'new',
          content: 'new item',
          metadata: { createdAt: '2026-06-15T00:00:00Z' },
        },
      ])

      const result = await mem.search('query', {
        filter: {
          must: [
            {
              key: 'createdAt',
              range: {
                gte: '2026-01-01T00:00:00Z',
                lt: '2026-07-01T00:00:00Z',
              },
            },
          ],
        },
      })
      expect(result.matches.map((m) => m.id).toSorted()).toEqual(['mid', 'new'])
    })

    it('numeric range filters still work after datetime support', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'text a', metadata: { score: 10 } },
        { id: 'b', content: 'text b', metadata: { score: 50 } },
        { id: 'c', content: 'text c', metadata: { score: 90 } },
      ])

      const result = await mem.search('query', {
        filter: { must: [{ key: 'score', range: { gte: 20, lte: 80 } }] },
      })
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0].id).toBe('b')
    })

    it('nested filter in should enables per-slice compound conditions', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        {
          id: 'med-1',
          content: 'Metformin',
          metadata: { kind: 'medication', drug: 'Metformin', refills: 3 },
        },
        {
          id: 'med-2',
          content: 'Aspirin',
          metadata: { kind: 'medication', drug: 'Aspirin', refills: 0 },
        },
        {
          id: 'prob-1',
          content: 'Diabetes',
          metadata: { kind: 'problem', severity: 'high' },
        },
        {
          id: 'prob-2',
          content: 'Headache',
          metadata: { kind: 'problem', severity: 'low' },
        },
      ])

      const result = await mem.search('query', {
        filter: {
          should: [
            {
              must: [
                { key: 'drug', match: { value: 'Metformin' } },
                { key: 'refills', range: { gt: 0 } },
              ],
            },
            { must: [{ key: 'severity', match: { value: 'high' } }] },
          ],
        },
      })
      const ids = result.matches.map((m) => m.id).toSorted()
      expect(ids).toEqual(['med-1', 'prob-1'])
    })

    it('nested filter in must_not excludes compound matches', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        {
          id: 'a',
          content: 'text a',
          metadata: { org: 'acme', role: 'admin' },
        },
        {
          id: 'b',
          content: 'text b',
          metadata: { org: 'acme', role: 'user' },
        },
        {
          id: 'c',
          content: 'text c',
          metadata: { org: 'other', role: 'admin' },
        },
      ])

      const result = await mem.search('query', {
        filter: {
          must_not: [
            {
              must: [
                { key: 'org', match: { value: 'acme' } },
                { key: 'role', match: { value: 'admin' } },
              ],
            },
          ],
        },
      })
      const ids = result.matches.map((m) => m.id).toSorted()
      expect(ids).toEqual(['b', 'c'])
    })

    it('nested filter in must narrows results with sub-group', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        {
          id: 'a',
          content: 'text a',
          metadata: { org: 'acme', status: 'active' },
        },
        {
          id: 'b',
          content: 'text b',
          metadata: { org: 'acme', status: 'archived' },
        },
        {
          id: 'c',
          content: 'text c',
          metadata: { org: 'other', status: 'active' },
        },
      ])

      const result = await mem.search('query', {
        filter: {
          must: [
            { key: 'status', match: { value: 'active' } },
            {
              should: [
                { key: 'org', match: { value: 'acme' } },
                { key: 'org', match: { value: 'other' } },
              ],
            },
          ],
        },
      })
      const ids = result.matches.map((m) => m.id).toSorted()
      expect(ids).toEqual(['a', 'c'])
    })

    it('get retrieves points by id with cleaned metadata', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      await mem.upsert([
        { id: 'a', content: 'hello world', metadata: { org: 'acme' } },
        { id: 'b', content: 'foo bar', metadata: { org: 'other' } },
      ])

      const results = await mem.get(['a', 'b'])
      expect(results).toHaveLength(2)
      expect(results[0].id).toBe('a')
      expect(results[0].content).toBe('hello world')
      expect(results[0].metadata.org).toBe('acme')
      expect(results[1].id).toBe('b')
      expect(results[1].content).toBe('foo bar')
    })

    it('variant get returns content from the requested variant', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
        variants: ['v1', 'v2'],
      })
      await mem.variant.v1.upsert({ id: 'x', content: 'summary' })
      await mem.variant.v2.upsert({ id: 'x', content: 'full' })
      const r1 = await mem.variant.v1.get(['x'])
      const r2 = await mem.variant.v2.get(['x'])
      expect(r1[0].content).toBe('summary')
      expect(r2[0].content).toBe('full')
    })

    it('returning() searches one variant but returns content from another', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
        variants: ['summary', 'detailed'],
      })
      await mem.variant.summary.upsert({ id: 'x', content: 'short summary' })
      await mem.variant.detailed.upsert({
        id: 'x',
        content: 'full detailed text',
      })

      const view = mem.variant.summary.returning('detailed')
      const { matches } = await view.search('query')
      expect(matches).toHaveLength(1)
      expect(matches[0].content).toBe('full detailed text')
    })

    it('returning() get returns content from the specified variant', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
        variants: ['summary', 'detailed'],
      })
      await mem.variant.summary.upsert({ id: 'x', content: 'short' })
      await mem.variant.detailed.upsert({ id: 'x', content: 'long text' })

      const results = await mem.variant.summary.returning('detailed').get(['x'])
      expect(results[0].content).toBe('long text')
    })

    it('get returns empty array for empty input', async () => {
      const idx = await createIndex()
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
      })

      const results = await mem.get([])
      expect(results).toHaveLength(0)
    })

    it('slices() subset search returns only selected slices', async () => {
      const idx = await createIndex()
      const medSchema = z.object({ drug: z.string() })
      const probSchema = z.object({ icd10: z.string() })
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
        slices: {
          medication: { metadata: medSchema },
          problem: { metadata: probSchema },
        },
      })

      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.problem.upsert({
        id: 'prob-1',
        content: 'Hypertension',
        metadata: { icd10: 'I10' },
      })

      const subset = mem.slices(['medication'])
      const { matches } = await subset.search('query')
      expect(matches).toHaveLength(1)
      expect(matches[0].kind).toBe('medication')
    })

    it('slices() subset deleteByFilter only affects selected slices', async () => {
      const idx = await createIndex()
      const medSchema = z.object({ drug: z.string() })
      const probSchema = z.object({ icd10: z.string() })
      const mem = memory({
        model: createStubEmbedder(),
        index: idx,
        collection: 'test',
        slices: {
          medication: { metadata: medSchema },
          problem: { metadata: probSchema },
        },
      })

      await mem.slice.medication.upsert({
        id: 'med-1',
        content: 'Metformin',
        metadata: { drug: 'Metformin' },
      })
      await mem.slice.problem.upsert({
        id: 'prob-1',
        content: 'Hypertension',
        metadata: { icd10: 'I10' },
      })

      await mem.slices(['medication']).deleteByFilter({ drug: 'Metformin' })

      const all = await mem.search('query')
      expect(all.matches).toHaveLength(1)
      expect(all.matches[0].kind).toBe('problem')
    })
  })

  describe('pgvector factory', () => {
    it('returns a PgVectorConfig', () => {
      const config = pgvector({
        connectionString: 'postgresql://localhost/test',
      })
      expect(config.provider).toBe('pgvector')
      expect(config.connectionString).toBe('postgresql://localhost/test')
    })

    it('accepts optional schema and retry', () => {
      const config = pgvector({
        connectionString: 'postgresql://localhost/test',
        schema: 'vectors',
        retry: {
          maxAttempts: 5,
          initialDelayMs: 100,
          maxDelayMs: 10_000,
          backoffMultiplier: 2,
        },
      })
      expect(config.schema).toBe('vectors')
      expect(config.retry?.maxAttempts).toBe(5)
    })
  })
})
