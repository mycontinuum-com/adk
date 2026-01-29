import type { Hooks, StreamEvent, Event, Session, Runnable } from '../types';
import type { Middleware, ComposedObservationHooks } from './types';

export function composeMiddleware(
  runnerMiddleware: readonly Middleware[],
  agentMiddleware: readonly Middleware[],
  agentHooks: Hooks | undefined,
): Hooks {
  const allMiddleware = [...runnerMiddleware, ...agentMiddleware];

  if (allMiddleware.length === 0 && !agentHooks) {
    return {};
  }

  return {
    beforeAgent: composeBeforeHook(
      allMiddleware.map((m) => m.beforeAgent),
      agentHooks?.beforeAgent,
    ),
    afterAgent: composeAfterHook(
      allMiddleware.map((m) => m.afterAgent),
      agentHooks?.afterAgent,
    ),
    beforeModel: composeBeforeHook(
      allMiddleware.map((m) => m.beforeModel),
      agentHooks?.beforeModel,
    ),
    afterModel: composeAfterHook(
      allMiddleware.map((m) => m.afterModel),
      agentHooks?.afterModel,
    ),
    beforeTool: composeBeforeHook(
      allMiddleware.map((m) => m.beforeTool),
      agentHooks?.beforeTool,
    ),
    afterTool: composeAfterHook(
      allMiddleware.map((m) => m.afterTool),
      agentHooks?.afterTool,
    ),
  };
}

export function composeObservationHooks(
  runnerMiddleware: readonly Middleware[],
  agentMiddleware: readonly Middleware[],
): ComposedObservationHooks {
  const allMiddleware = [...runnerMiddleware, ...agentMiddleware];

  const streamHooks = allMiddleware
    .map((m) => m.onStream)
    .filter((h): h is NonNullable<typeof h> => h != null);

  const stepHooks = allMiddleware
    .map((m) => m.onStep)
    .filter((h): h is NonNullable<typeof h> => h != null);

  return {
    onStream:
      streamHooks.length > 0
        ? (event: StreamEvent) => {
            for (const hook of streamHooks) {
              hook(event);
            }
          }
        : undefined,
    onStep:
      stepHooks.length > 0
        ? (stepEvents: Event[], session: Session, runnable: Runnable) => {
            for (const hook of stepHooks) {
              hook(stepEvents, session, runnable);
            }
          }
        : undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHook = ((...args: any[]) => any) | undefined;

function composeBeforeHook<T extends AnyHook>(
  middlewareHooks: (T | undefined)[],
  innerCallback: T | undefined,
): T | undefined {
  const hooks = middlewareHooks.filter((h): h is NonNullable<T> => h != null);

  if (hooks.length === 0 && !innerCallback) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (...args: any[]) => {
    for (const hook of hooks) {
      const result = await hook(...args);
      if (result !== undefined) return result;
    }
    if (innerCallback) {
      return await innerCallback(...args);
    }
  }) as T;
}

function composeAfterHook<T extends AnyHook>(
  middlewareHooks: (T | undefined)[],
  innerCallback: T | undefined,
): T | undefined {
  const hooks = middlewareHooks.filter((h): h is NonNullable<T> => h != null);

  if (hooks.length === 0 && !innerCallback) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (ctx: any, value: any) => {
    let result = value;

    if (innerCallback) {
      const modified = await innerCallback(ctx, result);
      if (modified !== undefined) result = modified;
    }

    for (let i = hooks.length - 1; i >= 0; i--) {
      const modified = await hooks[i](ctx, result);
      if (modified !== undefined) result = modified;
    }

    return result;
  }) as T;
}
