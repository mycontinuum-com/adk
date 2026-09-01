import { randomUUID } from 'node:crypto'

import type { SharedScope } from '../types/events'
import type { Session, SessionService } from '../types/session'

import { CALL_ID_PREFIX, CALL_ID_LENGTH, createEventId } from '../core/constants'
import { InMemoryStore } from './memory'
import { sessionService } from './service'

export { BaseSession, type BaseSessionOptions } from './base'

export interface SessionOptions {
  id?: string
  scopes?: Partial<Record<SharedScope, string>>
  sessionService?: SessionService
}

export async function session(appName: string, options?: SessionOptions): Promise<Session> {
  const service = options?.sessionService ?? sessionService(new InMemoryStore())
  return service.createSession(appName, {
    sessionId: options?.id,
    scopes: options?.scopes,
  })
}

export { createEventId }

export const createCallId = () =>
  `${CALL_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, CALL_ID_LENGTH)}`

export {
  buildInvocationTree,
  computeResumeContext,
  validateResumeState,
  assertReadyToResume,
  findYieldedNodes,
  findNode,
  getNodePath,
  hasUnresolvedYields,
  getUnresolvedYields,
  InvocationTreeError,
  type InvocationNode,
  type InvocationState,
  type RunnableResumeContext,
} from './resume'

export { computePipelineFingerprint } from './fingerprint'

export { seedState, type StateChanges } from './seedState'

export {
  snapshotAt,
  computeStateAtEvent,
  computeAllStatesAtEvent,
  findEventIndex,
  findInvocationBoundary,
  SnapshotError,
  type SessionSnapshot,
  type InvocationBoundary,
} from './snapshot'
