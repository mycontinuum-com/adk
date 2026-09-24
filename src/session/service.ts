import type { SharedScope, Event } from '../types/events'
import type {
  Session,
  SessionService,
  SessionStore,
  StoredSession,
  CommitResult,
  CreateSessionOptions,
  ScopedStateChange,
} from '../types/session'

import { normalizeSessionId } from '../core/constants'
import { ConflictError } from '../errors/types'
import { BaseSession } from './base'

interface ScopeBinding {
  id: string
  state: Record<string, unknown>
}

interface SessionMeta {
  bindings: Map<string, ScopeBinding>
  dirtyChanges: Map<string, Map<string, unknown>>
  eventCursor: number
  pendingCommit: Promise<void>
}

function sessionToStoredSession(session: Session): StoredSession {
  return {
    id: session.id,
    appName: session.appName,
    version: session.version ?? 0,
    scopes: { ...session.scopes },
    createdAt: session.createdAt,
  }
}

function collectScopedChanges(m: SessionMeta): ScopedStateChange[] | undefined {
  const result: ScopedStateChange[] = []
  for (const [scope, changesMap] of m.dirtyChanges) {
    const binding = m.bindings.get(scope)
    if (binding) {
      const changes: Record<string, unknown> = {}
      for (const [key, value] of changesMap) {
        changes[key] = value
      }
      result.push({ scope, scopeId: binding.id, changes })
    }
  }
  return result.length > 0 ? result : undefined
}

/**
 * ADK-owned orchestration layer. `appendEvent` buffers in-memory (never calls the store). At commit
 * time, `eventCursor` determines which events are new via `events.slice(cursor)`, and dirty scoped
 * state is collected into `ScopedStateChange[]` — callers never think about what's new or dirty.
 *
 * @deprecated Use `adk({ store })` instead — the app creates and exposes a session
 * service automatically via `app.sessions`. This factory remains available for
 * advanced use cases (custom runners, direct `turn()` calls).
 */
export function sessionService(store: SessionStore): SessionService {
  const meta = new WeakMap<Session, SessionMeta>()

  function getMeta(session: Session): SessionMeta {
    let m = meta.get(session)
    if (!m) {
      m = {
        bindings: new Map(),
        dirtyChanges: new Map(),
        eventCursor: 0,
        pendingCommit: Promise.resolve(),
      }
      meta.set(session, m)
    }
    return m
  }

  function bindScopeWithState(
    session: Session,
    scope: SharedScope,
    scopeId: string,
    state: Record<string, unknown>,
  ): void {
    const m = getMeta(session)
    m.bindings.set(scope, { id: scopeId, state })

    ;(session as BaseSession).bindSharedState(scope, state, (key: string, value: unknown) => {
      let changes = m.dirtyChanges.get(scope)
      if (!changes) {
        changes = new Map()
        m.dirtyChanges.set(scope, changes)
      }
      changes.set(key, value)
    })
  }

  async function loadAndBindScopes(
    session: Session,
    scopes: Partial<Record<string, string>>,
  ): Promise<void> {
    const entries = Object.entries(scopes).filter((e): e is [string, string] => !!e[1])
    if (entries.length === 0) return

    const loaded = await Promise.all(
      entries.map(([scope, id]) =>
        store.loadScopedState(session.appName, scope, id).then((state) => ({ scope, id, state })),
      ),
    )

    for (const { scope, id, state } of loaded) {
      bindScopeWithState(session, scope as SharedScope, id, state)
    }
  }

  function persist(
    session: Session,
    operation: { kind: 'commit'; expectedVersion?: number } | { kind: 'merge'; latest?: Session },
  ): Promise<CommitResult> {
    const m = getMeta(session)
    const pending = m.pendingCommit.then(async (): Promise<CommitResult> => {
      const endCursor = session.events.length
      const newEvents = session.events.slice(m.eventCursor, endCursor)
      const scopedChanges = collectScopedChanges(m)
      const dirtyChanges = m.dirtyChanges
      m.dirtyChanges = new Map()
      let committed = false
      try {
        let stored = sessionToStoredSession(session)
        if (operation.kind === 'merge') {
          if (operation.latest) {
            stored = sessionToStoredSession(operation.latest)
          } else {
            const reloaded = await store.load(session.appName, session.id)
            if (!reloaded) return { ok: false, conflict: true, currentVersion: 0 }
            stored = reloaded.session
          }
        }
        const expectedVersion =
          operation.kind === 'commit'
            ? (operation.expectedVersion ?? stored.version)
            : stored.version
        const result = await store.commit(stored, newEvents, expectedVersion, scopedChanges)
        if (!result.ok) return result
        ;(session as BaseSession).setVersion(result.version)
        m.eventCursor = endCursor
        committed = true
        return operation.kind === 'merge' ? { ...result, merged: true } : result
      } finally {
        if (!committed) {
          for (const [scope, changes] of dirtyChanges) {
            const current = m.dirtyChanges.get(scope)
            if (!current) {
              m.dirtyChanges.set(scope, changes)
              continue
            }
            for (const [key, value] of changes) {
              if (!current.has(key)) current.set(key, value)
            }
          }
        }
      }
    })
    m.pendingCommit = pending.then(
      () => {},
      () => {},
    )
    return pending
  }

  const service: SessionService = {
    async createSession(appName: string, options?: CreateSessionOptions): Promise<Session> {
      const session = new BaseSession(appName, {
        id: options?.sessionId,
        scopes: options?.scopes,
        version: options?.version,
      })

      await loadAndBindScopes(session, options?.scopes ?? {})

      const result = await store.commit(sessionToStoredSession(session), [], 0)
      if (!result.ok) {
        throw new ConflictError(session.id, result.currentVersion)
      }
      session.setVersion(result.version)

      const m = getMeta(session)
      m.eventCursor = 0

      return session
    },

    async getSession(appName: string, sessionId: string): Promise<Session | null> {
      const loaded = await store.load(appName, normalizeSessionId(sessionId))
      if (!loaded) return null

      const { session: stored, events } = loaded

      const session = BaseSession.fromSnapshot({
        id: stored.id,
        appName: stored.appName,
        version: stored.version,
        events,
        scopes: stored.scopes,
        createdAt: stored.createdAt,
      })

      await loadAndBindScopes(session, stored.scopes)

      const m = getMeta(session)
      m.eventCursor = events.length

      return session
    },

    async appendEvent(session: Session, event: Event): Promise<void> {
      ;(session as BaseSession).pushEvent(event)
    },

    async deleteSession(appName: string, sessionId: string): Promise<void> {
      await store.delete(appName, normalizeSessionId(sessionId))
    },

    commitSession(session: Session, expectedVersion?: number): Promise<CommitResult> {
      return persist(session, { kind: 'commit', expectedVersion })
    },

    mergeSession(session: Session, latest?: Session): Promise<CommitResult> {
      return persist(session, { kind: 'merge', latest })
    },

    async bindSessionScope(session: Session, scope: string, id: string): Promise<void> {
      const sharedScope = scope as SharedScope
      ;(session as BaseSession).scopes[sharedScope] = id
      const state = await store.loadScopedState(session.appName, sharedScope, id)
      bindScopeWithState(session, sharedScope, id, state)
    },

    async getScopedState(
      appName: string,
      scope: SharedScope,
      id: string,
    ): Promise<Record<string, unknown>> {
      return store.loadScopedState(appName, scope, id)
    },

    async setScopedState(
      appName: string,
      scope: SharedScope,
      id: string,
      state: Record<string, unknown>,
    ): Promise<void> {
      await store.saveScopedState(appName, scope, id, state)
    },

    listSessions(appName: string) {
      return store.list(appName)
    },
  }

  return service
}
