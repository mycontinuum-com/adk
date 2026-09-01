/**
 * PostgresArtifactService — Production backend for artifact storage.
 *
 * Uses raw SQL queries against the ADK schema (adk.artifact_versions). No Drizzle dependency —
 * maintains ADK's publishability by depending only on the pg peer dependency.
 *
 * The canonical DDL is the hand-authored baseline shipped with the package at
 * migrations/0000_adk_baseline.sql; this module uses raw SQL to avoid coupling to Drizzle.
 * artifact_versions carries a composite FK (app_name, process_id) → processes(app_name, id) ON
 * DELETE CASCADE: an artifact belongs to an EXISTING process (save() for an unknown process fails
 * the FK), and deleting a process erases its artifact versions with it.
 *
 * Binary content is stored as Postgres BYTEA for small payloads. Large binaries can be delegated to
 * S3 with a URI reference (future enhancement).
 */

import type {
  ArtifactService,
  Artifact,
  ArtifactSummary,
  ArtifactVersion,
  LoadArtifactOptions,
  SaveArtifactOptions,
  SaveArtifactResult,
} from './types'

import { inferMimeType } from './types'

export interface PostgresArtifactServiceConfig {
  /** Postgres connection string. Used if pool is not provided. */
  connectionString?: string
  /** Existing pg Pool instance. Takes precedence over connectionString. */
  pool?: unknown
  /** Schema name for the ADK tables. Defaults to 'adk'. */
  schema?: string
}

interface PgPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  end(): Promise<void>
  on(event: 'error', listener: (err: Error) => void): void
}

/**
 * Create a Postgres ArtifactService.
 *
 * @example
 *   ;```typescript
 *   import { postgresArtifactService } from '@animahealth/adk/artifacts/postgres'
 *
 *   const service = postgresArtifactService({
 *     connectionString: process.env.DATABASE_URL,
 *   })
 *
 *   await service.save('my-app', 'process-1', 'plan', '# Implementation Plan\n...')
 *   const artifact = await service.load('my-app', 'process-1', 'plan')
 *   ```
 */
export function postgresArtifactService(config: PostgresArtifactServiceConfig): ArtifactService {
  return new PostgresArtifactService(config)
}

/**
 * Postgres ArtifactService implementation.
 *
 * All queries use parameterized SQL to prevent injection. Artifacts are stored with automatic
 * versioning — each save creates a new immutable version.
 */
export class PostgresArtifactService implements ArtifactService {
  private pool: PgPool | null = null
  /** True only for a pool this service constructed itself — the only pool close() may end. */
  private ownsPool = false
  private readonly config: PostgresArtifactServiceConfig
  private readonly schema: string

  constructor(config: PostgresArtifactServiceConfig) {
    if (!config.pool && !config.connectionString) {
      throw new Error('PostgresArtifactService requires either pool or connectionString')
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
      // Node terminates the process — only for a pool THIS service constructs itself; a caller-injected
      // config.pool is that caller's own to manage.
      this.pool.on('error', (err) => {
        console.error('PostgresArtifactService: idle client error (pool recovers):', err)
      })
    }
    return this.pool
  }

  /**
   * Save artifact data. Creates a new immutable version.
   *
   * Precondition: (appName, processId) must already exist as a row in `<schema>.processes` —
   * artifact_versions carries a composite FK (app_name, process_id) → processes(app_name, id) ON
   * DELETE CASCADE. Saving under an unregistered process rejects with a Postgres foreign-key
   * violation (SQLSTATE 23503); deleting the process erases every artifact version with it. This
   * diverges from InMemoryArtifactService, which accepts any process id — code that passes the
   * memory backend can still fail here until the process is registered.
   */
  async save(
    appName: string,
    processId: string,
    name: string,
    data: Buffer | string,
    options?: SaveArtifactOptions,
  ): Promise<SaveArtifactResult> {
    const pool = await this.getPool()
    const mimeType = options?.mimeType ?? inferMimeType(data)
    const metadata = options?.metadata ?? {}

    // Get the next version number atomically
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version) + 1, 0) as next_version
       FROM ${this.schema}.artifact_versions
       WHERE app_name = $1 AND process_id = $2 AND name = $3`,
      [appName, processId, name],
    )
    const version = Number(versionResult.rows[0].next_version)

    // Convert string to Buffer for storage
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')

    await pool.query(
      `INSERT INTO ${this.schema}.artifact_versions
       (app_name, process_id, name, version, mime_type, data, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
      [appName, processId, name, version, mimeType, dataBuffer, JSON.stringify(metadata)],
    )

    return { version, mimeType }
  }

  async load(
    appName: string,
    processId: string,
    name: string,
    options?: LoadArtifactOptions,
  ): Promise<Artifact | null> {
    const pool = await this.getPool()

    let sql: string
    let params: unknown[]

    if (options?.version !== undefined) {
      // Load specific version
      sql = `
        SELECT version, mime_type, data, uri, metadata, created_at
        FROM ${this.schema}.artifact_versions
        WHERE app_name = $1 AND process_id = $2 AND name = $3 AND version = $4
      `
      params = [appName, processId, name, options.version]
    } else {
      // Load latest version
      sql = `
        SELECT version, mime_type, data, uri, metadata, created_at
        FROM ${this.schema}.artifact_versions
        WHERE app_name = $1 AND process_id = $2 AND name = $3
        ORDER BY version DESC
        LIMIT 1
      `
      params = [appName, processId, name]
    }

    const result = await pool.query(sql, params)

    if (result.rows.length === 0) {
      return null
    }

    const row = result.rows[0]
    return this.rowToArtifact(row)
  }

  async list(appName: string, processId: string): Promise<ArtifactSummary[]> {
    const pool = await this.getPool()

    // Get the latest version of each artifact
    const result = await pool.query(
      `SELECT DISTINCT ON (name) name, version as latest_version, mime_type, created_at as updated_at
       FROM ${this.schema}.artifact_versions
       WHERE app_name = $1 AND process_id = $2
       ORDER BY name, version DESC`,
      [appName, processId],
    )

    const summaries = result.rows.map(
      (row): ArtifactSummary => ({
        name: String(row.name),
        latestVersion: Number(row.latest_version),
        mimeType: String(row.mime_type),
        updatedAt: new Date(row.updated_at as string | number),
      }),
    )

    // Sort by updatedAt descending (most recent first)
    summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())

    return summaries
  }

  async listVersions(appName: string, processId: string, name: string): Promise<ArtifactVersion[]> {
    const pool = await this.getPool()

    const result = await pool.query(
      `SELECT version, mime_type, metadata, created_at
       FROM ${this.schema}.artifact_versions
       WHERE app_name = $1 AND process_id = $2 AND name = $3
       ORDER BY version DESC`,
      [appName, processId, name],
    )

    return result.rows.map(
      (row): ArtifactVersion => ({
        version: Number(row.version),
        mimeType: String(row.mime_type),
        metadata: this.parseJsonb(row.metadata),
        createdAt: new Date(row.created_at as string | number),
      }),
    )
  }

  async delete(appName: string, processId: string, name: string): Promise<void> {
    const pool = await this.getPool()

    await pool.query(
      `DELETE FROM ${this.schema}.artifact_versions
       WHERE app_name = $1 AND process_id = $2 AND name = $3`,
      [appName, processId, name],
    )
  }

  async close(): Promise<void> {
    // End only a pool this service constructed itself — a caller-injected config.pool is that
    // caller's own to manage (ending it here would kill every other user of the shared pool).
    if (this.pool && this.ownsPool) {
      await this.pool.end()
    }
    this.pool = this.config.pool ? (this.config.pool as PgPool) : null
    this.ownsPool = false
  }

  private rowToArtifact(row: Record<string, unknown>): Artifact {
    const mimeType = String(row.mime_type)
    const dataRaw = row.data as Buffer | null

    // Convert Buffer to string for text-based MIME types
    let data: Buffer | string
    if (!dataRaw) {
      data = Buffer.from([])
    } else if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/javascript' ||
      mimeType === 'application/xml'
    ) {
      data = dataRaw.toString('utf-8')
    } else {
      data = dataRaw
    }

    return {
      data,
      mimeType,
      version: Number(row.version),
      metadata: this.parseJsonb(row.metadata),
      createdAt: new Date(row.created_at as string | number),
    }
  }

  private parseJsonb(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch {
        return {}
      }
    }
    if (value && typeof value === 'object') {
      return value as Record<string, unknown>
    }
    return {}
  }
}
