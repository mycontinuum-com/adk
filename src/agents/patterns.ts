import { step, sequence } from './factory';
import type {
  Runnable,
  StepContext,
  StepResult,
  Sequence,
  Session,
  StateScope,
  StateChangeEvent,
} from '../types';

function getStateSetAt(
  session: Session,
  scope: StateScope,
  key: string,
): number | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (
      event.type === 'state_change' &&
      event.scope === scope &&
      event.source === 'mutation' &&
      (event as StateChangeEvent).changes.some((c) => c.key === key)
    ) {
      return event.createdAt;
    }
  }
  return undefined;
}

export function gated<T extends Runnable>(
  runnable: T,
  check: (ctx: StepContext) => StepResult,
): Sequence {
  return sequence({
    name: runnable.name,
    description: runnable.description,
    runnables: [
      step({
        name: `${runnable.name}_gate`,
        execute: (ctx) => check(ctx) ?? runnable,
      }),
    ],
  });
}

export interface CachedOptions {
  key: string;
  scope?: StateScope;
  ttlMs?: number;
}

export function cached<T extends Runnable>(
  runnable: T,
  options: CachedOptions,
): Sequence {
  const scope = options.scope ?? 'session';

  return gated(runnable, (ctx) => {
    let stateScope;
    switch (scope) {
      case 'user':
        stateScope = ctx.state.user;
        break;
      case 'patient':
        stateScope = ctx.state.patient;
        break;
      case 'practice':
        stateScope = ctx.state.practice;
        break;
      case 'temp':
        stateScope = ctx.state.temp;
        break;
      default:
        stateScope = ctx.state;
    }

    const value = stateScope.get(options.key);

    if (value === undefined) {
      return;
    }

    if (options.ttlMs) {
      const setAt = getStateSetAt(ctx.session, scope, options.key);
      if (!setAt || Date.now() - setAt > options.ttlMs) {
        return;
      }
    }

    return ctx.complete(value, options.key);
  });
}
