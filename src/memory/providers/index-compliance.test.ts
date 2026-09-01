import type { VectorIndex, Point } from '../types'

import { inMemoryIndex } from './inMemoryIndex'

/**
 * Provider-agnostic VectorIndex compliance suite. Every index provider must pass it — the in-memory
 * index is the reference implementation, and each backend registers below with its own
 * setup/teardown. Asserts only contract-level behavior the providers share: where the contract
 * leaves room (which variant an unspecified-variant search reads, scroll token format), the tests
 * page through tokens opaquely and assert per-id semantics, never internals.
 */
const point = (id: string, embedding: number[], metadata?: Record<string, unknown>): Point => ({
  id,
  embedding,
  ...(metadata === undefined ? {} : { metadata }),
})

export function runVectorIndexTests(
  name: string,
  createIndex: () => Promise<VectorIndex>,
  cleanup?: () => Promise<void> | void,
) {
  describe(`${name} — VectorIndex compliance`, () => {
    let index: VectorIndex

    beforeEach(async () => {
      index = await createIndex()
    })

    afterEach(async () => {
      await index.close?.()
      await cleanup?.()
    })

    const seed = async (collection: string) => {
      await index.upsert(collection, [
        point('a', [1, 0, 0], { kind: 'note', rank: 'high' }),
        point('b', [0.9, 0.1, 0], { kind: 'note', rank: 'low' }),
        point('c', [0, 1, 0], { kind: 'task', rank: 'high' }),
      ])
    }

    describe('search', () => {
      test('returns matches ranked by similarity', async () => {
        await seed('search_rank')
        const results = await index.search('search_rank', [1, 0, 0])
        expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c'])
        expect(results[0].score).toBeCloseTo(1, 5)
        expect(results[0].metadata).toEqual({ kind: 'note', rank: 'high' })
      })

      test('topK truncates', async () => {
        await seed('search_topk')
        const results = await index.search('search_topk', [1, 0, 0], { topK: 2 })
        expect(results.map((r) => r.id)).toEqual(['a', 'b'])
      })

      test('minScore drops weak matches', async () => {
        await seed('search_minscore')
        const results = await index.search('search_minscore', [1, 0, 0], { minScore: 0.5 })
        expect(results.map((r) => r.id)).toEqual(['a', 'b'])
      })

      test('filter narrows by metadata', async () => {
        await seed('search_filter')
        const results = await index.search('search_filter', [1, 0, 0], {
          filter: { must: [{ key: 'kind', match: { value: 'task' } }] },
        })
        expect(results.map((r) => r.id)).toEqual(['c'])
      })

      test('filtered search finds a match ranked beyond any overfetch window', async () => {
        // 120 near-identical points outrank the one the filter wants, so a provider that KNN-fetches
        // a fixed window and filters afterwards comes back empty instead of finding it.
        const crowd = Array.from({ length: 120 }, (_, i) =>
          point(`crowd-${i}`, [1, 0.0001 * i, 0], { kind: 'common' }),
        )
        await index.upsert('search_deep_filter', [
          ...crowd,
          point('rare', [0, 0, 1], { kind: 'rare' }),
        ])
        const results = await index.search('search_deep_filter', [1, 0, 0], {
          topK: 5,
          filter: { must: [{ key: 'kind', match: { value: 'rare' } }] },
        })
        expect(results.map((r) => r.id)).toEqual(['rare'])
      })

      test('each id appears at most once when no variant is named', async () => {
        await index.upsert('search_dedup', [point('a', [1, 0, 0])], { variant: 'v1' })
        await index.upsert('search_dedup', [point('a', [0.9, 0.1, 0])], { variant: 'v2' })
        const results = await index.search('search_dedup', [1, 0, 0])
        // Which variant an unspecified-variant search reads is provider latitude (the reference
        // reads each id's first row; pgvector reads the 'default' variant) — the contract-level
        // fact is only that one id never appears twice in one result.
        expect(results.filter((r) => r.id === 'a').length).toBeLessThanOrEqual(1)
      })

      test('named variant searches that variant’s vectors', async () => {
        await index.upsert('search_variant', [point('a', [1, 0, 0])], { variant: 'v1' })
        await index.upsert('search_variant', [point('a', [0, 1, 0])], { variant: 'v2' })
        const results = await index.search('search_variant', [0, 1, 0], { variant: 'v2' })
        expect(results).toHaveLength(1)
        expect(results[0].score).toBeCloseTo(1, 5)
      })

      test('empty collection returns no matches', async () => {
        expect(await index.search('search_empty', [1, 0, 0])).toEqual([])
      })
    })

    describe('upsert', () => {
      test('re-upserting an id replaces its embedding', async () => {
        await index.upsert('upsert_replace', [point('a', [1, 0, 0]), point('far', [0, 0, 1])])
        await index.upsert('upsert_replace', [point('a', [0, 1, 0])])
        const results = await index.search('upsert_replace', [0, 1, 0], { topK: 1 })
        expect(results[0].id).toBe('a')
        expect(results[0].score).toBeCloseTo(1, 5)
      })

      test('metadata merges across upserts; null deletes a key', async () => {
        await index.upsert('upsert_merge', [point('a', [1, 0, 0], { keep: 'x', drop: 'y' })])
        await index.upsert('upsert_merge', [point('a', [1, 0, 0], { drop: null, added: 'z' })])
        const [row] = await index.get('upsert_merge', ['a'])
        expect(row.metadata).toEqual({ keep: 'x', added: 'z' })
      })
    })

    describe('delete', () => {
      test('removes the named ids only', async () => {
        await seed('delete_ids')
        await index.delete('delete_ids', ['a', 'b'])
        expect(await index.count('delete_ids')).toBe(1)
        expect((await index.search('delete_ids', [1, 0, 0])).map((r) => r.id)).toEqual(['c'])
      })

      test('deleteByFilter removes matching points only', async () => {
        await seed('delete_filter')
        await index.deleteByFilter('delete_filter', {
          must: [{ key: 'kind', match: { value: 'note' } }],
        })
        expect(await index.count('delete_filter')).toBe(1)
        expect((await index.search('delete_filter', [0, 1, 0])).map((r) => r.id)).toEqual(['c'])
      })
    })

    describe('metadata', () => {
      test('updateMetadata merges into existing metadata', async () => {
        await seed('meta_update')
        await index.updateMetadata('meta_update', 'a', { rank: 'archived', extra: 'yes' })
        const [row] = await index.get('meta_update', ['a'])
        expect(row.metadata).toEqual({ kind: 'note', rank: 'archived', extra: 'yes' })
      })

      test('get returns empty metadata for unknown ids', async () => {
        await seed('meta_get')
        const rows = await index.get('meta_get', ['a', 'missing'])
        expect(rows).toEqual([
          { id: 'a', metadata: { kind: 'note', rank: 'high' } },
          { id: 'missing', metadata: {} },
        ])
      })
    })

    describe('scroll', () => {
      test('pages through every point via nextOffset', async () => {
        await seed('scroll_pages')
        const seen: string[] = []
        let offset: string | undefined
        for (let guard = 0; guard < 10; guard++) {
          const page = await index.scroll('scroll_pages', {
            limit: 2,
            ...(offset === undefined ? {} : { offset }),
          })
          expect(page.points.length).toBeLessThanOrEqual(2)
          seen.push(...page.points.map((p) => p.id))
          if (page.nextOffset === undefined) break
          offset = page.nextOffset
        }
        expect(seen.toSorted()).toEqual(['a', 'b', 'c'])
      })

      test('filter applies and includeVectors round-trips embeddings', async () => {
        await seed('scroll_vectors')
        const page = await index.scroll('scroll_vectors', {
          filter: { must: [{ key: 'kind', match: { value: 'task' } }] },
          includeVectors: true,
        })
        expect(page.points).toHaveLength(1)
        expect(page.points[0].id).toBe('c')
        expect(Array.from(page.points[0].embedding!)).toEqual([0, 1, 0])
      })

      test('empty collection scrolls to an empty page', async () => {
        const page = await index.scroll('scroll_empty')
        expect(page.points).toEqual([])
        expect(page.nextOffset).toBeUndefined()
      })
    })

    describe('count', () => {
      test('counts all points, and respects filters', async () => {
        await seed('count_all')
        expect(await index.count('count_all')).toBe(3)
        expect(
          await index.count('count_all', {
            filter: { must: [{ key: 'kind', match: { value: 'note' } }] },
          }),
        ).toBe(2)
      })

      test('a named variant counts only ids carrying it', async () => {
        await index.upsert('count_variant', [point('a', [1, 0, 0]), point('b', [0, 1, 0])], {
          variant: 'v1',
        })
        await index.upsert('count_variant', [point('a', [0, 0, 1])], { variant: 'v2' })
        expect(await index.count('count_variant', { variant: 'v2' })).toBe(1)
        expect(await index.count('count_variant', { variant: 'v1' })).toBe(2)
      })

      test('empty collection counts zero', async () => {
        expect(await index.count('count_empty')).toBe(0)
      })
    })

    describe('distanceMatrix', () => {
      test('returns one pair per unordered point pair with cosine scores', async () => {
        await seed('matrix_pairs')
        const { pairs } = await index.distanceMatrix('matrix_pairs')
        expect(pairs).toHaveLength(3)
        const ab = pairs.find((p) => (p.a === 'a' && p.b === 'b') || (p.a === 'b' && p.b === 'a'))
        expect(ab).toBeDefined()
        expect(ab!.score).toBeGreaterThan(0.9)
      })

      test('limit prunes pairs and sample bounds the pool', async () => {
        await seed('matrix_limits')
        const limited = await index.distanceMatrix('matrix_limits', { limit: 1 })
        expect(limited.pairs.length).toBeLessThanOrEqual(3)
        expect(limited.pairs.length).toBeGreaterThan(0)
        const sampled = await index.distanceMatrix('matrix_limits', { sample: 2 })
        expect(sampled.pairs).toHaveLength(1)
      })

      test('empty collection yields no pairs', async () => {
        expect((await index.distanceMatrix('matrix_empty')).pairs).toEqual([])
      })
    })
  })
}

runVectorIndexTests('inMemoryIndex', async () => inMemoryIndex())

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SQLite needs no environment — a throwaway file database gives the full compliance run everywhere.
import { createPgVectorIndex } from './pgvector'
import { createSqliteVecIndex } from './sqliteVec'

{
  let dir: string | undefined
  runVectorIndexTests(
    'sqliteVec',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'adk-sqlite-vec-'))
      return createSqliteVecIndex({ provider: 'sqlite-vec', path: join(dir, 'vectors.db') })
    },
    () => {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    },
  )
}

// The served backends run the same contract when their endpoint is provided (service containers in
// the public repo's CI). A provider the suite never exercises is an undocumented deviation waiting
// to be found by a user instead of by CI. Both wipes below assume a DEDICATED test instance: the
// suite reuses fixed collection names, so each run must start clean.
// The qdrant provider does NOT run this suite: it is provisioning-based by design (collections and
// their named-vector sets are fixed at creation via `collectionSpec()` — Qdrant cannot add a named
// vector to an existing collection), while this suite encodes the lazy-creation semantics the
// in-memory reference, sqliteVec, and pgvector share. Whether the VectorIndex contract should
// carry a provisioning seam so qdrant can run it too is an open design question; until it is
// settled, any conformance claim for qdrant must say "provisioned, does not run the shared suite".
const pgvectorUrl = process.env.TEST_PGVECTOR_URL

// oxlint-disable-next-line eslint-plugin-vitest(no-conditional-tests)
if (pgvectorUrl) {
  beforeAll(async () => {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: pgvectorUrl })
    await pool.query('drop schema public cascade')
    await pool.query('create schema public')
    await pool.end()
  })

  runVectorIndexTests('pgvector', async () =>
    createPgVectorIndex({ provider: 'pgvector', connectionString: pgvectorUrl }),
  )
} else {
  describe('pgvector — VectorIndex compliance', () => {
    test.skip('skipped: set TEST_PGVECTOR_URL to run', () => {})
  })
}
