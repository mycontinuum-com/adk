import type { StreamEvent, Event, Session, Runnable } from '../types'
import type { Hook, TurnContext } from './types'

/**
 * Before hooks run outer-to-inner (first non-undefined return wins). After hooks run inner-to-outer
 * (each can modify the result). onEvent/onStep errors are caught — observation must not abort a
 * run. before/after errors propagate — interception is control flow.
 */
export function composeHooks(hooks: readonly Hook<any>[]): Hook<any> {
  if (hooks.length === 0) return {}

  const eventFns = hooks.map((h) => h.onEvent).filter(defined)
  const stepFns = hooks.map((h) => h.onStep).filter(defined)
  const afterTurnFns = hooks.map((h) => h.afterTurn).filter(defined)

  return {
    beforeAgent: composeBeforeHook(hooks.map((h) => h.beforeAgent)),
    afterAgent: composeAfterHook(hooks.map((h) => h.afterAgent)),
    beforeModel: composeBeforeHook(hooks.map((h) => h.beforeModel)),
    afterModel: composeAfterHook(hooks.map((h) => h.afterModel)),
    beforeTool: composeBeforeHook(hooks.map((h) => h.beforeTool)),
    afterTool: composeAfterHook(hooks.map((h) => h.afterTool)),
    onEvent:
      eventFns.length > 0
        ? (event: StreamEvent) => {
            for (const fn of eventFns) fn(event)
          }
        : undefined,
    onStep:
      stepFns.length > 0
        ? (stepEvents: Event[], session: Session<any>, runnable: Runnable<any>) => {
            for (const fn of stepFns) fn(stepEvents, session, runnable)
          }
        : undefined,
    afterTurn:
      afterTurnFns.length > 0
        ? async (ctx: TurnContext) => {
            for (const fn of afterTurnFns) await fn(ctx)
          }
        : undefined,
  }
}

function defined<T>(v: T | undefined | null): v is T {
  return v != null
}

type AnyHook = ((...args: any[]) => any) | undefined

function composeBeforeHook<T extends AnyHook>(hooks: (T | undefined)[]): T | undefined {
  const definedHooks = hooks.filter((h): h is NonNullable<T> => h != null)

  if (definedHooks.length === 0) return undefined

  return (async (...args: any[]) => {
    for (const hook of definedHooks) {
      const result = await hook(...args)
      if (result !== undefined) return result
    }
  }) as T
}

function composeAfterHook<T extends AnyHook>(hooks: (T | undefined)[]): T | undefined {
  const definedHooks = hooks.filter((h): h is NonNullable<T> => h != null)

  if (definedHooks.length === 0) return undefined

  return (async (ctx: any, value: any) => {
    let result = value

    for (let i = definedHooks.length - 1; i >= 0; i--) {
      const modified = await definedHooks[i](ctx, result)
      if (modified !== undefined) result = modified
    }

    return result
  }) as T
}
