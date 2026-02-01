import type { StateAccessorWithScopes } from '../types';
import type { BaseSession } from '../session/base';

export function createStateAccessor(
  session: BaseSession,
  invocationId: string,
): StateAccessorWithScopes {
  if (!invocationId) {
    throw new Error(
      'invocationId is required to create a state accessor. ' +
        'This ensures proper attribution in concurrent multi-agent scenarios.',
    );
  }

  return session.boundState(invocationId);
}
