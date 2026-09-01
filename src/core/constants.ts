import { randomUUID } from 'node:crypto'

export const CALL_ID_PREFIX = 'call_'
export const CALL_ID_LENGTH = 24
export const INVOCATION_ID_PREFIX = 'inv_'
export const INVOCATION_ID_LENGTH = 16
export const SESSION_ID_PREFIX = 'session_'
export const EVENT_ID_PREFIX = 'event_'
export const DEFAULT_MAX_STEPS = 25
export const MAX_TOOL_RETRY_ATTEMPTS = 10

export function normalizeId(prefix: string, id: string): string {
  const bare = id.startsWith(prefix) ? id.slice(prefix.length) : id
  return `${prefix}${bare}`
}

export function normalizeSessionId(id: string): string {
  return normalizeId(SESSION_ID_PREFIX, id)
}

export function createSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID()}`
}

export function createEventId(): string {
  return `${EVENT_ID_PREFIX}${randomUUID()}`
}
