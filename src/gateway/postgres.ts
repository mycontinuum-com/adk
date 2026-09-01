/**
 * PostgresProcessStore — Production backend for process lifecycle management.
 *
 * Uses raw SQL queries against the ADK schema (adk.processes, adk.messages). No Drizzle dependency
 * — maintains ADK's publishability by depending only on the pg peer dependency.
 *
 * The canonical DDL is the hand-authored baseline shipped with the package at
 * migrations/0000_adk_baseline.sql; this module uses raw SQL to avoid coupling to Drizzle. Tenancy
 * is structural there: messages carry app_name with a composite FK (app_name, process_id) →
 * processes(app_name, id) ON DELETE CASCADE, so every query here keys by (app_name, …) and delete()
 * is a single cascading statement. Claim state is the real claimed_at column, never a value
 * smuggled into the metadata jsonb.
 */

import type {
  ProcessStore,
  StoredProcess,
  StoredMessage,
  ProcessUpdate,
  ProcessFilter,
  ProcessSummary,
} from './types'

export interface PostgresProcessStoreConfig {
  /** Postgres connection string. Used if pool is not provided. */
  connectionString?: string
  /** Existing pg Pool instance. Takes precedence over connectionString. */
  pool?: unknown
  /** Schema name for the ADK tables. Defaults to 'adk'. */
  schema?: string
}

interface PgQueryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

interface PgClient extends PgQueryable {
  release(): void
}

interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>
  end(): Promise<void>
  on(event: 'error', listener: (err: Error) => void): void
}

/**
 * Create a Postgres ProcessStore.
 *
 * @example
 *   ;```typescript
 *   import { postgresProcessStore } from '@animahealth/adk/gateway/postgres'
 *
 *   const store = postgresProcessStore({
 *     connectionString: process.env.DATABASE_URL,
 *   })
 *   ```
 */
export function postgresProcessStore(config: PostgresProcessStoreConfig): ProcessStore {
  return new PostgresProcessStore(config)
}

/**
 * Postgres ProcessStore implementation.
 *
 * All queries use parameterized SQL to prevent injection. Uses transactions where atomicity is
 * required.
 */
export class PostgresProcessStore implements ProcessStore {
  private pool: PgPool | null = null
  /** True only for a pool this store constructed itself — the only pool close() may end. */
  private ownsPool = false
  private readonly config: PostgresProcessStoreConfig
  private readonly schema: string

  constructor(config: PostgresProcessStoreConfig) {
    if (!config.pool && !config.connectionString) {
      throw new Error('PostgresProcessStore requires either pool or connectionString')
    }
    if (config.pool) {
      this.pool = config.pool as PgPool
    }
    this.config = config
    this.schema = config.schema ?? 'adk'
  }

  private async getPool(): Promise<PgPool> {
    if (!this.pool) {
      const pgModule = 'pg'
      const { Pool } = (await import(pgModule)) as {
        Pool: new (opts: { connectionString: string }) => PgPool
      }
      this.pool = new Pool({ connectionString: this.config.connectionString! })
      this.ownsPool = true
      // Without a listener, pg re-throws a dropped/culled connection as an unhandled 'error' event and
      // Node terminates the process — only for a pool THIS store constructs itself; a caller-injected
      // config.pool is that caller's own to manage.
      this.pool.on('error', (err) => {
        console.error('PostgresProcessStore: idle client error (pool recovers):', err)
      })
    }
    return this.pool
  }

  private async withTransaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
    const pool = await this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  private rowToProcess(row: Record<string, unknown>): StoredProcess {
    return {
      id: String(row.id),
      appName: String(row.app_name),
      agentName: String(row.agent_name),
      sessionId: String(row.session_id),
      status: String(row.status) as StoredProcess['status'],
      paused: Boolean(row.paused),
      schedule: row.schedule != null ? String(row.schedule) : null,
      nextWakeAt: row.next_wake_at != null ? new Date(row.next_wake_at as string | number) : null,
      executor: row.executor != null ? String(row.executor) : null,
      executorConfig: (typeof row.executor_config === 'string'
        ? JSON.parse(row.executor_config)
        : (row.executor_config ?? {})) as Record<string, unknown>,
      lastRunAt: row.last_run_at != null ? new Date(row.last_run_at as string | number) : null,
      createdAt: new Date(row.created_at as string | number),
      metadata: (typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : (row.metadata ?? {})) as Record<string, unknown>,
    }
  }

  private rowToMessage(row: Record<string, unknown>): StoredMessage {
    return {
      id: String(row.id),
      processId: String(row.process_id),
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      authorId: row.author_id != null ? String(row.author_id) : null,
      authorName: row.author_name != null ? String(row.author_name) : null,
      createdAt: new Date(row.created_at as string | number),
      consumed: Boolean(row.consumed),
    }
  }

  async create(process: StoredProcess): Promise<void> {
    const pool = await this.getPool()

    // Check if process already exists
    const existing = await pool.query(
      `SELECT 1 FROM ${this.schema}.processes WHERE app_name = $1 AND id = $2`,
      [process.appName, process.id],
    )
    if (existing.rows.length > 0) {
      throw new Error(`Process ${process.id} already exists in app ${process.appName}`)
    }

    await pool.query(
      `INSERT INTO ${this.schema}.processes (
        id, app_name, agent_name, session_id, status, paused, schedule,
        next_wake_at, executor, executor_config, last_run_at, created_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb)`,
      [
        process.id,
        process.appName,
        process.agentName,
        process.sessionId,
        process.status,
        process.paused,
        process.schedule,
        process.nextWakeAt,
        process.executor,
        JSON.stringify(process.executorConfig),
        process.lastRunAt,
        process.createdAt,
        JSON.stringify(process.metadata),
      ],
    )
  }

  async get(appName: string, processId: string): Promise<StoredProcess | null> {
    const pool = await this.getPool()
    const result = await pool.query(
      `SELECT id, app_name, agent_name, session_id, status, paused, schedule,
              next_wake_at, executor, executor_config, last_run_at, created_at, metadata
       FROM ${this.schema}.processes
       WHERE app_name = $1 AND id = $2`,
      [appName, processId],
    )

    if (result.rows.length === 0) {
      return null
    }

    return this.rowToProcess(result.rows[0])
  }

  async update(appName: string, processId: string, changes: ProcessUpdate): Promise<void> {
    const pool = await this.getPool()

    // Build dynamic SET clause
    const setClauses: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (changes.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`)
      values.push(changes.status)
    }
    if (changes.paused !== undefined) {
      setClauses.push(`paused = $${paramIndex++}`)
      values.push(changes.paused)
    }
    if (changes.schedule !== undefined) {
      setClauses.push(`schedule = $${paramIndex++}`)
      values.push(changes.schedule)
    }
    if (changes.nextWakeAt !== undefined) {
      setClauses.push(`next_wake_at = $${paramIndex++}`)
      values.push(changes.nextWakeAt)
    }
    if (changes.executor !== undefined) {
      setClauses.push(`executor = $${paramIndex++}`)
      values.push(changes.executor)
    }
    if (changes.executorConfig !== undefined) {
      setClauses.push(`executor_config = $${paramIndex++}::jsonb`)
      values.push(JSON.stringify(changes.executorConfig))
    }
    if (changes.lastRunAt !== undefined) {
      setClauses.push(`last_run_at = $${paramIndex++}`)
      values.push(changes.lastRunAt)
    }
    if (changes.metadata !== undefined) {
      // Merge metadata using jsonb || operator
      setClauses.push(`metadata = metadata || $${paramIndex++}::jsonb`)
      values.push(JSON.stringify(changes.metadata))
    }

    // Clear the claim timestamp when status changes from 'queued' to another state
    if (changes.status !== undefined && changes.status !== 'queued') {
      setClauses.push(`claimed_at = NULL`)
    }

    if (setClauses.length === 0) {
      // No changes to apply, but still verify the process exists
      const existing = await pool.query(
        `SELECT 1 FROM ${this.schema}.processes WHERE app_name = $1 AND id = $2`,
        [appName, processId],
      )
      if (existing.rows.length === 0) {
        throw new Error(`Process ${processId} not found in app ${appName}`)
      }
      return
    }

    values.push(appName, processId)
    const result = await pool.query(
      `UPDATE ${this.schema}.processes
       SET ${setClauses.join(', ')}
       WHERE app_name = $${paramIndex} AND id = $${paramIndex + 1}`,
      values,
    )

    if (result.rowCount === 0) {
      throw new Error(`Process ${processId} not found in app ${appName}`)
    }
  }

  async claimDue(appName: string, limit: number): Promise<StoredProcess[]> {
    const pool = await this.getPool()

    // Use a single atomic UPDATE ... RETURNING to claim due processes. This avoids race conditions
    // where multiple workers might claim the same process. The outer UPDATE is keyed by
    // (app_name, id) — the processes primary key — so an id colliding across apps can never be
    // cross-claimed. claimed_at records the claim for revertStale tracking.
    const result = await pool.query(
      `UPDATE ${this.schema}.processes
       SET status = 'queued',
           claimed_at = NOW()
       WHERE (app_name, id) IN (
         SELECT app_name, id FROM ${this.schema}.processes
         WHERE app_name = $1
           AND status = 'sleeping'
           AND paused = false
           AND next_wake_at IS NOT NULL
           AND next_wake_at <= NOW()
         ORDER BY next_wake_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, app_name, agent_name, session_id, status, paused, schedule,
                 next_wake_at, executor, executor_config, last_run_at, created_at, metadata`,
      [appName, limit],
    )

    return result.rows.map((row) => this.rowToProcess(row))
  }

  async revertStale(appName: string, timeoutMs: number): Promise<number> {
    const pool = await this.getPool()

    // One atomic revert: queued processes whose claim (claimed_at, set by claimDue) exceeds the
    // timeout go back to sleeping. Rows queued without a claim (claimed_at IS NULL) never match.
    // The cutoff stays in the DB clock domain — claimDue stamped claimed_at with NOW(), so an
    // app-host cutoff (Date.now() - timeoutMs) would let DB/app clock skew revert a just-claimed
    // process while its worker still runs (duplicate execution), or silently extend the timeout.
    const result = await pool.query(
      `UPDATE ${this.schema}.processes
       SET status = 'sleeping',
           claimed_at = NULL
       WHERE app_name = $1
         AND status = 'queued'
         AND claimed_at < NOW() - ($2::float8 * interval '1 millisecond')`,
      [appName, timeoutMs],
    )

    return result.rowCount ?? 0
  }

  async enqueueMessage(
    appName: string,
    processId: string,
    message: Omit<StoredMessage, 'processId' | 'consumed'>,
  ): Promise<void> {
    await this.withTransaction(async (client) => {
      // Check process exists and get its current state
      const processResult = await client.query(
        `SELECT status, paused FROM ${this.schema}.processes
         WHERE app_name = $1 AND id = $2
         FOR UPDATE`,
        [appName, processId],
      )

      if (processResult.rows.length === 0) {
        throw new Error(`Process ${processId} not found in app ${appName}`)
      }

      const { status, paused } = processResult.rows[0]

      // Insert the message (app_name rides along — the composite FK ties it to exactly this
      // app's process)
      await client.query(
        `INSERT INTO ${this.schema}.messages (id, app_name, process_id, payload, author_id, author_name, created_at, consumed)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, false)`,
        [
          message.id,
          appName,
          processId,
          JSON.stringify(message.payload),
          message.authorId,
          message.authorName,
          message.createdAt,
        ],
      )

      // Wake the process if sleeping and not paused
      if (status === 'sleeping' && !paused) {
        await client.query(
          `UPDATE ${this.schema}.processes
           SET next_wake_at = NOW()
           WHERE app_name = $1 AND id = $2`,
          [appName, processId],
        )
      }
    })
  }

  async consumeMessages(appName: string, processId: string): Promise<StoredMessage[]> {
    const pool = await this.getPool()

    // Note: consumeMessages returns empty array for non-existent process per compliance tests

    // Atomically mark messages as consumed and return them — keyed by (app_name, process_id) so an
    // id colliding across apps can never be cross-consumed
    const result = await pool.query(
      `UPDATE ${this.schema}.messages
       SET consumed = true
       WHERE app_name = $1
         AND process_id = $2
         AND consumed = false
       RETURNING id, process_id, payload, author_id, author_name, created_at, consumed`,
      [appName, processId],
    )

    return result.rows.map((row) => this.rowToMessage(row))
  }

  async list(appName: string, filter?: ProcessFilter): Promise<ProcessSummary[]> {
    const pool = await this.getPool()

    const conditions: string[] = ['app_name = $1']
    const values: unknown[] = [appName]
    let paramIndex = 2

    if (filter?.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      const placeholders = statuses.map((_, i) => `$${paramIndex + i}`).join(', ')
      conditions.push(`status IN (${placeholders})`)
      values.push(...statuses)
      paramIndex += statuses.length
    }

    if (filter?.agentName !== undefined) {
      conditions.push(`agent_name = $${paramIndex++}`)
      values.push(filter.agentName)
    }

    if (filter?.paused !== undefined) {
      conditions.push(`paused = $${paramIndex++}`)
      values.push(filter.paused)
    }

    if (filter?.executor !== undefined) {
      conditions.push(`executor = $${paramIndex++}`)
      values.push(filter.executor)
    }

    let sql = `
      SELECT id, app_name, agent_name, session_id, status, paused,
             created_at, last_run_at, next_wake_at
      FROM ${this.schema}.processes
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
    `

    if (filter?.limit !== undefined) {
      sql += ` LIMIT $${paramIndex++}`
      values.push(filter.limit)
    }

    if (filter?.offset !== undefined) {
      sql += ` OFFSET $${paramIndex++}`
      values.push(filter.offset)
    }

    const result = await pool.query(sql, values)

    return result.rows.map(
      (row): ProcessSummary => ({
        id: String(row.id),
        appName: String(row.app_name),
        agentName: String(row.agent_name),
        sessionId: String(row.session_id),
        status: String(row.status) as ProcessSummary['status'],
        paused: Boolean(row.paused),
        createdAt: new Date(row.created_at as string | number),
        lastRunAt: row.last_run_at != null ? new Date(row.last_run_at as string | number) : null,
        nextWakeAt: row.next_wake_at != null ? new Date(row.next_wake_at as string | number) : null,
      }),
    )
  }

  async delete(appName: string, processId: string): Promise<void> {
    const pool = await this.getPool()

    // One statement: the composite FKs' ON DELETE CASCADE erases the process's messages and
    // artifact versions with it — no orphaned rows, no cross-app collateral.
    await pool.query(`DELETE FROM ${this.schema}.processes WHERE app_name = $1 AND id = $2`, [
      appName,
      processId,
    ])
  }

  async close(): Promise<void> {
    // End only a pool this store constructed itself — a caller-injected config.pool is that
    // caller's own to manage (ending it here would kill every other user of the shared pool).
    if (this.pool && this.ownsPool) {
      await this.pool.end()
    }
    this.pool = this.config.pool ? (this.config.pool as PgPool) : null
    this.ownsPool = false
  }
}
