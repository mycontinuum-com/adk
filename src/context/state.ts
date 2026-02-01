import type { StateSchema, TypedState } from '../types/schema';
import type { BaseSession } from '../session/base';

export function createStateAccessor<S extends StateSchema = StateSchema>(
  session: BaseSession,
  invocationId: string,
): TypedState<S> {
  if (!invocationId) {
    throw new Error(
      'invocationId is required to create a state accessor. ' +
        'This ensures proper attribution in concurrent multi-agent scenarios.',
    );
  }

  return session.boundState<S>(invocationId);
}
