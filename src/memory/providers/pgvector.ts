import type { RetryConfig } from '../../types/runnables'
import type {
  VectorIndex,
  PgVectorConfig,
  PgPool,
  DistanceMatrixResult,
  ScrollResult,
  VectorFilter,
  VectorCondition,
  HasIdCondition,
} from '../types'

import { withRetry } from '../../core/retry'
import { prunePairs } from '../filter'

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
}

export function pgvector(config: Omit<PgVectorConfig, 'provider'>): PgVectorConfig {
  return { provider: 'pgvector', ...config }
}

function conditionToSql(cond: VectorCondition, params: unknown[]): string {
  if (cond.match) {
    params.push(cond.key)
    const keyIdx = params.length
    params.push(String(cond.match.value))
    return `metadata->>$${keyIdx} = $${params.length}`
  }
  if (cond.text) {
    params.push(cond.key)
    const keyIdx = params.length
    const clauses = [cond.text.contains].flat().map((t) => {
      params.push(t.toLowerCase())
      return `lower(metadata->>$${keyIdx}) LIKE '%' || $${params.length} || '%'`
    })
    return `(${clauses.join(' OR ')})`
  }
  if (cond.range) {
    params.push(cond.key)
    const keyIdx = params.length
    const firstVal = cond.range.gt ?? cond.range.gte ?? cond.range.lt ?? cond.range.lte
    const cast = typeof firstVal === 'string' ? 'timestamptz' : 'numeric'
    const col = `(metadata->>$${keyIdx})::${cast}`
    const parts: string[] = []
    if (cond.range.gt != null) {
      params.push(cond.range.gt)
      parts.push(`${col} > $${params.length}`)
    }
    if (cond.range.gte != null) {
      params.push(cond.range.gte)
      parts.push(`${col} >= $${params.length}`)
    }
    if (cond.range.lt != null) {
      params.push(cond.range.lt)
      parts.push(`${col} < $${params.length}`)
    }
    if (cond.range.lte != null) {
      params.push(cond.range.lte)
      parts.push(`${col} <= $${params.length}`)
    }
    return parts.join(' AND ') || 'TRUE'
  }
  return 'TRUE'
}

function entryToSql(
  entry: VectorCondition | HasIdCondition | VectorFilter,
  params: unknown[],
): string {
  if ('has_id' in entry) {
    params.push((entry as HasIdCondition).has_id)
    return `id = ANY($${params.length})`
  }
  if ('key' in entry) return conditionToSql(entry as VectorCondition, params)
  const sub = entry as VectorFilter
  const parts: string[] = []
  if (sub.must) for (const c of sub.must) parts.push(entryToSql(c, params))
  if (sub.should && sub.should.length > 0) {
    parts.push(`(${sub.should.map((c) => entryToSql(c, params)).join(' OR ')})`)
  }
  if (sub.must_not) {
    for (const c of sub.must_not) parts.push(`NOT (${entryToSql(c, params)})`)
  }
  return parts.length > 0 ? `(${parts.join(' AND ')})` : 'TRUE'
}

function buildFilterClauses(filter: VectorFilter | undefined, params: unknown[]): string {
  if (!filter) return ''
  const expr = entryToSql(filter, params)
  return expr === 'TRUE' ? '' : ` AND ${expr}`
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function validateIdentifier(name: string, label: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Invalid ${label} "${name}": must match ${IDENTIFIER_RE}.`)
  }
}

export function createPgVectorIndex(config: PgVectorConfig): VectorIndex {
  const retryConfig = config.retry ?? DEFAULT_RETRY
  const batchSize = config.batchSize ?? 500
  const schema = config.schema ?? 'public'
  validateIdentifier(schema, 'schema')
  let pool: PgPool | null = null
  let ownedPool = false
  let extensionReady = false
  const initializedTables = new Set<string>()

  async function getPool(): Promise<PgPool> {
    if (!pool) {
      if (config.pool) {
        pool = config.pool
      } else {
        const pgModule = 'pg'
        const { Pool } = (await import(pgModule)) as {
          Pool: new (opts: { connectionString: string }) => PgPool
        }
        pool = new Pool({ connectionString: config.connectionString })
        ownedPool = true
        // Without a listener, pg re-throws a dropped/culled connection as an unhandled 'error' event
        // and Node terminates the process — only for a pool THIS index constructs itself (ownedPool);
        // a caller-injected config.pool is that caller's own to manage.
        pool.on?.('error', (err) => {
          console.error('createPgVectorIndex: idle client error (pool recovers):', err)
        })
      }
    }
    return pool
  }

  function table(collection: string): string {
    validateIdentifier(collection, 'collection')
    return `"${schema}"."${collection}"`
  }

  /**
   * True when the collection's table exists. Read and mutate paths use this instead of ensureTable:
   * a read must not create the collection as a side effect, and ensureTable without dimensions
   * would create a dimension-less vector column whose hnsw index cannot build.
   */
  async function tableExists(collection: string): Promise<boolean> {
    if (initializedTables.has(collection)) return true
    validateIdentifier(collection, 'collection')
    const p = await getPool()
    const result = await p.query('SELECT to_regclass($1) AS t', [`"${schema}"."${collection}"`])
    const exists = result.rows[0]?.t != null
    if (exists) initializedTables.add(collection)
    return exists
  }

  async function ensureTable(collection: string, dimensions?: number): Promise<void> {
    if (initializedTables.has(collection)) return
    const p = await getPool()
    if (!extensionReady) {
      await p.query('CREATE EXTENSION IF NOT EXISTS vector')
      extensionReady = true
    }
    const t = table(collection)
    const dimClause = dimensions ? `(${dimensions})` : ''
    await p.query(
      `CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT NOT NULL,
        variant TEXT NOT NULL,
        embedding vector${dimClause},
        metadata JSONB DEFAULT '{}',
        PRIMARY KEY (id, variant)
      )`,
    )
    await p.query(
      `CREATE INDEX IF NOT EXISTS "${schema}_${collection}_hnsw_idx"
       ON ${t} USING hnsw (embedding vector_cosine_ops)`,
    )
    initializedTables.add(collection)
  }

  return {
    async search(collection, embedding, options) {
      return withRetry(async () => {
        await ensureTable(collection, embedding.length)
        const dbPool = await getPool()
        const t = table(collection)
        const params: unknown[] = [`[${embedding.join(',')}]`, options?.variant ?? 'default']
        const filterSql = buildFilterClauses(options?.filter, params)

        let scoreFilter = ''
        if (options?.minScore != null) {
          params.push(options.minScore)
          scoreFilter = ` AND 1 - (embedding <=> $1::vector) >= $${params.length}`
        }

        params.push(options?.topK ?? 10)

        const sql = `
          SELECT id, 1 - (embedding <=> $1::vector) AS score, metadata
          FROM ${t}
          WHERE variant = $2${filterSql}${scoreFilter}
          ORDER BY embedding <=> $1::vector
          LIMIT $${params.length}
        `

        const result = await dbPool.query(sql, params)
        return result.rows.map((r) => ({
          id: String(r.id),
          score: Number(r.score),
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
        }))
      }, retryConfig)
    },

    async upsert(collection, points, options) {
      if (points.length === 0) return
      await ensureTable(collection, points[0].embedding.length)
      const t = table(collection)
      const variant = options?.variant ?? 'default'
      const pg = await getPool()

      for (let i = 0; i < points.length; i += batchSize) {
        const chunk = points.slice(i, i + batchSize)
        await withRetry(async () => {
          const withMeta = chunk.filter((pt) => pt.metadata)
          const withoutMeta = chunk.filter((pt) => !pt.metadata)

          if (withMeta.length > 0) {
            const nullKeysByPoint = new Map<string, string[]>()
            const cleanedMeta: Record<string, unknown>[] = []
            for (const pt of withMeta) {
              const clean: Record<string, unknown> = {}
              const nullKeys: string[] = []
              for (const [k, v] of Object.entries(pt.metadata!)) {
                if (v === null) nullKeys.push(k)
                else if (v !== undefined) clean[k] = v
              }
              cleanedMeta.push(clean)
              if (nullKeys.length > 0) nullKeysByPoint.set(pt.id, nullKeys)
            }

            const placeholders: string[] = []
            const values: unknown[] = []
            for (let j = 0; j < withMeta.length; j++) {
              const pt = withMeta[j]
              const base = values.length
              values.push(
                pt.id,
                variant,
                `[${pt.embedding.join(',')}]`,
                JSON.stringify(cleanedMeta[j]),
              )
              placeholders.push(
                `($${base + 1}, $${base + 2}, $${base + 3}::vector, $${base + 4}::jsonb)`,
              )
            }
            await pg.query(
              `INSERT INTO ${t} (id, variant, embedding, metadata)
               VALUES ${placeholders.join(', ')}
               ON CONFLICT (id, variant) DO UPDATE SET
                 embedding = EXCLUDED.embedding,
                 metadata = ${t}.metadata || EXCLUDED.metadata`,
              values,
            )
            const metaValues: unknown[] = []
            const metaCases: string[] = []
            const metaIds: string[] = []
            for (let j = 0; j < withMeta.length; j++) {
              const base = metaValues.length
              metaValues.push(withMeta[j].id, JSON.stringify(cleanedMeta[j]))
              metaCases.push(`WHEN id = $${base + 1} THEN $${base + 2}::jsonb`)
              metaIds.push(`$${base + 1}`)
            }
            metaValues.push(variant)
            await pg.query(
              `UPDATE ${t} SET metadata = metadata || CASE ${metaCases.join(' ')} ELSE '{}'::jsonb END
               WHERE id IN (${metaIds.join(', ')}) AND variant != $${metaValues.length}`,
              metaValues,
            )

            if (nullKeysByPoint.size > 0) {
              const allNullKeys = [...new Set([...nullKeysByPoint.values()].flat())]
              const ids = [...nullKeysByPoint.keys()]
              await pg.query(
                `UPDATE ${t} SET metadata = metadata - $1::text[] WHERE id = ANY($2)`,
                [allNullKeys, ids],
              )
            }
          }

          if (withoutMeta.length > 0) {
            const placeholders: string[] = []
            const values: unknown[] = []
            for (const pt of withoutMeta) {
              const base = values.length
              values.push(pt.id, variant, `[${pt.embedding.join(',')}]`)
              placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}::vector)`)
            }
            await pg.query(
              `INSERT INTO ${t} (id, variant, embedding)
               VALUES ${placeholders.join(', ')}
               ON CONFLICT (id, variant) DO UPDATE SET
                 embedding = EXCLUDED.embedding`,
              values,
            )
          }
        }, retryConfig)
      }
    },

    async delete(collection, ids) {
      return withRetry(async () => {
        if (!(await tableExists(collection))) return
        const dbPool = await getPool()
        await dbPool.query(`DELETE FROM ${table(collection)} WHERE id = ANY($1)`, [ids])
      }, retryConfig)
    },

    async deleteByFilter(collection, filter) {
      return withRetry(async () => {
        if (!(await tableExists(collection))) return
        const dbPool = await getPool()
        const params: unknown[] = []
        const filterSql = buildFilterClauses(filter, params)
        await dbPool.query(`DELETE FROM ${table(collection)} WHERE TRUE${filterSql}`, params)
      }, retryConfig)
    },

    async updateMetadata(collection, id, metadata) {
      return withRetry(async () => {
        if (!(await tableExists(collection))) return
        const dbPool = await getPool()
        const t = table(collection)
        const keysToSet: Record<string, unknown> = {}
        const keysToDelete: string[] = []
        for (const [key, value] of Object.entries(metadata)) {
          if (value === null) keysToDelete.push(key)
          else if (value !== undefined) keysToSet[key] = value
        }
        await dbPool.query(
          `UPDATE ${t} SET metadata = (metadata || $1::jsonb) - $2::text[]
           WHERE id = $3`,
          [JSON.stringify(keysToSet), keysToDelete, id],
        )
      }, retryConfig)
    },

    async distanceMatrix(collection, options) {
      return withRetry(async (): Promise<DistanceMatrixResult> => {
        if (!(await tableExists(collection))) return { pairs: [] }
        const dbPool = await getPool()
        const t = table(collection)
        const params: unknown[] = [options?.variant ?? 'default']
        const filterSql = buildFilterClauses(options?.filter, params)
        params.push(options?.sample ?? 100)

        const sql = `
          WITH pool AS (
            SELECT id, embedding FROM ${t}
            WHERE variant = $1${filterSql}
            ORDER BY random() LIMIT $${params.length}
          )
          SELECT a.id AS a, b.id AS b,
                 1 - (a.embedding <=> b.embedding) AS score
          FROM pool a JOIN pool b ON a.id < b.id
        `

        const result = await dbPool.query(sql, params)
        let pairs = result.rows.map((r) => ({
          a: String(r.a),
          b: String(r.b),
          score: Number(r.score),
        }))

        if (options?.limit != null) {
          pairs = prunePairs(pairs, options.limit)
        }

        return { pairs }
      }, retryConfig)
    },

    async get(collection, ids, options) {
      return withRetry(async () => {
        if (!(await tableExists(collection))) return ids.map((id) => ({ id, metadata: {} }))
        const dbPool = await getPool()
        const params: unknown[] = [ids]
        let variantSql = ''
        if (options?.variant) {
          params.push(options.variant)
          variantSql = ` AND variant = $${params.length}`
        }
        const result = await dbPool.query(
          `SELECT DISTINCT ON (id) id, metadata
           FROM ${table(collection)} WHERE id = ANY($1)${variantSql}
           ORDER BY id, variant`,
          params,
        )
        const rowMap = new Map(
          result.rows.map((r) => [String(r.id), (r.metadata ?? {}) as Record<string, unknown>]),
        )
        return ids.map((id) => ({
          id,
          metadata: rowMap.get(id) ?? {},
        }))
      }, retryConfig)
    },

    async scroll(collection, options): Promise<ScrollResult> {
      return withRetry(async () => {
        if (!(await tableExists(collection))) return { points: [] }
        const t = table(collection)
        const variant = options?.variant ?? 'default'
        const limit = options?.limit ?? 100
        const params: unknown[] = [variant]

        let cursorClause = ''
        if (options?.offset) {
          params.push(options.offset)
          cursorClause = ` AND id > $${params.length}`
        }

        const filterSql = buildFilterClauses(options?.filter, params)
        params.push(limit + 1)

        const cols = options?.includeVectors ? 'id, metadata, embedding::text' : 'id, metadata'

        const sql = `
          SELECT ${cols} FROM ${t}
          WHERE variant = $1${cursorClause}${filterSql}
          ORDER BY id ASC
          LIMIT $${params.length}
        `

        const dbPool = await getPool()
        const result = await dbPool.query(sql, params)
        const hasMore = result.rows.length > limit
        const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows

        const points: ScrollResult['points'] = pageRows.map((r) => {
          const point: ScrollResult['points'][number] = {
            id: String(r.id),
            metadata: (r.metadata ?? {}) as Record<string, unknown>,
          }
          if (options?.includeVectors && r.embedding) {
            point.embedding = JSON.parse(r.embedding as string) as number[]
          }
          return point
        })

        const lastId = pageRows.length > 0 ? String(pageRows[pageRows.length - 1].id) : undefined

        return {
          points,
          ...(hasMore && lastId ? { nextOffset: lastId } : {}),
        }
      }, retryConfig)
    },

    async count(collection, options): Promise<number> {
      return withRetry(async () => {
        if (!(await tableExists(collection))) return 0
        const t = table(collection)
        const params: unknown[] = [options?.variant ?? 'default']
        const filterSql = buildFilterClauses(options?.filter, params)

        const dbPool = await getPool()
        const result = await dbPool.query(
          `SELECT COUNT(*)::int AS cnt FROM ${t} WHERE variant = $1${filterSql}`,
          params,
        )
        return Number(result.rows[0].cnt)
      }, retryConfig)
    },

    async close() {
      if (pool && ownedPool) {
        await pool.end?.()
      }
      pool = null
      ownedPool = false
      extensionReady = false
      initializedTables.clear()
    },
  }
}
