import { randomUUID } from 'node:crypto';
import { CALL_ID_PREFIX, CALL_ID_LENGTH } from '../core/constants';
import type { Session, SessionService } from '../types';
import { InMemorySessionService } from './inMemory';

export {
  BaseSession,
  type BaseSessionOptions,
  type SpawnedTaskStatus,
} from './base';
export { InMemorySessionService } from './inMemory';
export { LocalSessionService } from './local';

export interface SessionOptions {
  id?: string;
  userId?: string;
  patientId?: string;
  practiceId?: string;
  sessionService?: SessionService;
}

export async function session(
  appName: string,
  options?: SessionOptions,
): Promise<Session> {
  const service = options?.sessionService ?? new InMemorySessionService();
  return service.createSession(appName, options);
}

export const createEventId = () => randomUUID();

export const createCallId = () =>
  `${CALL_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, CALL_ID_LENGTH)}`;

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
} from './resume';

export { computePipelineFingerprint } from './fingerprint';

export {
  snapshotAt,
  computeStateAtEvent,
  computeAllStatesAtEvent,
  findEventIndex,
  findInvocationBoundary,
  SnapshotError,
  type SessionSnapshot,
  type InvocationBoundary,
} from './snapshot';
