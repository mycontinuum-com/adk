/**
 * InMemoryArtifactService — In-memory implementation of ArtifactService.
 *
 * For testing and development. Stores artifacts as versioned entries in a Map. All data is lost
 * when the process exits.
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

/** Internal storage structure for a single artifact version. */
interface StoredVersion {
  data: Buffer | string
  mimeType: string
  metadata: Record<string, unknown>
  createdAt: Date
}

/** Internal storage structure for an artifact with all its versions. */
interface StoredArtifact {
  /** Versions keyed by version number. */
  versions: Map<number, StoredVersion>
  /** Next version number to assign. */
  nextVersion: number
}

/** Composite key for artifact storage: appName + processId + name. */
function makeKey(appName: string, processId: string, name: string): string {
  return `${appName}:${processId}:${name}`
}

/** Deep clone a value to prevent mutation leakage. */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value) as T
  }
  return JSON.parse(JSON.stringify(value))
}

/**
 * In-memory implementation of ArtifactService.
 *
 * Thread-safe within a single Node.js process (JavaScript is single-threaded). Does not support
 * cross-process access or persistence.
 */
export class InMemoryArtifactService implements ArtifactService {
  private artifacts = new Map<string, StoredArtifact>()

  async save(
    appName: string,
    processId: string,
    name: string,
    data: Buffer | string,
    options?: SaveArtifactOptions,
  ): Promise<SaveArtifactResult> {
    const key = makeKey(appName, processId, name)

    let artifact = this.artifacts.get(key)
    if (!artifact) {
      artifact = {
        versions: new Map(),
        nextVersion: 0,
      }
      this.artifacts.set(key, artifact)
    }

    const version = artifact.nextVersion++
    const mimeType = options?.mimeType ?? inferMimeType(data)
    const metadata = deepClone(options?.metadata ?? {})

    // Clone data to prevent mutation
    const storedData = Buffer.isBuffer(data) ? Buffer.from(data) : data

    artifact.versions.set(version, {
      data: storedData,
      mimeType,
      metadata,
      createdAt: new Date(),
    })

    return { version, mimeType }
  }

  async load(
    appName: string,
    processId: string,
    name: string,
    options?: LoadArtifactOptions,
  ): Promise<Artifact | null> {
    const key = makeKey(appName, processId, name)
    const artifact = this.artifacts.get(key)

    if (!artifact || artifact.versions.size === 0) {
      return null
    }

    let targetVersion: number
    if (options?.version !== undefined) {
      targetVersion = options.version
    } else {
      // Get latest version (nextVersion - 1)
      targetVersion = artifact.nextVersion - 1
    }

    const stored = artifact.versions.get(targetVersion)
    if (!stored) {
      return null
    }

    // Clone data and metadata to prevent mutation
    return {
      data: Buffer.isBuffer(stored.data) ? Buffer.from(stored.data) : stored.data,
      mimeType: stored.mimeType,
      version: targetVersion,
      metadata: deepClone(stored.metadata),
      createdAt: new Date(stored.createdAt),
    }
  }

  async list(appName: string, processId: string): Promise<ArtifactSummary[]> {
    const prefix = `${appName}:${processId}:`
    const summaries: ArtifactSummary[] = []

    for (const [key, artifact] of this.artifacts) {
      if (key.startsWith(prefix) && artifact.versions.size > 0) {
        const name = key.slice(prefix.length)
        const latestVersion = artifact.nextVersion - 1
        const latest = artifact.versions.get(latestVersion)!

        summaries.push({
          name,
          latestVersion,
          mimeType: latest.mimeType,
          updatedAt: new Date(latest.createdAt),
        })
      }
    }

    // Sort by updatedAt descending (most recent first)
    summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())

    return summaries
  }

  async listVersions(appName: string, processId: string, name: string): Promise<ArtifactVersion[]> {
    const key = makeKey(appName, processId, name)
    const artifact = this.artifacts.get(key)

    if (!artifact) {
      return []
    }

    const versions: ArtifactVersion[] = []

    for (const [version, stored] of artifact.versions) {
      versions.push({
        version,
        mimeType: stored.mimeType,
        metadata: deepClone(stored.metadata),
        createdAt: new Date(stored.createdAt),
      })
    }

    // Sort by version descending (newest first)
    versions.sort((a, b) => b.version - a.version)

    return versions
  }

  async delete(appName: string, processId: string, name: string): Promise<void> {
    const key = makeKey(appName, processId, name)
    this.artifacts.delete(key)
  }

  async close(): Promise<void> {
    this.artifacts.clear()
  }

  /** Clear all artifacts (for testing). */
  clear(): void {
    this.artifacts.clear()
  }
}
