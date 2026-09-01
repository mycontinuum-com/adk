/**
 * PostgresProcessStore Compliance Tests
 *
 * Runs the full ProcessStore compliance suite against a real Postgres database. Requires
 * DATABASE_URL environment variable pointing to a Postgres instance.
 *
 * Run with: DATABASE_URL=postgres://... pnpm test -- src/gateway/postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import type { BaselinePool } from '../test-support/postgres-baseline'

import { COMPLIANCE_PARENT_PROCESS_IDS, ensureAdkBaseline } from '../test-support/postgres-baseline'
import { runProcessStoreTests } from './compliance.test'
import { PostgresProcessStore } from './postgres'

const DATABASE_URL = process.env.DATABASE_URL

// oxlint-disable-next-line eslint-plugin-vitest(no-conditional-tests)
if (!DATABASE_URL) {
  describe('PostgresProcessStore', () => {
    test.skip('requires DATABASE_URL environment variable', () => {})
  })
} else {
  let pool: BaselinePool & { end(): Promise<void> }

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: DATABASE_URL })
    await ensureAdkBaseline(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  runProcessStoreTests(
    'PostgresProcessStore',
    () => new PostgresProcessStore({ pool, schema: 'adk' }),
    async () => {
      // The artifacts compliance suite's seeded parent processes are preserved — by exact
      // (app_name, id) pair, never bare id, so a gateway process reusing one of those ids under
      // another app cannot leak across resets — letting the two suites share one database from
      // parallel vitest workers. Messages and artifact versions cascade via the composite FKs;
      // messages under the preserved parents are cleared explicitly.
      const preservedPairs = COMPLIANCE_PARENT_PROCESS_IDS.map(
        (_, i) => `($${2 * i + 1}, $${2 * i + 2})`,
      ).join(', ')
      await pool.query(
        `DELETE FROM adk.processes WHERE (app_name, id) NOT IN (${preservedPairs})`,
        COMPLIANCE_PARENT_PROCESS_IDS.flatMap((pair) => [...pair]),
      )
      await pool.query('DELETE FROM adk.messages')
    },
  )

  describe('PostgresProcessStore — revertStale clock domain', () => {
    test('ignores app-host clock skew: a fresh claim survives a fast app clock', async () => {
      const store = new PostgresProcessStore({ pool, schema: 'adk' })
      const appName = 'clock-skew-app'
      try {
        await store.create({
          id: 'skewed',
          appName,
          agentName: 'skew-agent',
          sessionId: 'skew-session',
          status: 'sleeping',
          paused: false,
          schedule: null,
          nextWakeAt: new Date(Date.now() - 1000),
          executor: null,
          executorConfig: {},
          lastRunAt: null,
          createdAt: new Date(),
          metadata: {},
        })
        expect(await store.claimDue(appName, 10)).toHaveLength(1)

        // App host running a day ahead of the DB: an app-computed cutoff (Date.now() - timeout)
        // would revert the just-claimed process immediately (duplicate execution); the DB-domain
        // cutoff must leave it queued.
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 })
        try {
          expect(await store.revertStale(appName, 60 * 60 * 1000)).toBe(0)
        } finally {
          vi.useRealTimers()
        }
        expect((await store.get(appName, 'skewed'))!.status).toBe('queued')
      } finally {
        await pool.query('DELETE FROM adk.processes WHERE app_name = $1', [appName])
      }
    })
  })
}
