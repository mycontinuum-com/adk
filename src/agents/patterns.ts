import type { StateScope } from '../types/events'
import type { Runnable, StepContext, StepResult, Sequence } from '../types/runnables'
import type { Session } from '../types/session'

import { step, sequence } from './factory'

function getStateSetAt(session: Session, scope: StateScope, key: string): number | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (
      event.type === 'state_change' &&
      event.scope === scope &&
      (event.source === 'mutation' || event.source === 'direct') &&
      event.changes.some((c) => c.key === key)
    ) {
      return event.createdAt
    }
  }
  return undefined
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
  })
}

export interface CachedOptions {
  key: string
  scope?: StateScope
  ttlMs?: number
}

export function cached<T extends Runnable>(runnable: T, options: CachedOptions): Sequence {
  const scope = options.scope ?? 'session'

  return gated(runnable, (ctx) => {
    let value: unknown
    const state = ctx.state as Record<string, unknown> & {
      user: Record<string, unknown>
      patient: Record<string, unknown>
      practice: Record<string, unknown>
      temp: Record<string, unknown>
    }
    switch (scope) {
      case 'user':
        value = state.user[options.key]
        break
      case 'patient':
        value = state.patient[options.key]
        break
      case 'practice':
        value = state.practice[options.key]
        break
      case 'temp':
        value = state.temp[options.key]
        break
      default:
        value = state[options.key]
    }

    if (value === undefined) {
      return
    }

    if (options.ttlMs) {
      const setAt = getStateSetAt(ctx.session, scope, options.key)
      if (!setAt || Date.now() - setAt > options.ttlMs) {
        return
      }
    }

    ctx.skip()
  })
}
