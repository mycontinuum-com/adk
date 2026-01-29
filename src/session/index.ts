import { randomUUID } from 'node:crypto';
import { CALL_ID_PREFIX, CALL_ID_LENGTH } from '../core/constants';

export {
  BaseSession,
  type BaseSessionOptions,
  type SpawnedTaskStatus,
} from './base';
export { InMemorySessionService } from './inMemory';
export { LocalSessionService } from './local';

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
