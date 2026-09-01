import type { SessionStore, StoredSession, Event } from '../../types'

import { InMemoryStore } from './memory'

function makeSession(overrides?: Partial<StoredSession>): StoredSession {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    appName: 'test-app',
    version: 0,
    scopes: {},
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeEvent(index: number): Event {
  return {
    id: `evt-${Date.now()}-${index}`,
    type: 'user',
    createdAt: Date.now() + index,
    text: `Message ${index}`,
  } as any
}

export function runSessionStoreTests(
  name: string,
  createStore: () => SessionStore,
  cleanup?: () => void | Promise<void>,
) {
  describe(`${name} — SessionStore compliance`, () => {
    let store: SessionStore

    beforeEach(() => {
      store = createStore()
    })

    // Awaited: a store over a shared backend (Postgres, DynamoDB) wipes its tables here — the
    // suite's fixtures reuse app/scope keys, so leftover rows from one test poison the next.
    afterEach(async () => {
      await cleanup?.()
    })

    describe('load', () => {
      test('returns null for non-existent session', async () => {
        const result = await store.load('app', 'missing')
        expect(result).toBeNull()
      })

      test('returns stored session and events after commit', async () => {
        const session = makeSession({ id: 'load-test', appName: 'app' })
        const events = [makeEvent(0), makeEvent(1)]
        await store.commit(session, events, 0)

        const loaded = await store.load('app', 'load-test')
        expect(loaded).not.toBeNull()
        expect(loaded!.session.id).toBe('load-test')
        expect(loaded!.session.appName).toBe('app')
        expect(loaded!.events).toHaveLength(2)
      })

      test('sessions are isolated by appName', async () => {
        await store.commit(makeSession({ id: 's1', appName: 'app1' }), [], 0)
        await store.commit(makeSession({ id: 's1', appName: 'app2' }), [], 0)

        const r1 = await store.load('app1', 's1')
        const r2 = await store.load('app2', 's1')
        expect(r1).not.toBeNull()
        expect(r2).not.toBeNull()
        expect(r1!.session.appName).toBe('app1')
        expect(r2!.session.appName).toBe('app2')
      })

      test('persists scopes on session', async () => {
        const session = makeSession({
          id: 'scopes-test',
          appName: 'app',
          scopes: { user: 'u-1', org: 'org-1' },
        })
        await store.commit(session, [], 0)

        const loaded = await store.load('app', 'scopes-test')
        expect(loaded!.session.scopes).toEqual({ user: 'u-1', org: 'org-1' })
      })
    })

    describe('commit', () => {
      test('returns ok with version', async () => {
        const result = await store.commit(makeSession({ id: 'c1', appName: 'app' }), [], 0)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(typeof result.version).toBe('number')
          expect(result.version).toBeGreaterThan(0)
        }
      })

      test('appends new events on subsequent commits', async () => {
        const session = makeSession({ id: 'c2', appName: 'app' })
        const r1 = await store.commit(session, [makeEvent(0), makeEvent(1)], 0)
        expect(r1.ok).toBe(true)

        if (r1.ok) {
          await store.commit({ ...session, version: r1.version }, [makeEvent(2)], r1.version)
        }

        const loaded = await store.load('app', 'c2')
        expect(loaded!.events).toHaveLength(3)
      })

      test('events from a single commit preserve insertion order', async () => {
        const session = makeSession({ id: 'order-test', appName: 'app' })
        const e1 = makeEvent(0)
        const e2 = makeEvent(1)
        const e3 = makeEvent(2)

        await store.commit(session, [e1, e2, e3], 0)

        const loaded = await store.load('app', 'order-test')
        expect(loaded!.events).toHaveLength(3)
        expect(loaded!.events[0].id).toBe(e1.id)
        expect(loaded!.events[1].id).toBe(e2.id)
        expect(loaded!.events[2].id).toBe(e3.id)
      })

      test('events from subsequent commits are appended in order', async () => {
        const session = makeSession({ id: 'append-order', appName: 'app' })
        const e1 = makeEvent(0)
        const e2 = makeEvent(1)

        const r1 = await store.commit(session, [e1], 0)
        expect(r1.ok).toBe(true)

        if (r1.ok) {
          await store.commit({ ...session, version: r1.version }, [e2], r1.version)
        }

        const loaded = await store.load('app', 'append-order')
        expect(loaded!.events).toHaveLength(2)
        expect(loaded!.events[0].id).toBe(e1.id)
        expect(loaded!.events[1].id).toBe(e2.id)
      })

      test('re-committing a stored event id neither duplicates it nor disturbs later ordering', async () => {
        const session = makeSession({ id: 'dedup-order', appName: 'app' })
        const [e1, e2, e3, e4] = [makeEvent(0), makeEvent(1), makeEvent(2), makeEvent(3)]

        const r1 = await store.commit(session, [e1, e2], 0)
        expect(r1.ok).toBe(true)
        const r2 = await store.commit({ ...session, version: 1 }, [e2, e3], 1)
        expect(r2.ok).toBe(true)
        const r3 = await store.commit({ ...session, version: 2 }, [e4], 2)
        expect(r3.ok).toBe(true)

        const loaded = await store.load('app', 'dedup-order')
        expect(loaded!.events.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id, e4.id])
      })

      test('concurrent first commits to distinct sessions all land in one store', async () => {
        const a = makeSession({ id: 'race-a', appName: 'app' })
        const b = makeSession({ id: 'race-b', appName: 'app' })

        const [ra, rb] = await Promise.all([
          store.commit(a, [makeEvent(0)], 0),
          store.commit(b, [makeEvent(1)], 0),
        ])
        expect(ra.ok).toBe(true)
        expect(rb.ok).toBe(true)

        expect(await store.load('app', 'race-a')).not.toBeNull()
        expect(await store.load('app', 'race-b')).not.toBeNull()
      })

      test('OCC conflict when expectedVersion mismatches', async () => {
        const session = makeSession({ id: 'occ1', appName: 'app' })
        const r1 = await store.commit(session, [], 0)
        expect(r1.ok).toBe(true)

        const result = await store.commit(session, [makeEvent(0)], 999)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.conflict).toBe(true)
        }
      })

      test('commit with expectedVersion > 0 on deleted session returns conflict', async () => {
        const session = makeSession({ id: 'deleted-occ', appName: 'app' })
        const r1 = await store.commit(session, [makeEvent(0)], 0)
        expect(r1.ok).toBe(true)

        await store.delete('app', 'deleted-occ')

        if (r1.ok) {
          const result = await store.commit(
            { ...session, version: r1.version },
            [makeEvent(1)],
            r1.version,
          )
          expect(result.ok).toBe(false)
          if (!result.ok) {
            expect(result.conflict).toBe(true)
            expect(result.currentVersion).toBe(0)
          }
        }
      })

      test('commit with expectedVersion > 0 on never-created session returns conflict', async () => {
        const session = makeSession({ id: 'never-created', appName: 'app' })
        const result = await store.commit(session, [makeEvent(0)], 5)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.conflict).toBe(true)
          expect(result.currentVersion).toBe(0)
        }
      })

      test('OCC succeeds with correct expectedVersion', async () => {
        const session = makeSession({ id: 'occ2', appName: 'app' })
        const r1 = await store.commit(session, [], 0)
        expect(r1.ok).toBe(true)

        if (r1.ok) {
          const r2 = await store.commit(
            { ...session, version: r1.version },
            [makeEvent(0)],
            r1.version,
          )
          expect(r2.ok).toBe(true)
        }
      })

      test('batches scoped state changes atomically with commit', async () => {
        const session = makeSession({ id: 'batch-scope', appName: 'app' })
        const r1 = await store.commit(session, [makeEvent(0)], 0, [
          { scope: 'user', scopeId: 'u1', changes: { theme: 'dark' } },
          { scope: 'patient', scopeId: 'p1', changes: { name: 'Alice' } },
        ])
        expect(r1.ok).toBe(true)

        expect(await store.loadScopedState('app', 'user', 'u1')).toEqual({ theme: 'dark' })
        expect(await store.loadScopedState('app', 'patient', 'p1')).toEqual({ name: 'Alice' })
      })

      test('scoped state not written on OCC conflict', async () => {
        const session = makeSession({ id: 'batch-conflict', appName: 'app' })
        const r1 = await store.commit(session, [], 0)
        expect(r1.ok).toBe(true)

        const result = await store.commit(session, [], 999, [
          { scope: 'user', scopeId: 'u2', changes: { theme: 'light' } },
        ])
        expect(result.ok).toBe(false)

        expect(await store.loadScopedState('app', 'user', 'u2')).toEqual({})
      })

      test('commit deletes scoped state keys set to undefined', async () => {
        const session = makeSession({ id: 'del-commit', appName: 'app' })
        const r1 = await store.commit(session, [], 0, [
          { scope: 'user', scopeId: 'u-del', changes: { a: 1, b: 2 } },
        ])
        expect(r1.ok).toBe(true)

        if (r1.ok) {
          await store.commit({ ...session, version: r1.version }, [], r1.version, [
            { scope: 'user', scopeId: 'u-del', changes: { b: undefined } },
          ])
        }

        expect(await store.loadScopedState('app', 'user', 'u-del')).toEqual({ a: 1 })
      })

      test('handles large event batches (>25 events)', async () => {
        const session = makeSession({ id: 'large-batch', appName: 'app' })
        const events = Array.from({ length: 30 }, (_, i) => makeEvent(i))
        const result = await store.commit(session, events, 0)
        expect(result.ok).toBe(true)

        const loaded = await store.load('app', 'large-batch')
        expect(loaded!.events).toHaveLength(30)
      })

      test('first create with expectedVersion 0 succeeds', async () => {
        const session = makeSession({ id: 'create-v0', appName: 'app' })
        const result = await store.commit(session, [], 0)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.version).toBe(1)
        }
      })

      test('duplicate create with expectedVersion 0 returns conflict', async () => {
        const session = makeSession({ id: 'dup-create', appName: 'app' })
        const r1 = await store.commit(session, [], 0)
        expect(r1.ok).toBe(true)

        const r2 = await store.commit(session, [], 0)
        expect(r2.ok).toBe(false)
        if (!r2.ok) {
          expect(r2.conflict).toBe(true)
        }
      })
    })

    describe('delete', () => {
      test('removes session and events', async () => {
        await store.commit(makeSession({ id: 'd1', appName: 'app' }), [makeEvent(0)], 0)
        await store.delete('app', 'd1')

        const loaded = await store.load('app', 'd1')
        expect(loaded).toBeNull()
      })

      test('does not throw for non-existent session', async () => {
        await expect(store.delete('app', 'missing')).resolves.toBeUndefined()
      })
    })

    describe('list', () => {
      test('returns empty array when no sessions exist', async () => {
        if (!store.list) return
        const result = await store.list('app')
        expect(result).toEqual([])
      })

      test('returns sessions for the given app', async () => {
        if (!store.list) return
        await store.commit(makeSession({ id: 's1', appName: 'app' }), [], 0)
        await store.commit(makeSession({ id: 's2', appName: 'app' }), [], 0)
        await store.commit(makeSession({ id: 's3', appName: 'other' }), [], 0)

        const result = await store.list('app')
        expect(result).toHaveLength(2)
        const ids = result.map((r) => r.id).toSorted()
        expect(ids).toEqual(['s1', 's2'])
      })

      test('returns results sorted by updatedAt descending', async () => {
        if (!store.list) return
        const s1 = makeSession({ id: 'old', appName: 'app' })
        const r1 = await store.commit(s1, [], 0)
        expect(r1.ok).toBe(true)

        await new Promise((r) => setTimeout(r, 10))

        const s2 = makeSession({ id: 'new', appName: 'app' })
        await store.commit(s2, [], 0)

        const result = await store.list('app')
        expect(result[0].id).toBe('new')
        expect(result[1].id).toBe('old')
      })

      test('updatedAt changes after commit', async () => {
        if (!store.list) return
        const session = makeSession({ id: 'upd', appName: 'app' })
        const r1 = await store.commit(session, [], 0)
        expect(r1.ok).toBe(true)

        const before = await store.list('app')
        const beforeUpdatedAt = before[0].updatedAt

        await new Promise((r) => setTimeout(r, 10))

        if (r1.ok) {
          await store.commit({ ...session, version: r1.version }, [makeEvent(0)], r1.version)
        }

        const after = await store.list('app')
        expect(after[0].updatedAt).toBeGreaterThan(beforeUpdatedAt)
      })
    })

    describe('scoped state', () => {
      test('returns empty object for unknown scope', async () => {
        const state = await store.loadScopedState('app', 'user', 'u1')
        expect(state).toEqual({})
      })

      test('saves and loads scoped state', async () => {
        await store.saveScopedState('app', 'user', 'u1', { theme: 'dark' })
        const state = await store.loadScopedState('app', 'user', 'u1')
        expect(state).toEqual({ theme: 'dark' })
      })

      test('scoped state isolated by scope key', async () => {
        await store.saveScopedState('app', 'user', 'u1', { a: 1 })
        await store.saveScopedState('app', 'patient', 'u1', { b: 2 })

        expect(await store.loadScopedState('app', 'user', 'u1')).toEqual({ a: 1 })
        expect(await store.loadScopedState('app', 'patient', 'u1')).toEqual({ b: 2 })
      })

      test('scoped state isolated by appName', async () => {
        await store.saveScopedState('app1', 'user', 'u1', { x: 1 })
        await store.saveScopedState('app2', 'user', 'u1', { x: 2 })

        expect(await store.loadScopedState('app1', 'user', 'u1')).toEqual({ x: 1 })
        expect(await store.loadScopedState('app2', 'user', 'u1')).toEqual({ x: 2 })
      })

      test('merges scoped state on save', async () => {
        await store.saveScopedState('app', 'user', 'u1', { a: 1, b: 2 })
        await store.saveScopedState('app', 'user', 'u1', { a: 10 })

        const state = await store.loadScopedState('app', 'user', 'u1')
        expect(state).toEqual({ a: 10, b: 2 })
      })

      test('deletes keys with undefined values', async () => {
        await store.saveScopedState('app', 'user', 'u1', { a: 1, b: 2 })
        await store.saveScopedState('app', 'user', 'u1', { b: undefined })

        const state = await store.loadScopedState('app', 'user', 'u1')
        expect(state).toEqual({ a: 1 })
      })

      test('load returns deep clone (mutations do not affect store)', async () => {
        await store.saveScopedState('app', 'user', 'u1', { nested: { x: 1 } })
        const state = await store.loadScopedState('app', 'user', 'u1')
        ;(state.nested as any).x = 999

        const fresh = await store.loadScopedState('app', 'user', 'u1')
        expect((fresh.nested as any).x).toBe(1)
      })

      test('save clones input (caller mutations do not affect store)', async () => {
        const input = { nested: { x: 1 } }
        await store.saveScopedState('app', 'user', 'u1', input)
        ;(input.nested as any).x = 999

        const loaded = await store.loadScopedState('app', 'user', 'u1')
        expect((loaded.nested as any).x).toBe(1)
      })
    })
  })
}

runSessionStoreTests('InMemoryStore', () => new InMemoryStore())

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SQLite needs no environment — a throwaway file database gives the full compliance run everywhere.
import { SQLiteStore } from './sqlite'

{
  let sqliteStore: SQLiteStore | undefined
  let sqliteDir: string | undefined

  runSessionStoreTests(
    'SQLiteStore',
    () => {
      sqliteDir = mkdtempSync(join(tmpdir(), 'adk-sqlite-'))
      sqliteStore = new SQLiteStore(join(sqliteDir, 'sessions.db'))
      return sqliteStore
    },
    () => {
      void sqliteStore?.close()
      if (sqliteDir !== undefined) rmSync(sqliteDir, { recursive: true, force: true })
    },
  )
}

// `':memory:'` is an advertised mode with its own failure shape: every connection is a distinct
// database, so a lazy-open race that constructs two connections silently drops one side's writes.
{
  let memStore: SQLiteStore | undefined
  runSessionStoreTests(
    'SQLiteStore (:memory:)',
    () => {
      memStore = new SQLiteStore(':memory:')
      return memStore
    },
    () => {
      void memStore?.close()
    },
  )
}

describe('SQLiteStore — event idx stays unique through deduped re-commits', () => {
  test('a batch overlapping stored events never reuses an idx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adk-sqlite-idx-'))
    const dbPath = join(dir, 'sessions.db')
    const store = new SQLiteStore(dbPath)
    try {
      const session = makeSession({ id: 'idx-unique', appName: 'app' })
      const [e1, e2, e3, e4] = [makeEvent(0), makeEvent(1), makeEvent(2), makeEvent(3)]
      await store.commit(session, [e1, e2], 0)
      await store.commit({ ...session, version: 1 }, [e2, e3], 1)
      await store.commit({ ...session, version: 2 }, [e4], 2)
      await store.close()

      const { default: Database } = await import('better-sqlite3')
      const db = new Database(dbPath)
      const row = db
        .prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT idx) AS distinct_idx FROM events')
        .get() as { total: number; distinct_idx: number }
      db.close()
      expect(row.total).toBe(4)
      expect(row.distinct_idx).toBe(4)
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import { PostgresStore } from './postgres'

const testDbUrl = process.env.TEST_DATABASE_URL

// oxlint-disable-next-line eslint-plugin-vitest(no-conditional-tests)
if (testDbUrl) {
  let pgStore: PostgresStore

  runSessionStoreTests(
    'PostgresStore',
    () => {
      pgStore = new PostgresStore({ connectionString: testDbUrl })
      return pgStore
    },
    async () => {
      pgStore?.close()
      const { Pool } = await import('pg')
      const pool = new Pool({ connectionString: testDbUrl })
      // The three tables exist only once a store has written; TRUNCATE the ones that do.
      const { rows } = await pool.query(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = current_schema() AND tablename = ANY($1)`,
        [['sessions', 'events', 'scoped_state']],
      )
      if (rows.length > 0) {
        await pool.query(`TRUNCATE ${rows.map((row) => `"${row.tablename}"`).join(', ')}`)
      }
      await pool.end()
    },
  )

  describe('PostgresStore — event idx stays unique through deduped re-commits', () => {
    test('a batch overlapping stored events never reuses an idx', async () => {
      const store = new PostgresStore({ connectionString: testDbUrl })
      try {
        const session = makeSession({ id: `idx-unique-${Date.now()}`, appName: 'idx-probe-app' })
        const [e1, e2, e3, e4] = [makeEvent(0), makeEvent(1), makeEvent(2), makeEvent(3)]
        await store.commit(session, [e1, e2], 0)
        await store.commit({ ...session, version: 1 }, [e2, e3], 1)
        await store.commit({ ...session, version: 2 }, [e4], 2)

        const { Pool } = await import('pg')
        const pool = new Pool({ connectionString: testDbUrl })
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS total, COUNT(DISTINCT idx)::int AS distinct_idx
           FROM events WHERE app_name = $1 AND session_id = $2`,
          [session.appName, session.id],
        )
        await pool.end()
        expect(rows[0].total).toBe(4)
        expect(rows[0].distinct_idx).toBe(4)
      } finally {
        store.close()
      }
    })
  })
} else {
  describe('PostgresStore — SessionStore compliance', () => {
    test.skip('skipped: set TEST_DATABASE_URL to run', () => {})
  })
}

// DynamoDB runs against any endpoint (dynamodb-local in CI); the suite provisions its own table.
// Every documented store must actually run this suite — a store the suite never exercises is an
// undocumented deviation waiting to be found by a user instead of by CI.
import { DynamoDBStore } from './dynamodb'

const dynamoEndpoint = process.env.TEST_DYNAMODB_ENDPOINT

// oxlint-disable-next-line eslint-plugin-vitest(no-conditional-tests)
if (dynamoEndpoint) {
  const tableName = `adk_compliance_${process.pid}_${Date.now()}`
  const clientConfig = {
    endpoint: dynamoEndpoint,
    region: 'local',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }

  beforeAll(async () => {
    const { DynamoDBClient, CreateTableCommand, waitUntilTableExists } =
      await import('@aws-sdk/client-dynamodb')
    const client = new DynamoDBClient(clientConfig)
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    )
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName })
    client.destroy()
  })

  runSessionStoreTests(
    'DynamoDBStore',
    () => new DynamoDBStore({ tableName, client: clientConfig }),
    async () => {
      const { DynamoDBClient, ScanCommand, BatchWriteItemCommand } =
        await import('@aws-sdk/client-dynamodb')
      const client = new DynamoDBClient(clientConfig)
      for (;;) {
        const page = await client.send(
          new ScanCommand({ TableName: tableName, ProjectionExpression: 'pk, sk', Limit: 25 }),
        )
        const items = page.Items ?? []
        if (items.length === 0) break
        await client.send(
          new BatchWriteItemCommand({
            RequestItems: {
              [tableName]: items.map((item) => ({
                DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
              })),
            },
          }),
        )
      }
      client.destroy()
    },
  )
} else {
  describe('DynamoDBStore — SessionStore compliance', () => {
    test.skip('skipped: set TEST_DYNAMODB_ENDPOINT to run', () => {})
  })
}
