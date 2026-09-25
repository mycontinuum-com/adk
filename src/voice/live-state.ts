import type { StateScope } from '../types/events'
import type { StateSchema } from '../types/schema'
import type { Session } from '../types/session'

function isCallScope(scope: StateScope, source: Session, target: Session): boolean {
  return scope === 'session' || (scope !== 'temp' && !source.scopes[scope] && !target.scopes[scope])
}

function writeState(
  target: Session,
  scope: Exclude<StateScope, 'temp'>,
  changes: Record<string, unknown>,
): void {
  const state = target.state
  const destination = scope === 'session' ? state : state[scope]
  destination.update(structuredClone(changes))
}

/**
 * Copies the call's current call-owned state into a fresh backend session. Scopes bound on either
 * session keep their own persistence and are not copied.
 */
export function seedLiveState<S extends StateSchema>(
  callSession: Session<S>,
  backendSession: Session<S>,
): void {
  const scopes = new Map<Exclude<StateScope, 'temp'>, Map<string, unknown>>()
  for (const event of callSession.events) {
    if (
      event.type !== 'state_change' ||
      event.scope === 'temp' ||
      !isCallScope(event.scope, callSession, backendSession)
    )
      continue
    const changes = scopes.get(event.scope) ?? new Map<string, unknown>()
    for (const change of event.changes) changes.set(change.key, change.newValue)
    scopes.set(event.scope, changes)
  }
  for (const [scope, changes] of scopes)
    writeState(backendSession, scope, Object.fromEntries(changes))
}

/**
 * Applies the backend's call-owned state changes after event index `since` to the call session.
 * Temporary state and observation-sourced changes are ignored.
 */
export function applyLiveState<S extends StateSchema>(
  backendSession: Session<S>,
  callSession: Session<S>,
  since: number,
): void {
  for (const event of backendSession.events.slice(since)) {
    if (
      event.type !== 'state_change' ||
      event.scope === 'temp' ||
      event.source === 'observation' ||
      !isCallScope(event.scope, backendSession, callSession)
    )
      continue
    writeState(
      callSession,
      event.scope,
      Object.fromEntries(event.changes.map((change) => [change.key, change.newValue])),
    )
  }
}
