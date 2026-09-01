/**
 * ArtifactService types for the Fab's artifact storage layer.
 *
 * Artifacts are keyed binary blobs with versioning, MIME types, and metadata. Separate from
 * SessionStore because: - Sessions are append-only event ledgers; artifacts are mutable (new
 * versions replace old) - Artifacts support large binary payloads (images, PDFs) with different
 * storage needs - Independent scaling: artifact storage can use S3 for large files, Postgres for
 * metadata
 *
 * Cross-process knowledge scoping is handled by the Fab's knowledge layer (scope field), not by
 * namespace prefixes on artifact names.
 */

/** Stored artifact data with full metadata. Retrieved via ArtifactService.load(). */
export interface Artifact {
  /** Artifact content — string for text, Buffer for binary. */
  data: Buffer | string
  /** MIME type of the content (e.g., 'text/markdown', 'image/png', 'application/json'). */
  mimeType: string
  /** Immutable version number. Starts at 0, increments on each save. */
  version: number
  /** Optional custom metadata attached to this version. */
  metadata: Record<string, unknown>
  /** When this version was created. */
  createdAt: Date
}

/** Version metadata without content. Returned by ArtifactService.listVersions(). */
export interface ArtifactVersion {
  /** Immutable version number. */
  version: number
  /** MIME type of this version. */
  mimeType: string
  /** Custom metadata attached to this version. */
  metadata: Record<string, unknown>
  /** When this version was created. */
  createdAt: Date
}

/** Artifact summary for listing. Returned by ArtifactService.list(). */
export interface ArtifactSummary {
  /** Artifact name (unique within appName + processId). */
  name: string
  /** Latest version number. */
  latestVersion: number
  /** MIME type of the latest version. */
  mimeType: string
  /** When the latest version was created. */
  updatedAt: Date
}

/** Options for ArtifactService.save(). */
export interface SaveArtifactOptions {
  /** Explicit MIME type. If omitted, inferred from data type. */
  mimeType?: string
  /** Custom metadata to attach to this version. */
  metadata?: Record<string, unknown>
}

/** Options for ArtifactService.load(). */
export interface LoadArtifactOptions {
  /** Specific version to load. If omitted, loads latest. */
  version?: number
}

/** Result of a save operation. */
export interface SaveArtifactResult {
  /** The version number that was created. */
  version: number
  /** The MIME type that was stored (may be inferred). */
  mimeType: string
}

/**
 * Artifact storage backend interface.
 *
 * Implementations: - InMemoryArtifactService: For testing and development -
 * PostgresArtifactService: Production backend with raw SQL (no Drizzle)
 *
 * All implementations must pass runArtifactServiceTests().
 */
export interface ArtifactService {
  /**
   * Save artifact data. Creates a new immutable version.
   *
   * @param appName Application namespace
   * @param processId Process that owns this artifact
   * @param name Artifact name (unique within appName + processId)
   * @param data Content — string or Buffer
   * @param options MIME type and metadata
   * @returns Version number and final MIME type
   */
  save(
    appName: string,
    processId: string,
    name: string,
    data: Buffer | string,
    options?: SaveArtifactOptions,
  ): Promise<SaveArtifactResult>

  /**
   * Load artifact data.
   *
   * @param appName Application namespace
   * @param processId Process that owns this artifact
   * @param name Artifact name
   * @param options Optional version to load (defaults to latest)
   * @returns Artifact with data, or null if not found
   */
  load(
    appName: string,
    processId: string,
    name: string,
    options?: LoadArtifactOptions,
  ): Promise<Artifact | null>

  /**
   * List all artifacts for a process.
   *
   * @param appName Application namespace
   * @param processId Process to list artifacts for
   * @returns Array of artifact summaries (name, latest version, MIME type)
   */
  list(appName: string, processId: string): Promise<ArtifactSummary[]>

  /**
   * List all versions of an artifact.
   *
   * @param appName Application namespace
   * @param processId Process that owns this artifact
   * @param name Artifact name
   * @returns Array of version metadata, sorted by version descending
   */
  listVersions(appName: string, processId: string, name: string): Promise<ArtifactVersion[]>

  /**
   * Delete an artifact and all its versions.
   *
   * @param appName Application namespace
   * @param processId Process that owns this artifact
   * @param name Artifact name
   */
  delete(appName: string, processId: string, name: string): Promise<void>

  /** Close the service and release resources. */
  close(): Promise<void>
}

/**
 * Infer MIME type from data content.
 *
 * Rules:
 *
 * - String starting with '{' or '[' → application/json
 * - String starting with '#' or containing '\n#' → text/markdown
 * - Other string → text/plain
 * - Buffer → application/octet-stream (caller should provide explicit mimeType)
 */
export function inferMimeType(data: Buffer | string): string {
  if (Buffer.isBuffer(data)) {
    return 'application/octet-stream'
  }

  const trimmed = data.trim()

  // JSON detection
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'application/json'
    } catch {
      // Not valid JSON, continue to other checks
    }
  }

  // Markdown detection (starts with # or has markdown headers)
  if (trimmed.startsWith('#') || /\n#{1,6}\s/.test(data)) {
    return 'text/markdown'
  }

  return 'text/plain'
}
