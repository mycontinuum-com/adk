/**
 * Shared bootstrap for the adk Postgres compliance test files (gateway/postgres.test.ts and
 * artifacts/postgres.test.ts), which share one DATABASE_URL database across parallel vitest
 * workers. Test support only — not part of the published API surface.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ONE shape source: the canonical hand-authored baseline DDL, never a hand-copied twin
// (2026-07 schema-layer review §9 — the third hand-copied DDL in these tests disagreed with both
// the migration and the binding).
const BASELINE_SQL_PATH = fileURLToPath(
  new URL('../../migrations/0000_adk_baseline.sql', import.meta.url),
)

/** The minimal pg.Pool surface the bootstrap needs (pg stays a dynamically imported peer). */
export interface BaselinePool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  connect(): Promise<{
    query(text: string): Promise<{ rows: Record<string, unknown>[] }>
    release(): void
  }>
}

/**
 * The (appName, processId) pairs the artifacts compliance suite saves artifacts under.
 * artifact_versions carries a composite FK (app_name, process_id) → processes(app_name, id), so
 * each pair needs a parent process row seeded before the suite runs. Kept in lockstep with
 * artifacts/compliance.test.ts — a new pair there fails with a clear FK violation. The gateway
 * suite's per-test reset preserves exactly these pairs (never bare ids) so the two suites can share
 * one database from parallel vitest workers without leaking state across resets.
 */
export const COMPLIANCE_PARENT_PROCESS_IDS: ReadonlyArray<
  readonly [appName: string, processId: string]
> = [
  ['app', 'proc1'],
  ['app', 'proc2'],
  ['app', 'p'],
  ['app1', 'proc1'],
  ['app1', 'proc2'],
  ['app2', 'proc1'],
]

/**
 * Idempotently apply the canonical adk baseline DDL to the pool's database, serialized against the
 * other adk postgres test file bootstrapping the same database from a parallel vitest worker.
 * Throws if the database carries a pre-baseline adk schema, so the mismatch fails loudly here
 * instead of confusingly per-test.
 */
export async function ensureAdkBaseline(pool: BaselinePool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize the two adk postgres test files (gateway + artifacts) bootstrapping the same
    // database from parallel vitest workers.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('adk_baseline_ddl'))")
    await client.query('CREATE SCHEMA IF NOT EXISTS adk')
    const existing = await client.query("SELECT to_regclass('adk.processes') AS t")
    if (existing.rows[0].t === null) {
      await client.query(readFileSync(BASELINE_SQL_PATH, 'utf8'))
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  // A pre-baseline adk schema (no claimed_at) fails loudly here instead of confusingly per-test.
  const shape = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'adk' AND table_name = 'processes' AND column_name = 'claimed_at'`,
  )
  if (shape.rows.length === 0) {
    throw new Error(
      'adk schema in this database predates the 2026-07 baseline — reset it (e.g. `./serenity db reset --cell factory`) and re-run',
    )
  }
}
