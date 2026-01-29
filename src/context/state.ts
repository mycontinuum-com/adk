import type { Session, StateAccessorWithScopes } from '../types';

export function createStateAccessor(
  session: Session,
  invocationId: string,
): StateAccessorWithScopes {
  if (!invocationId) {
    throw new Error(
      'invocationId is required to create a state accessor. ' +
        'This ensures proper attribution in concurrent multi-agent scenarios.',
    );
  }

  return session.createBoundState(invocationId);
}

/** @deprecated Use createStateAccessor(session, invocationId) instead */
export const createBoundStateAccessor = createStateAccessor;
