import { createHash } from 'node:crypto'

function expectedUuidv5(name: string): string {
  const ns = Buffer.from('0f6f7d7df59e5ba9a47bbd991189e8f6', 'hex')
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

interface StoredPoint {
  id: string | number
  vector?: unknown
  payload: Record<string, unknown>
}

type Store = Map<string, Map<string, StoredPoint>>

function getCollection(store: Store, name: string) {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

function createMockClient(store: Store) {
  return {
    async batchUpdate(collection: string, opts: { operations: unknown[] }) {
      const coll = getCollection(store, collection)
      for (const op of opts.operations as Record<string, unknown>[]) {
        if (op.upsert) {
          const u = op.upsert as {
            points: Array<{ id: string | number; vector: unknown }>
          }
          for (const p of u.points) {
            const existing = coll.get(String(p.id))
            coll.set(String(p.id), {
              id: p.id,
              vector: p.vector,
              payload: existing?.payload ?? {},
            })
          }
        }
        if (op.update_vectors) {
          const u = op.update_vectors as {
            points: Array<{ id: string | number; vector: unknown }>
          }
          for (const p of u.points) {
            const existing = coll.get(String(p.id))
            if (existing) {
              existing.vector =
                typeof existing.vector === 'object' &&
                existing.vector !== null &&
                !Array.isArray(existing.vector)
                  ? {
                      ...(existing.vector as Record<string, unknown>),
                      ...(p.vector as Record<string, unknown>),
                    }
                  : p.vector
            }
          }
        }
        if (op.set_payload) {
          const sp = op.set_payload as {
            payload: Record<string, unknown>
            points: Array<string | number>
          }
          for (const id of sp.points) {
            const pt = coll.get(String(id))
            if (pt) Object.assign(pt.payload, sp.payload)
          }
        }
        if (op.delete_payload) {
          const dp = op.delete_payload as {
            keys: string[]
            points: Array<string | number>
          }
          for (const id of dp.points) {
            const pt = coll.get(String(id))
            if (pt) {
              for (const k of dp.keys) delete pt.payload[k]
            }
          }
        }
      }
    },
    async query(collection: string, opts: Record<string, unknown>) {
      const coll = getCollection(store, collection)
      const limit = (opts.limit as number) ?? 10
      let candidates = Array.from(coll.values())
      const filter = opts.filter as { must?: Array<{ has_id?: unknown[] }> } | undefined
      const hasIdEntry = filter?.must?.find((c) => 'has_id' in c)
      if (hasIdEntry) {
        const allowed = new Set((hasIdEntry.has_id as unknown[]).map(String))
        candidates = candidates.filter((p) => allowed.has(String(p.id)))
      }
      const points = candidates
        .slice(0, limit)
        .map((p) => ({ id: p.id, score: 0.9, payload: { ...p.payload } }))
      return { points }
    },
    async retrieve(collection: string, opts: { ids: unknown[] }) {
      const coll = getCollection(store, collection)
      return opts.ids
        .map((id) => coll.get(String(id)))
        .filter(Boolean)
        .map((p) => ({ id: p!.id, payload: { ...p!.payload } }))
    },
    async scroll(collection: string, opts: Record<string, unknown>) {
      const coll = getCollection(store, collection)
      const limit = (opts.limit as number) ?? 100
      const allPoints = Array.from(coll.values())
      const points = allPoints.slice(0, limit).map((p) => ({
        id: p.id,
        payload: { ...p.payload },
      }))
      return {
        result: {
          points,
          next_page_offset: allPoints.length > limit ? allPoints[limit].id : null,
        },
      }
    },
    async searchMatrixPairs(collection: string, opts: Record<string, unknown>) {
      const coll = getCollection(store, collection)
      let ids: string[]
      const filter = opts.filter as { must?: Array<{ has_id?: unknown[] }> } | undefined
      const hasIdEntry = filter?.must?.find((c) => 'has_id' in c)
      if (hasIdEntry) {
        ids = (hasIdEntry.has_id as unknown[]).map(String)
      } else {
        ids = Array.from(coll.keys())
      }
      const sample = (opts.sample as number) ?? ids.length
      ids = ids.slice(0, sample)
      const pairs: Array<{
        a: string | number
        b: string | number
        score: number
      }> = []
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const ptA = coll.get(ids[i])
          const ptB = coll.get(ids[j])
          if (ptA && ptB) pairs.push({ a: ptA.id, b: ptB.id, score: 0.5 })
        }
      }
      return { result: { pairs } }
    },
    async delete(collection: string, opts: { points?: unknown[]; filter?: unknown }) {
      const coll = getCollection(store, collection)
      if (opts.points) {
        for (const id of opts.points) coll.delete(String(id))
      }
    },
    async setPayload(
      collection: string,
      opts: {
        points: Array<string | number>
        payload: Record<string, unknown>
      },
    ) {
      const coll = getCollection(store, collection)
      for (const id of opts.points) {
        const pt = coll.get(String(id))
        if (pt) Object.assign(pt.payload, opts.payload)
      }
    },
    async deletePayload(
      collection: string,
      opts: { points: Array<string | number>; keys: string[] },
    ) {
      const coll = getCollection(store, collection)
      for (const id of opts.points) {
        const pt = coll.get(String(id))
        if (pt) {
          for (const k of opts.keys) delete pt.payload[k]
        }
      }
    },
    async count(collection: string) {
      const coll = getCollection(store, collection)
      return { result: { count: coll.size } }
    },
  }
}

let mockStore: Store

import { createQdrantIndex } from './qdrant'

function createIndex() {
  return createQdrantIndex(
    {
      provider: 'qdrant',
      url: 'http://localhost:6333',
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
    },
    createMockClient(mockStore),
  )
}

describe('Qdrant ID mapping', () => {
  beforeEach(() => {
    mockStore = new Map()
  })

  describe('upsert + get round-trip', () => {
    it('arbitrary string IDs round-trip through upsert and get', async () => {
      const idx = createIndex()
      await idx.upsert('test', [
        { id: 'req-1', embedding: [1, 0], metadata: { org: 'acme' } },
        { id: 'med-123', embedding: [0, 1], metadata: { drug: 'aspirin' } },
      ])

      const results = await idx.get('test', ['req-1', 'med-123'])
      expect(results).toHaveLength(2)
      expect(results[0].id).toBe('req-1')
      expect(results[1].id).toBe('med-123')
    })

    it('_original_id never leaks into returned metadata', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'req-1', embedding: [1, 0], metadata: { org: 'acme' } }])

      const results = await idx.get('test', ['req-1'])
      expect(results[0].metadata).toEqual({ org: 'acme' })
      expect(results[0].metadata).not.toHaveProperty('_original_id')
    })

    it('_original_id is stored in Qdrant payload for non-UUID IDs', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'req-1', embedding: [1, 0] }])

      const uuid = expectedUuidv5('req-1')
      const coll = mockStore.get('test')!
      const raw = coll.get(uuid)
      expect(raw).toBeDefined()
      expect(raw!.payload._original_id).toBe('req-1')
    })
  })

  describe('UUID and integer passthrough', () => {
    it('UUID IDs pass through unchanged with no _original_id in payload', async () => {
      const idx = createIndex()
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      await idx.upsert('test', [{ id: uuid, embedding: [1, 0], metadata: { x: 1 } }])

      const coll = mockStore.get('test')!
      const raw = coll.get(uuid)
      expect(raw).toBeDefined()
      expect(raw!.id).toBe(uuid)
      expect(raw!.payload).not.toHaveProperty('_original_id')

      const results = await idx.get('test', [uuid])
      expect(results[0].id).toBe(uuid)
    })

    it('integer string IDs pass through as numbers with no _original_id', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: '42', embedding: [1, 0], metadata: { x: 1 } }])

      const coll = mockStore.get('test')!
      const raw = coll.get('42')
      expect(raw).toBeDefined()
      expect(raw!.id).toBe(42)
      expect(raw!.payload).not.toHaveProperty('_original_id')

      const results = await idx.get('test', ['42'])
      expect(results[0].id).toBe('42')
    })

    it('large unsafe integers route through UUID v5', async () => {
      const idx = createIndex()
      const bigInt = '9007199254740993'
      await idx.upsert('test', [{ id: bigInt, embedding: [1, 0] }])

      const uuid = expectedUuidv5(bigInt)
      const coll = mockStore.get('test')!
      expect(coll.has(uuid)).toBe(true)
      const raw = coll.get(uuid)!
      expect(raw.payload._original_id).toBe(bigInt)

      const results = await idx.get('test', [bigInt])
      expect(results[0].id).toBe(bigInt)
    })
  })

  describe('search', () => {
    it('returns original IDs and strips _original_id from metadata', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'req-1', embedding: [1, 0], metadata: { org: 'acme' } }])

      const results = await idx.search('test', [1, 0])
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('req-1')
      expect(results[0].metadata).toEqual({ org: 'acme' })
      expect(results[0].metadata).not.toHaveProperty('_original_id')
    })
  })

  describe('scroll', () => {
    it('returns original IDs and strips _original_id from metadata', async () => {
      const idx = createIndex()
      await idx.upsert('test', [
        { id: 'req-1', embedding: [1, 0], metadata: { org: 'acme' } },
        { id: 'req-2', embedding: [0, 1], metadata: { org: 'other' } },
      ])

      const result = await idx.scroll('test', { limit: 10 })
      expect(result.points).toHaveLength(2)
      const ids = result.points.map((p) => p.id).toSorted()
      expect(ids).toEqual(['req-1', 'req-2'])
      for (const p of result.points) {
        expect(p.metadata).not.toHaveProperty('_original_id')
      }
    })
  })

  describe('get ordering and missing', () => {
    it('preserves input ordering', async () => {
      const idx = createIndex()
      await idx.upsert('test', [
        { id: 'a', embedding: [1, 0] },
        { id: 'b', embedding: [0, 1] },
        { id: 'c', embedding: [1, 1] },
      ])

      const results = await idx.get('test', ['c', 'a', 'b'])
      expect(results.map((r) => r.id)).toEqual(['c', 'a', 'b'])
    })

    it('throws on missing IDs', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'a', embedding: [1, 0] }])

      await expect(idx.get('test', ['a', 'missing'])).rejects.toThrow(/Point "missing" not found/)
    })
  })

  describe('delete', () => {
    it('maps IDs through to Qdrant format', async () => {
      const idx = createIndex()
      await idx.upsert('test', [
        { id: 'req-1', embedding: [1, 0] },
        { id: 'req-2', embedding: [0, 1] },
      ])

      const coll = mockStore.get('test')!
      expect(coll.size).toBe(2)

      await idx.delete('test', ['req-1'])
      expect(coll.size).toBe(1)
      expect(coll.has(expectedUuidv5('req-1'))).toBe(false)
    })
  })

  describe('updateMetadata', () => {
    it('targets the mapped Qdrant ID', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'req-1', embedding: [1, 0], metadata: { org: 'old' } }])

      await idx.updateMetadata('test', 'req-1', { org: 'new' })

      const results = await idx.get('test', ['req-1'])
      expect(results[0].metadata).toEqual({ org: 'new' })
    })
  })

  describe('has_id filter', () => {
    it('converts IDs in has_id conditions', async () => {
      const idx = createIndex()
      await idx.upsert('test', [
        { id: 'req-1', embedding: [1, 0], metadata: { org: 'acme' } },
        { id: 'req-2', embedding: [0, 1], metadata: { org: 'other' } },
        { id: 'req-3', embedding: [1, 1], metadata: { org: 'acme' } },
      ])

      const results = await idx.search('test', [1, 0], {
        filter: { must: [{ has_id: ['req-1', 'req-3'] }] },
        topK: 10,
      })
      const ids = results.map((r) => r.id).toSorted()
      expect(ids).toEqual(['req-1', 'req-3'])
    })
  })

  describe('distanceMatrix', () => {
    it('returns original IDs with has_id filter', async () => {
      const idx = createIndex()
      await idx.upsert('test', [
        { id: 'req-1', embedding: [1, 0] },
        { id: 'req-2', embedding: [0, 1] },
        { id: 'req-3', embedding: [1, 1] },
      ])

      const result = await idx.distanceMatrix('test', {
        filter: { must: [{ has_id: ['req-1', 'req-2', 'req-3'] }] },
        sample: 3,
      })

      const allIds = new Set<string>()
      for (const p of result.pairs) {
        allIds.add(p.a)
        allIds.add(p.b)
      }
      expect(allIds).toEqual(new Set(['req-1', 'req-2', 'req-3']))
    })

    it('returns original IDs without has_id filter (batch retrieve fallback)', async () => {
      const idx = createIndex()
      await idx.upsert('test', [
        { id: 'req-1', embedding: [1, 0] },
        { id: 'req-2', embedding: [0, 1] },
      ])

      const result = await idx.distanceMatrix('test', { sample: 2 })

      const allIds = new Set<string>()
      for (const p of result.pairs) {
        allIds.add(p.a)
        allIds.add(p.b)
      }
      expect(allIds).toEqual(new Set(['req-1', 'req-2']))
    })
  })

  describe('variant upsert preserves other vectors', () => {
    it('second variant upsert merges rather than replacing', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'req-1', embedding: [1, 0], metadata: { org: 'acme' } }], {
        variant: 'created',
      })

      // Point should exist with "created" vector
      const uuid = expectedUuidv5('req-1')
      const coll = mockStore.get('test')!
      expect((coll.get(uuid)!.vector as Record<string, unknown>).created).toEqual([1, 0])

      // Upsert with a different variant
      await idx.upsert(
        'test',
        [{ id: 'req-1', embedding: [0, 1], metadata: { status: 'closed' } }],
        { variant: 'closed' },
      )

      const raw = coll.get(uuid)!
      const vectors = raw.vector as Record<string, number[]>
      expect(vectors.created).toEqual([1, 0])
      expect(vectors.closed).toEqual([0, 1])
      // Metadata should be merged too
      expect(raw.payload).toMatchObject({ org: 'acme', status: 'closed' })
    })

    it('first variant upsert on new point uses upsert', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'req-1', embedding: [1, 0] }], { variant: 'created' })

      const uuid = expectedUuidv5('req-1')
      const coll = mockStore.get('test')!
      expect(coll.has(uuid)).toBe(true)
      expect((coll.get(uuid)!.vector as Record<string, unknown>).created).toEqual([1, 0])
    })
  })

  describe('upsert without metadata', () => {
    it('still stores _original_id when no metadata is provided', async () => {
      const idx = createIndex()
      await idx.upsert('test', [{ id: 'req-1', embedding: [1, 0] }])

      const uuid = expectedUuidv5('req-1')
      const coll = mockStore.get('test')!
      expect(coll.get(uuid)!.payload._original_id).toBe('req-1')

      const results = await idx.get('test', ['req-1'])
      expect(results[0].id).toBe('req-1')
      expect(results[0].metadata).toEqual({})
    })
  })
})
