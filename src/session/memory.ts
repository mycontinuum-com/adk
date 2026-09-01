import type { Event } from '../types/events'
import type { SessionStore, StoredSession, CommitResult, ScopedStateChange } from '../types/session'

/** Create an in-memory session store. Sessions are lost when the process exits. */
export function inMemoryStore(): SessionStore {
  return new InMemoryStore()
}

/**
 * @deprecated Use `inMemoryStore()` instead. Will be removed from the public API in the next major
 *   version.
 */
export class InMemoryStore implements SessionStore {
  private sessions = new Map<string, StoredSession & { updatedAt: number }>()
  private events = new Map<string, Event[]>()
  private scopedState = new Map<string, Record<string, unknown>>()

  private key(appName: string, id: string): string {
    return `${appName}#${id}`
  }

  private scopeKey(appName: string, scope: string, scopeId: string): string {
    return `${appName}#${scope}:${scopeId}`
  }

  async load(
    appName: string,
    sessionId: string,
  ): Promise<{ session: StoredSession; events: Event[] } | null> {
    const k = this.key(appName, sessionId)
    const session = this.sessions.get(k)
    if (!session) return null
    return {
      session: structuredClone(session),
      events: structuredClone(this.events.get(k) ?? []),
    }
  }

  async commit(
    session: StoredSession,
    newEvents: Event[],
    expectedVersion: number,
    scopedChanges?: ScopedStateChange[],
  ): Promise<CommitResult> {
    const k = this.key(session.appName, session.id)
    const existing = this.sessions.get(k)

    if (existing && existing.version !== expectedVersion) {
      return { ok: false, conflict: true, currentVersion: existing.version }
    }

    if (!existing && expectedVersion > 0) {
      return { ok: false, conflict: true, currentVersion: 0 }
    }

    const newVersion = (existing?.version ?? 0) + 1
    this.sessions.set(k, {
      ...structuredClone(session),
      version: newVersion,
      updatedAt: Date.now(),
    })

    // Same dedup contract as the SQL stores: an event id already in the history is skipped, so a
    // re-delivered batch cannot double an event.
    const stored = this.events.get(k) ?? []
    const seen = new Set(stored.map((event) => event.id))
    for (const event of newEvents) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      stored.push(structuredClone(event))
    }
    this.events.set(k, stored)

    if (scopedChanges) {
      for (const { scope, scopeId, changes } of scopedChanges) {
        await this.saveScopedState(session.appName, scope, scopeId, changes)
      }
    }

    return { ok: true, version: newVersion }
  }

  async delete(appName: string, sessionId: string): Promise<void> {
    const k = this.key(appName, sessionId)
    this.sessions.delete(k)
    this.events.delete(k)
  }

  async loadScopedState(
    appName: string,
    scope: string,
    scopeId: string,
  ): Promise<Record<string, unknown>> {
    const state = this.scopedState.get(this.scopeKey(appName, scope, scopeId))
    return state ? structuredClone(state) : {}
  }

  async saveScopedState(
    appName: string,
    scope: string,
    scopeId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const k = this.scopeKey(appName, scope, scopeId)
    const existing = this.scopedState.get(k) ?? {}
    for (const [key, value] of Object.entries(state)) {
      if (value === undefined) {
        delete existing[key]
      } else {
        existing[key] = structuredClone(value)
      }
    }
    this.scopedState.set(k, existing)
  }

  async close(): Promise<void> {}

  async list(appName: string): Promise<Array<{ id: string; updatedAt: number }>> {
    const results: Array<{ id: string; updatedAt: number }> = []
    for (const session of this.sessions.values()) {
      if (session.appName === appName) {
        results.push({ id: session.id, updatedAt: session.updatedAt ?? session.createdAt })
      }
    }
    return results.toSorted((a, b) => b.updatedAt - a.updatedAt)
  }
}
