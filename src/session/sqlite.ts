import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Event } from '../types/events'
import type { SessionStore, StoredSession, CommitResult, ScopedStateChange } from '../types/session'

/** The slice of better-sqlite3 this store uses — the peer stays a dynamic import. */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number }
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

interface SessionRow {
  app_name: string
  id: string
  version: number
  scopes: string
  created_at: number
  updated_at: number
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  scopes TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_name, id)
);

CREATE TABLE IF NOT EXISTS events (
  app_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (app_name, session_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_session
  ON events(app_name, session_id, idx);

CREATE TABLE IF NOT EXISTS scoped_state (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`

function mergeState(target: Record<string, unknown>, changes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete target[key]
    else target[key] = value
  }
}

// The specifier is held in a variable so bundlers leave the optional peer alone, and the try wraps
// nothing but the import so the curated message can only ever replace a resolution failure. The
// original error rides along as `cause` for the cases resolution is not what went wrong.
async function importBetterSqlite3(): Promise<new (path: string) => SqliteDatabase> {
  const sqliteModule = 'better-sqlite3'
  try {
    const { default: Database } = (await import(sqliteModule)) as {
      default: new (path: string) => SqliteDatabase
    }
    return Database
  } catch (error) {
    throw new Error('better-sqlite3 not found. Install it with: npm install better-sqlite3', {
      cause: error,
    })
  }
}

/** Create a SQLite session store at the given file path (`':memory:'` for an ephemeral store). */
export function sqliteStore(dbPath: string): SessionStore {
  return new SQLiteStore(dbPath)
}

/**
 * SQLite SessionStore over the optional `better-sqlite3` peer — zero-infrastructure durable
 * sessions for local development, CLIs, and single-process deployments. Events use an integer `idx`
 * for ordering, safe because SQLite is single-writer (no concurrent-commit index race). `commit()`
 * applies the OCC version bump, event appends, and scoped-state changes in one transaction, so a
 * conflict writes nothing.
 */
export class SQLiteStore implements SessionStore {
  // The in-flight promise is what is memoized, never the resolved handle: two concurrent first
  // calls must share one open, or (for ':memory:') each would get its own database and one side's
  // committed writes would silently vanish.
  private dbPromise: Promise<SqliteDatabase> | null = null
  private readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  private getDb(): Promise<SqliteDatabase> {
    this.dbPromise ??= this.open()
    return this.dbPromise
  }

  private async open(): Promise<SqliteDatabase> {
    const Database = await importBetterSqlite3()
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true })
    }
    const db = new Database(this.dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA_SQL)
    return db
  }

  async load(
    appName: string,
    sessionId: string,
  ): Promise<{ session: StoredSession; events: Event[] } | null> {
    const db = await this.getDb()
    const row = db
      .prepare('SELECT * FROM sessions WHERE app_name = ? AND id = ?')
      .get(appName, sessionId) as SessionRow | undefined
    if (!row) return null

    const session: StoredSession = {
      id: row.id,
      appName: row.app_name,
      version: row.version,
      scopes: JSON.parse(row.scopes || '{}'),
      createdAt: row.created_at,
    }

    const eventRows = db
      .prepare('SELECT data FROM events WHERE app_name = ? AND session_id = ? ORDER BY idx')
      .all(appName, sessionId) as Array<{ data: string }>
    const events: Event[] = eventRows.map((r) => JSON.parse(r.data))

    return { session, events }
  }

  async commit(
    session: StoredSession,
    newEvents: Event[],
    expectedVersion: number,
    scopedChanges?: ScopedStateChange[],
  ): Promise<CommitResult> {
    const db = await this.getDb()
    const now = Date.now()
    const scopesJson = JSON.stringify(session.scopes ?? {})

    const run = db.transaction((): CommitResult => {
      const updated = db
        .prepare(
          `UPDATE sessions SET version = version + 1, updated_at = ?, scopes = ?
           WHERE app_name = ? AND id = ? AND version = ?`,
        )
        .run(now, scopesJson, session.appName, session.id, expectedVersion)

      let newVersion: number
      if (updated.changes === 0) {
        const current = db
          .prepare('SELECT version FROM sessions WHERE app_name = ? AND id = ?')
          .get(session.appName, session.id) as { version: number } | undefined
        if (current) {
          return { ok: false, conflict: true, currentVersion: current.version }
        }
        if (expectedVersion > 0) {
          return { ok: false, conflict: true, currentVersion: 0 }
        }
        db.prepare(
          `INSERT INTO sessions (app_name, id, version, scopes, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        ).run(session.appName, session.id, scopesJson, session.createdAt, now)
        newVersion = 1
      } else {
        newVersion = expectedVersion + 1
      }

      if (newEvents.length > 0) {
        const countRow = db
          .prepare('SELECT COUNT(*) as cnt FROM events WHERE app_name = ? AND session_id = ?')
          .get(session.appName, session.id) as { cnt: number }
        const insert = db.prepare(
          'INSERT OR IGNORE INTO events (app_name, session_id, event_id, idx, data) VALUES (?, ?, ?, ?, ?)',
        )
        // idx advances only past rows actually inserted — counting an ignored duplicate would hand
        // its idx to the next event and leave ORDER BY idx unspecified from then on.
        let nextIdx = countRow.cnt
        for (const event of newEvents) {
          const inserted = insert.run(
            session.appName,
            session.id,
            event.id,
            nextIdx,
            JSON.stringify(event),
          )
          if (inserted.changes === 1) nextIdx++
        }
      }

      if (scopedChanges) {
        for (const { scope, scopeId, changes } of scopedChanges) {
          const key = `${session.appName}:${scope}:${scopeId}`
          const row = db.prepare('SELECT data FROM scoped_state WHERE id = ?').get(key) as
            | { data: string }
            | undefined
          const existing: Record<string, unknown> = row ? JSON.parse(row.data) : {}
          mergeState(existing, changes)
          db.prepare('INSERT OR REPLACE INTO scoped_state (id, data) VALUES (?, ?)').run(
            key,
            JSON.stringify(existing),
          )
        }
      }

      return { ok: true, version: newVersion }
    })

    return run()
  }

  async delete(appName: string, sessionId: string): Promise<void> {
    const db = await this.getDb()
    const run = db.transaction(() => {
      db.prepare('DELETE FROM events WHERE app_name = ? AND session_id = ?').run(appName, sessionId)
      db.prepare('DELETE FROM sessions WHERE app_name = ? AND id = ?').run(appName, sessionId)
    })
    run()
  }

  async loadScopedState(
    appName: string,
    scope: string,
    scopeId: string,
  ): Promise<Record<string, unknown>> {
    const db = await this.getDb()
    const row = db
      .prepare('SELECT data FROM scoped_state WHERE id = ?')
      .get(`${appName}:${scope}:${scopeId}`) as { data: string } | undefined
    return row ? JSON.parse(row.data) : {}
  }

  async saveScopedState(
    appName: string,
    scope: string,
    scopeId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const db = await this.getDb()
    const key = `${appName}:${scope}:${scopeId}`
    const row = db.prepare('SELECT data FROM scoped_state WHERE id = ?').get(key) as
      | { data: string }
      | undefined
    const existing: Record<string, unknown> = row ? JSON.parse(row.data) : {}
    mergeState(existing, state)
    db.prepare('INSERT OR REPLACE INTO scoped_state (id, data) VALUES (?, ?)').run(
      key,
      JSON.stringify(existing),
    )
  }

  async list(appName: string): Promise<Array<{ id: string; updatedAt: number }>> {
    const db = await this.getDb()
    const rows = db
      .prepare('SELECT id, updated_at FROM sessions WHERE app_name = ? ORDER BY updated_at DESC')
      .all(appName) as Array<{ id: string; updated_at: number }>
    return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }))
  }

  async close(): Promise<void> {
    const pending = this.dbPromise
    this.dbPromise = null
    if (pending) (await pending).close()
  }
}
