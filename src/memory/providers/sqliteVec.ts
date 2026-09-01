import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  VectorIndex,
  VectorMatch,
  DistanceMatrixResult,
  ScrollResult,
  SqliteVecConfig,
} from '../types'

import { cosineSimilarity, matchesFilter, mergeMetadata, prunePairs } from '../filter'

/** The slice of better-sqlite3 this index uses — the peer stays a dynamic import. */
interface SqliteStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface SqliteDatabase {
  exec(sql: string): void
  pragma(sql: string): unknown
  prepare(sql: string): SqliteStatement
  transaction<T>(fn: () => T): () => T
  close(): void
}

/** Create a sqlite-vec index config (`':memory:'` for an ephemeral index). */
export function sqliteVec(config: Omit<SqliteVecConfig, 'provider'>): SqliteVecConfig {
  return { provider: 'sqlite-vec', ...config }
}

function toFloat32(embedding: number[]): Float32Array {
  return new Float32Array(embedding)
}

function toBuffer(embedding: number[]): Buffer {
  const f32 = toFloat32(embedding)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

function fromBuffer(buf: Buffer): number[] {
  return Array.from(
    new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  )
}

function toBigInt(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

/** Collection names are interpolated into DDL/DML — hold them to identifier shape. */
function assertCollectionName(collection: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(collection)) {
    throw new Error(`invalid collection name: ${JSON.stringify(collection)}`)
  }
}

const OVERFETCH_FACTOR = 10
const OVERFETCH_MIN = 100

/**
 * SQLite VectorIndex over the optional `better-sqlite3` + `sqlite-vec` peers — zero-infrastructure
 * durable vector memory for local development, CLIs, and single-process deployments. Vectors live
 * in a vec0 virtual table (cosine metric) per collection, dimensioned lazily from the first vector
 * seen; metadata and variants live in a sibling ordinary table, filtered with the same
 * `matchesFilter` the in-memory reference uses, so filter semantics cannot drift between them. When
 * no variant is named, `scroll`/`count`/`distanceMatrix` treat each id as one logical point (its
 * first-inserted row) — the in-memory reference's semantics.
 */
export async function createSqliteVecIndex(config: SqliteVecConfig): Promise<VectorIndex> {
  const sqliteModule = 'better-sqlite3'
  const vecModule = 'sqlite-vec'
  const { default: Database } = (await import(sqliteModule)) as {
    default: new (path: string) => SqliteDatabase
  }
  const vec = (await import(vecModule)) as { load: (db: unknown) => void }

  if (config.path !== ':memory:') {
    mkdirSync(dirname(config.path), { recursive: true })
  }
  const db = new Database(config.path)
  vec.load(db)
  db.pragma('journal_mode = WAL')

  const initialized = new Set<string>()

  function ensure(collection: string, dimensions: number): void {
    assertCollectionName(collection)
    if (initialized.has(collection)) return
    db.exec(`
      CREATE TABLE IF NOT EXISTS "${collection}" (
        _rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        variant TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding BLOB NOT NULL,
        UNIQUE(id, variant)
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS "idx_${collection}_id" ON "${collection}"(id)`)
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${collection}_vec" USING vec0(embedding float[${dimensions}] distance_metric=cosine)`,
    )
    initialized.add(collection)
  }

  function has(collection: string): boolean {
    assertCollectionName(collection)
    if (initialized.has(collection)) return true
    const row = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(collection)
    if (row) initialized.add(collection)
    return row !== undefined
  }

  /** One row per logical point: every row of the named variant, or each id's first-inserted row. */
  function rowsForVariant(collection: string, columns: string, variant?: string): unknown[] {
    if (variant !== undefined) {
      return db.prepare(`SELECT ${columns} FROM "${collection}" WHERE variant = ?`).all(variant)
    }
    return db
      .prepare(
        `SELECT ${columns} FROM "${collection}" t
         WHERE _rowid = (SELECT MIN(_rowid) FROM "${collection}" t2 WHERE t2.id = t.id)`,
      )
      .all()
  }

  return {
    async search(collection, embedding, options) {
      ensure(collection, embedding.length)
      const topK = options?.topK ?? 10
      const variant = options?.variant

      // KNN then filter drops any match ranked beyond the fetch window, so the window widens until
      // topK matches are in hand, KNN is exhausted, or every deeper row is already under minScore.
      let limit = Math.max(topK * OVERFETCH_FACTOR, OVERFETCH_MIN)
      for (;;) {
        const vecRows = db
          .prepare(
            `SELECT rowid, distance FROM "${collection}_vec" WHERE embedding MATCH ? AND k = ?`,
          )
          .all(toFloat32(embedding), limit) as Array<{ rowid: number | bigint; distance: number }>
        if (vecRows.length === 0) return []

        const distances = new Map(vecRows.map((r) => [Number(r.rowid), r.distance]))
        const rowids = vecRows.map((r) => Number(r.rowid))
        const placeholders = rowids.map(() => '?').join(',')
        const metaRows = db
          .prepare(
            `SELECT _rowid, id, variant, metadata FROM "${collection}" WHERE _rowid IN (${placeholders})`,
          )
          .all(...rowids) as Array<{
          _rowid: number
          id: string
          variant: string
          metadata: string
        }>

        const bestPerId = new Map<string, VectorMatch>()
        for (const row of metaRows) {
          if (variant && row.variant !== variant) continue
          const metadata = JSON.parse(row.metadata) as Record<string, unknown>
          if (!matchesFilter(options?.filter, row.id, metadata)) continue
          const score = 1 - distances.get(row._rowid)!
          if (options?.minScore != null && score < options.minScore) continue
          const previous = bestPerId.get(row.id)
          if (!previous || score > previous.score) {
            bestPerId.set(row.id, { id: row.id, score, metadata })
          }
        }

        const exhausted = vecRows.length < limit
        const deepestScore = 1 - vecRows[vecRows.length - 1].distance
        const belowFloor = options?.minScore != null && deepestScore < options.minScore
        if (bestPerId.size >= topK || exhausted || belowFloor) {
          const results = Array.from(bestPerId.values())
          results.sort((a, b) => b.score - a.score)
          return results.slice(0, topK)
        }
        limit *= OVERFETCH_FACTOR
      }
    },

    async upsert(collection, points, options) {
      if (points.length === 0) return
      ensure(collection, points[0].embedding.length)
      const variant = options?.variant ?? 'default'

      db.transaction(() => {
        for (const pt of points) {
          const existing = db
            .prepare(`SELECT _rowid FROM "${collection}" WHERE id = ? AND variant = ?`)
            .get(pt.id, variant) as { _rowid: number } | undefined

          if (existing) {
            db.prepare(`UPDATE "${collection}" SET embedding = ? WHERE _rowid = ?`).run(
              toBuffer(pt.embedding),
              existing._rowid,
            )
            db.prepare(`DELETE FROM "${collection}_vec" WHERE rowid = ?`).run(
              toBigInt(existing._rowid),
            )
            db.prepare(`INSERT INTO "${collection}_vec" (rowid, embedding) VALUES (?, ?)`).run(
              toBigInt(existing._rowid),
              toFloat32(pt.embedding),
            )
          } else {
            const inserted = db
              .prepare(
                `INSERT INTO "${collection}" (id, variant, metadata, embedding) VALUES (?, ?, ?, ?)`,
              )
              .run(pt.id, variant, JSON.stringify(pt.metadata ?? {}), toBuffer(pt.embedding))
            db.prepare(`INSERT INTO "${collection}_vec" (rowid, embedding) VALUES (?, ?)`).run(
              toBigInt(inserted.lastInsertRowid),
              toFloat32(pt.embedding),
            )
          }

          // Metadata is per-id (variants share it): merge the update into every row of the id.
          if (pt.metadata) {
            const rows = db
              .prepare(`SELECT _rowid, metadata FROM "${collection}" WHERE id = ?`)
              .all(pt.id) as Array<{ _rowid: number; metadata: string }>
            for (const row of rows) {
              const merged = mergeMetadata(
                JSON.parse(row.metadata) as Record<string, unknown>,
                pt.metadata,
              )
              db.prepare(`UPDATE "${collection}" SET metadata = ? WHERE _rowid = ?`).run(
                JSON.stringify(merged),
                row._rowid,
              )
            }
          }
        }
      })()
    },

    async delete(collection, ids) {
      if (!has(collection) || ids.length === 0) return
      const placeholders = ids.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT _rowid FROM "${collection}" WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ _rowid: number }>

      db.transaction(() => {
        for (const row of rows) {
          db.prepare(`DELETE FROM "${collection}_vec" WHERE rowid = ?`).run(toBigInt(row._rowid))
        }
        db.prepare(`DELETE FROM "${collection}" WHERE id IN (${placeholders})`).run(...ids)
      })()
    },

    async deleteByFilter(collection, filter) {
      if (!has(collection)) return
      const rows = db.prepare(`SELECT _rowid, id, metadata FROM "${collection}"`).all() as Array<{
        _rowid: number
        id: string
        metadata: string
      }>

      const doomed = rows.filter((row) =>
        matchesFilter(filter, row.id, JSON.parse(row.metadata) as Record<string, unknown>),
      )
      if (doomed.length === 0) return

      db.transaction(() => {
        for (const row of doomed) {
          db.prepare(`DELETE FROM "${collection}_vec" WHERE rowid = ?`).run(toBigInt(row._rowid))
        }
        const placeholders = doomed.map(() => '?').join(',')
        db.prepare(`DELETE FROM "${collection}" WHERE _rowid IN (${placeholders})`).run(
          ...doomed.map((row) => row._rowid),
        )
      })()
    },

    async updateMetadata(collection, id, metadata) {
      if (!has(collection)) return
      const rows = db
        .prepare(`SELECT _rowid, metadata FROM "${collection}" WHERE id = ?`)
        .all(id) as Array<{ _rowid: number; metadata: string }>
      for (const row of rows) {
        const merged = mergeMetadata(JSON.parse(row.metadata) as Record<string, unknown>, metadata)
        db.prepare(`UPDATE "${collection}" SET metadata = ? WHERE _rowid = ?`).run(
          JSON.stringify(merged),
          row._rowid,
        )
      }
    },

    async distanceMatrix(collection, options) {
      if (!has(collection)) return { pairs: [] }
      let pool = (
        rowsForVariant(collection, 'id, metadata, embedding', options?.variant) as Array<{
          id: string
          metadata: string
          embedding: Buffer
        }>
      ).filter((row) =>
        matchesFilter(options?.filter, row.id, JSON.parse(row.metadata) as Record<string, unknown>),
      )

      if (options?.sample != null && options.sample < pool.length) {
        pool = pool.slice(0, options.sample)
      }

      const vectors = pool.map((row) => fromBuffer(row.embedding))
      const pairs: DistanceMatrixResult['pairs'] = []
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          pairs.push({
            a: pool[i].id,
            b: pool[j].id,
            score: cosineSimilarity(vectors[i], vectors[j]),
          })
        }
      }

      if (options?.limit != null) return { pairs: prunePairs(pairs, options.limit) }
      return { pairs }
    },

    async get(collection, ids, options) {
      if (!has(collection) || ids.length === 0) return ids.map((id) => ({ id, metadata: {} }))
      const placeholders = ids.map(() => '?').join(',')
      const variantSql = options?.variant ? ' AND variant = ?' : ''
      const params = options?.variant ? [...ids, options.variant] : ids
      const rows = db
        .prepare(
          `SELECT id, metadata FROM "${collection}" WHERE id IN (${placeholders})${variantSql}`,
        )
        .all(...params) as Array<{ id: string; metadata: string }>
      const byId = new Map<string, Record<string, unknown>>()
      for (const row of rows) {
        if (!byId.has(row.id)) byId.set(row.id, JSON.parse(row.metadata) as Record<string, unknown>)
      }
      return ids.map((id) => ({ id, metadata: byId.get(id) ?? {} }))
    },

    async scroll(collection, options): Promise<ScrollResult> {
      if (!has(collection)) return { points: [] }
      const limit = options?.limit ?? 100
      const afterRowid = options?.offset ? parseInt(options.offset, 10) : 0

      const columns = `_rowid, id, metadata${options?.includeVectors ? ', embedding' : ''}`
      const rows = (
        options?.variant !== undefined
          ? db
              .prepare(
                `SELECT ${columns} FROM "${collection}"
                 WHERE variant = ? AND _rowid > ? ORDER BY _rowid ASC`,
              )
              .all(options.variant, afterRowid)
          : db
              .prepare(
                `SELECT ${columns} FROM "${collection}" t
                 WHERE _rowid > ? AND _rowid = (SELECT MIN(_rowid) FROM "${collection}" t2 WHERE t2.id = t.id)
                 ORDER BY _rowid ASC`,
              )
              .all(afterRowid)
      ) as Array<{ _rowid: number; id: string; metadata: string; embedding?: Buffer }>

      const points: ScrollResult['points'] = []
      let lastRowid: number | undefined
      let hasMore = false
      for (const row of rows) {
        const metadata = JSON.parse(row.metadata) as Record<string, unknown>
        if (!matchesFilter(options?.filter, row.id, metadata)) continue
        if (points.length >= limit) {
          hasMore = true
          break
        }
        const point: ScrollResult['points'][number] = { id: row.id, metadata }
        if (options?.includeVectors && row.embedding) {
          point.embedding = fromBuffer(row.embedding)
        }
        points.push(point)
        lastRowid = row._rowid
      }

      return {
        points,
        ...(hasMore && lastRowid != null ? { nextOffset: String(lastRowid) } : {}),
      }
    },

    async count(collection, options): Promise<number> {
      if (!has(collection)) return 0
      const rows = rowsForVariant(collection, 'id, metadata', options?.variant) as Array<{
        id: string
        metadata: string
      }>
      if (!options?.filter) return rows.length
      return rows.filter((row) =>
        matchesFilter(options.filter, row.id, JSON.parse(row.metadata) as Record<string, unknown>),
      ).length
    },

    async close() {
      db.close()
    },
  }
}
