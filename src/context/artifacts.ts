/**
 * Ctx.artifacts proxy for agent context.
 *
 * Provides ergonomic artifact access on RunContext:
 *
 * - Property access for read/write: ctx.artifacts.plan = { ... }
 * - Auto MIME type inference: string → markdown, object → JSON
 * - Escape-hatch methods: .save() for versioning/metadata/binary, .load() for specific versions
 * - Every write emits an artifact_update event and persists via ArtifactService
 *
 * Designed for agents running within the gateway. Coding agents (Claude Code, etc.) interact with
 * artifacts through the filesystem, not this proxy.
 */

import type {
  ArtifactService,
  ArtifactSummary,
  SaveArtifactOptions,
  LoadArtifactOptions,
} from '../artifacts/types'
import type { ArtifactUpdateEvent } from '../types/events'

import { inferMimeType } from '../artifacts/types'

// Re-export for convenience
export type {
  SaveArtifactOptions as ArtifactSaveOptions,
  LoadArtifactOptions as ArtifactLoadOptions,
}

/**
 * The proxy interface exposed on ctx.artifacts.
 *
 * Supports both property access and method calls:
 *
 * ```typescript
 * // Property access (common case)
 * ctx.artifacts.plan = { goal: 'Fix login', steps: [...] };  // auto JSON
 * ctx.artifacts.decisions = '# Decisions\n\n- Use context API'; // auto markdown
 * const plan = ctx.artifacts.plan;  // read latest
 *
 * // Method access (versioning, metadata, binary)
 * const v = ctx.artifacts.save('plan', data, { metadata: { status: 'final' } });
 * const old = ctx.artifacts.load('plan', { version: 0 });
 * ctx.artifacts.save('screenshot', pngBuffer, { mimeType: 'image/png' });
 * const names = await ctx.artifacts.list();
 * ```
 */
export interface ArtifactsProxy {
  /** Save artifact with explicit options. Use for versioning, metadata, or binary payloads. */
  save(name: string, data: unknown, options?: SaveArtifactOptions): Promise<number>

  /** Load artifact, optionally at a specific version. */
  load(name: string, options?: LoadArtifactOptions): Promise<unknown>

  /** List all artifact names for the current process. */
  list(): Promise<ArtifactSummary[]>

  /**
   * Property access for reading/writing artifacts. Writes are saved immediately and emit
   * artifact_update events.
   */
  [name: string]: unknown
}

/** Event emitter callback for artifact updates. */
export type ArtifactEventEmitter = (event: ArtifactUpdateEvent) => void

/** Configuration for creating an artifacts proxy. */
export interface ArtifactsProxyConfig {
  /** The artifact storage service. */
  service: ArtifactService
  /** Application namespace. */
  appName: string
  /** Process ID that owns these artifacts. */
  processId: string
  /** Callback to emit artifact_update events. */
  emitEvent: ArtifactEventEmitter
}

/** Local cache entry for loaded artifacts. */
interface CacheEntry {
  data: unknown
}

function generateEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/** Serialize data for storage. - Objects/arrays → JSON string - Strings → as-is - Buffers → as-is */
function serializeData(data: unknown): Buffer | string {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (typeof data === 'string') {
    return data
  }
  // Serialize objects/arrays to JSON
  return JSON.stringify(data, null, 2)
}

/**
 * Deserialize data from storage. - JSON strings → parsed object - Other strings → as-is - Buffers →
 * as-is
 */
function deserializeData(data: Buffer | string, mimeType: string): unknown {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (mimeType === 'application/json') {
    try {
      return JSON.parse(data)
    } catch {
      return data
    }
  }
  return data
}

/**
 * Create an artifacts proxy for agent context.
 *
 * The proxy intercepts property access to provide seamless artifact read/write: - Get: loads from
 * cache or service - Set: saves to service and emits event
 *
 * Methods (save, load, list) are bound to the instance.
 */
export function createArtifactsProxy(config: ArtifactsProxyConfig): ArtifactsProxy {
  const { service, appName, processId, emitEvent } = config

  // Local cache for loaded artifacts (avoids repeated loads within a turn)
  const cache = new Map<string, CacheEntry>()

  async function save(name: string, data: unknown, options?: SaveArtifactOptions): Promise<number> {
    const serialized = serializeData(data)
    const mimeType = options?.mimeType ?? inferMimeType(serialized)

    const result = await service.save(appName, processId, name, serialized, {
      mimeType,
      metadata: options?.metadata,
    })

    cache.set(name, { data })

    emitEvent({
      type: 'artifact_update',
      id: generateEventId(),
      createdAt: Date.now(),
      name,
      version: result.version,
      mimeType: result.mimeType,
      processId,
    })

    return result.version
  }

  async function load(name: string, options?: LoadArtifactOptions): Promise<unknown> {
    // Check cache for latest version (no specific version requested)
    if (options?.version === undefined) {
      const cached = cache.get(name)
      if (cached) return cached.data
    }

    const artifact = await service.load(appName, processId, name, options)
    if (!artifact) return undefined

    const deserialized = deserializeData(artifact.data, artifact.mimeType)

    // Update cache if loading latest
    if (options?.version === undefined) {
      cache.set(name, { data: deserialized })
    }

    return deserialized
  }

  async function list(): Promise<ArtifactSummary[]> {
    return service.list(appName, processId)
  }

  const reservedNames = new Set(['save', 'load', 'list', 'then', 'catch', 'finally'])

  return new Proxy({ save, load, list } as ArtifactsProxy, {
    get(obj, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'save') return save
      if (prop === 'load') return load
      if (prop === 'list') return list
      if (reservedNames.has(prop)) return undefined
      return cache.get(prop)?.data
    },

    set(obj, prop: string | symbol, value: unknown) {
      if (typeof prop === 'symbol') return false
      if (reservedNames.has(prop)) return false
      save(prop, value) // Fire and forget
      return true
    },
  })
}

function warnArtifactsUnavailable(): void {
  console.warn('ctx.artifacts is not available in this context')
}

/**
 * Create a no-op artifacts proxy for contexts without artifact support. All operations are no-ops
 * that warn but don't fail.
 */
export function createNoopArtifactsProxy(): ArtifactsProxy {
  return new Proxy(
    {
      save: async () => {
        warnArtifactsUnavailable()
        return -1
      },
      load: async () => {
        warnArtifactsUnavailable()
        return undefined
      },
      list: async () => {
        warnArtifactsUnavailable()
        return []
      },
    } as ArtifactsProxy,
    {
      get(obj, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'save' || prop === 'load' || prop === 'list') {
          return (obj as any)[prop]
        }
        return undefined
      },
      set() {
        warnArtifactsUnavailable()
        return true
      },
    },
  )
}
