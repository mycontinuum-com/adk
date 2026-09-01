/**
 * PostgresArtifactService Compliance Tests
 *
 * Runs the full ArtifactService compliance suite against a real Postgres database. Requires
 * DATABASE_URL environment variable pointing to a Postgres instance.
 *
 * Run with: DATABASE_URL=postgres://... pnpm test -- src/artifacts/postgres.test.ts
 */

import { afterAll, beforeAll, describe, test } from 'vitest'

import type { BaselinePool } from '../test-support/postgres-baseline'

import { COMPLIANCE_PARENT_PROCESS_IDS, ensureAdkBaseline } from '../test-support/postgres-baseline'
import { runArtifactServiceTests } from './compliance.test'
import { PostgresArtifactService } from './postgres'

const DATABASE_URL = process.env.DATABASE_URL

// oxlint-disable-next-line eslint-plugin-vitest(no-conditional-tests)
if (!DATABASE_URL) {
  describe('PostgresArtifactService', () => {
    test.skip('requires DATABASE_URL environment variable', () => {})
  })
} else {
  let pool: BaselinePool & { end(): Promise<void> }

  beforeAll(async () => {
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: DATABASE_URL })
    await ensureAdkBaseline(pool)
    // Seed the parent process rows the composite FK on artifact_versions requires for every
    // (appName, processId) pair the compliance suite saves under.
    for (const [appName, processId] of COMPLIANCE_PARENT_PROCESS_IDS) {
      await pool.query(
        `INSERT INTO adk.processes (app_name, id, agent_name, session_id)
         VALUES ($1, $2, 'artifact-compliance-parent', $2)
         ON CONFLICT DO NOTHING`,
        [appName, processId],
      )
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  runArtifactServiceTests(
    'PostgresArtifactService',
    () => new PostgresArtifactService({ pool, schema: 'adk' }),
    async () => {
      await pool.query('DELETE FROM adk.artifact_versions;')
    },
  )
}
