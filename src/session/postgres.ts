import type { Event } from '../types/events'
import type { SessionStore, StoredSession, CommitResult, ScopedStateChange } from '../types/session'

export interface PostgresStoreConfig {
  connectionString?: string
  pool?: unknown
}

interface PgQueryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
}

interface PgClient extends PgQueryable {
  release(): void
}

interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>
  end(): Promise<void>
  on(event: 'error', listener: (err: Error) => void): void
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  scopes JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (app_name, id)
);

CREATE TABLE IF NOT EXISTS events (
  app_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (app_name, session_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_order
  ON events (app_name, session_id, idx);

CREATE TABLE IF NOT EXISTS scoped_state (
  app_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (app_name, scope, scope_id, key)
);
`

/** Create a Postgres session store. Requires `pg` as a peer dependency. */
export function postgresStore(config: PostgresStoreConfig): SessionStore {
  return new PostgresStore(config)
}

/**
 * Postgres SessionStore — fully transactional commits. Unlike DynamoDB, OCC conflict rolls back the
 * entire transaction (no partial-failure window).
 *
 * All transactional methods use a dedicated client from the pool (via `connect()`) to guarantee
 * every statement in a BEGIN/COMMIT block runs on the same connection. Non-transactional reads use
 * the pool directly.
 *
 * @deprecated Use `postgresStore()` instead. Will be removed from the public API in the next major
 *   version.
 */
export class PostgresStore implements SessionStore {
  private pool: PgPool | null = null
  private readonly config: PostgresStoreConfig
  private initialized = false

  constructor(config: PostgresStoreConfig) {
    if (!config.pool && !config.connectionString) {
      throw new Error('PostgresStore requires either pool or connectionString')
    }
    if (config.pool) {
      this.pool = config.pool as PgPool
    }
    this.config = config
  }

  private async getPool(): Promise<PgPool> {
    if (!this.pool) {
      const pgModule = 'pg'
      const { Pool } = (await import(pgModule)) as {
        Pool: new (opts: { connectionString: string }) => PgPool
      }
      this.pool = new Pool({ connectionString: this.config.connectionString! })
      // Without a listener, pg re-throws a dropped/culled connection as an unhandled 'error' event and
      // Node terminates the process — only for a pool THIS store constructs itself; a caller-injected
      // config.pool is that caller's own to manage.
      this.pool.on('error', (err) => {
        console.error('PostgresStore: idle client error (pool recovers):', err)
      })
    }
    return this.pool
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return
    const pool = await this.getPool()
    await pool.query(SCHEMA_SQL)
    this.initialized = true
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

  async load(
    appName: string,
    sessionId: string,
  ): Promise<{ session: StoredSession; events: Event[] } | null> {
    await this.ensureSchema()
    const pool = await this.getPool()

    const sessionResult = await pool.query(
      'SELECT * FROM sessions WHERE app_name = $1 AND id = $2',
      [appName, sessionId],
    )
    if (sessionResult.rows.length === 0) return null

    const row = sessionResult.rows[0]
    const session: StoredSession = {
      id: String(row.id),
      appName: String(row.app_name),
      version: Number(row.version),
      scopes: (typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes) as Record<
        string,
        string
      >,
      createdAt: Number(row.created_at),
    }

    const eventResult = await pool.query(
      'SELECT data FROM events WHERE app_name = $1 AND session_id = $2 ORDER BY idx',
      [appName, sessionId],
    )
    const events: Event[] = eventResult.rows.map((r) => {
      const d = r.data
      return (typeof d === 'string' ? JSON.parse(d) : d) as Event
    })

    return { session, events }
  }

  async commit(
    session: StoredSession,
    newEvents: Event[],
    expectedVersion: number,
    scopedChanges?: ScopedStateChange[],
  ): Promise<CommitResult> {
    await this.ensureSchema()
    const pool = await this.getPool()
    const now = Date.now()
    const scopesJson = JSON.stringify(session.scopes ?? {})
    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      let newVersion: number

      const updateResult = await client.query(
        `UPDATE sessions SET version = version + 1, updated_at = $1, scopes = $2::jsonb
         WHERE app_name = $3 AND id = $4 AND version = $5
         RETURNING version`,
        [now, scopesJson, session.appName, session.id, expectedVersion],
      )

      if (updateResult.rows.length === 0) {
        const existing = await client.query(
          'SELECT version FROM sessions WHERE app_name = $1 AND id = $2',
          [session.appName, session.id],
        )

        if (existing.rows.length > 0) {
          await client.query('ROLLBACK')
          return { ok: false, conflict: true, currentVersion: Number(existing.rows[0].version) }
        }

        if (expectedVersion > 0) {
          await client.query('ROLLBACK')
          return { ok: false, conflict: true, currentVersion: 0 }
        }

        await client.query(
          `INSERT INTO sessions (app_name, id, version, scopes, created_at, updated_at)
           VALUES ($1, $2, 1, $3::jsonb, $4, $5)`,
          [session.appName, session.id, scopesJson, session.createdAt, now],
        )
        newVersion = 1
      } else {
        newVersion = Number(updateResult.rows[0].version)
      }

      if (newEvents.length > 0) {
        // Assign idx only to events actually entering the history: a precomputed COUNT-based idx
        // for a batch containing an already-stored id would hand a duplicate idx to its neighbor
        // and leave ORDER BY idx unspecified from then on.
        const storedResult = await client.query(
          'SELECT event_id FROM events WHERE app_name = $1 AND session_id = $2 AND event_id = ANY($3)',
          [session.appName, session.id, newEvents.map((event) => event.id)],
        )
        const seen = new Set<string>(storedResult.rows.map((row) => String(row.event_id)))
        const fresh = newEvents.filter((event) => {
          if (seen.has(event.id)) return false
          seen.add(event.id)
          return true
        })

        if (fresh.length > 0) {
          const countResult = await client.query(
            'SELECT COUNT(*)::int as cnt FROM events WHERE app_name = $1 AND session_id = $2',
            [session.appName, session.id],
          )
          const startIdx = Number(countResult.rows[0].cnt)

          const values = fresh.map((_, i) => {
            const base = i * 3 + 3
            return `($1, $2, $${base}, $${base + 1}, $${base + 2}::jsonb)`
          })
          const params: unknown[] = [session.appName, session.id]
          for (let i = 0; i < fresh.length; i++) {
            params.push(fresh[i].id, startIdx + i, JSON.stringify(fresh[i]))
          }

          await client.query(
            `INSERT INTO events (app_name, session_id, event_id, idx, data)
             VALUES ${values.join(', ')}
             ON CONFLICT DO NOTHING`,
            params,
          )
        }
      }

      if (scopedChanges) {
        await this.writeScopedChanges(client, session.appName, scopedChanges)
      }

      await client.query('COMMIT')
      return { ok: true, version: newVersion }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  private async writeScopedChanges(
    q: PgQueryable,
    appName: string,
    scopedChanges: ScopedStateChange[],
  ): Promise<void> {
    const upserts: unknown[] = []
    const upsertPlaceholders: string[] = []
    const deleteGroups = new Map<string, string[]>()

    for (const { scope, scopeId, changes } of scopedChanges) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) {
          const groupKey = `${scope}\0${scopeId}`
          let keys = deleteGroups.get(groupKey)
          if (!keys) {
            keys = []
            deleteGroups.set(groupKey, keys)
          }
          keys.push(key)
        } else {
          const base = upserts.length + 1
          upsertPlaceholders.push(
            `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`,
          )
          upserts.push(appName, scope, scopeId, key, JSON.stringify(value))
        }
      }
    }

    if (upserts.length > 0) {
      await q.query(
        `INSERT INTO scoped_state (app_name, scope, scope_id, key, value)
         VALUES ${upsertPlaceholders.join(', ')}
         ON CONFLICT (app_name, scope, scope_id, key) DO UPDATE SET value = EXCLUDED.value`,
        upserts,
      )
    }

    for (const [groupKey, keys] of deleteGroups) {
      const [scope, scopeId] = groupKey.split('\0')
      const placeholders = keys.map((_, i) => `$${i + 4}`)
      await q.query(
        `DELETE FROM scoped_state WHERE app_name = $1 AND scope = $2 AND scope_id = $3 AND key IN (${placeholders.join(', ')})`,
        [appName, scope, scopeId, ...keys],
      )
    }
  }

  async delete(appName: string, sessionId: string): Promise<void> {
    await this.ensureSchema()
    await this.withTransaction(async (client) => {
      await client.query('DELETE FROM events WHERE app_name = $1 AND session_id = $2', [
        appName,
        sessionId,
      ])
      await client.query('DELETE FROM sessions WHERE app_name = $1 AND id = $2', [
        appName,
        sessionId,
      ])
    })
  }

  async loadScopedState(
    appName: string,
    scope: string,
    scopeId: string,
  ): Promise<Record<string, unknown>> {
    await this.ensureSchema()
    const pool = await this.getPool()
    const result = await pool.query(
      'SELECT key, value FROM scoped_state WHERE app_name = $1 AND scope = $2 AND scope_id = $3',
      [appName, scope, scopeId],
    )

    const state: Record<string, unknown> = {}
    for (const row of result.rows) {
      // value is JSONB: the driver has already decoded it, so a string here IS the stored string
      // value — re-parsing it would crash on any state value like 'dark'.
      state[String(row.key)] = row.value
    }
    return state
  }

  async saveScopedState(
    appName: string,
    scope: string,
    scopeId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureSchema()
    const pool = await this.getPool()
    const entries = Object.entries(state)
    if (entries.length === 0) return

    const upserts = entries.filter(([, v]) => v !== undefined)
    const deletes = entries.filter(([, v]) => v === undefined)

    const promises: Promise<unknown>[] = []

    if (upserts.length > 0) {
      const values = upserts.map((_, i) => {
        const base = i * 2 + 4
        return `($1, $2, $3, $${base}, $${base + 1}::jsonb)`
      })
      const params: unknown[] = [appName, scope, scopeId]
      for (const [key, value] of upserts) {
        params.push(key, JSON.stringify(value))
      }
      promises.push(
        pool.query(
          `INSERT INTO scoped_state (app_name, scope, scope_id, key, value)
           VALUES ${values.join(', ')}
           ON CONFLICT (app_name, scope, scope_id, key) DO UPDATE SET value = EXCLUDED.value`,
          params,
        ),
      )
    }

    if (deletes.length > 0) {
      const placeholders = deletes.map((_, i) => `$${i + 4}`)
      promises.push(
        pool.query(
          `DELETE FROM scoped_state WHERE app_name = $1 AND scope = $2 AND scope_id = $3 AND key IN (${placeholders.join(', ')})`,
          [appName, scope, scopeId, ...deletes.map(([k]) => k)],
        ),
      )
    }

    if (promises.length > 0) await Promise.all(promises)
  }

  async list(appName: string): Promise<Array<{ id: string; updatedAt: number }>> {
    await this.ensureSchema()
    const pool = await this.getPool()
    const result = await pool.query(
      'SELECT id, updated_at FROM sessions WHERE app_name = $1 ORDER BY updated_at DESC',
      [appName],
    )
    return result.rows.map((r) => ({ id: String(r.id), updatedAt: Number(r.updated_at) }))
  }

  async close(): Promise<void> {
    const pool = await this.getPool()
    await pool.end()
  }
}
