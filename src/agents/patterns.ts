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
      (event.source === 'mutation' || event.source === 'direct') &&
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
    let value: unknown;
    switch (scope) {
      case 'user':
        value = ctx.state.user[options.key];
        break;
      case 'patient':
        value = ctx.state.patient[options.key];
        break;
      case 'practice':
        value = ctx.state.practice[options.key];
        break;
      case 'temp':
        value = ctx.state.temp[options.key];
        break;
      default:
        value = ctx.state[options.key];
    }

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
