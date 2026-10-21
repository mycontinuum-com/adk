import type { ModelEndEvent, ModelStartEvent } from '../types/events'

/** Where a model call came from: a run's agent step, or `decide()`. */
export type ModelCallSource = 'run' | 'decision'

/** Receives the `model_start` and `model_end` events of every model call made in its scope. */
export type ModelCallObserver = (
  event: ModelStartEvent | ModelEndEvent,
  source: ModelCallSource,
) => void

/**
 * The async context that carries observers into the work started in a scope, such as Node's
 * `AsyncLocalStorage`. The core does not import one, so it stays usable in the browser.
 */
export interface ModelCallContext {
  getStore(): readonly ModelCallObserver[] | undefined
  run<R>(store: readonly ModelCallObserver[], fn: () => R): R
}

/**
 * Kept on `globalThis` because the CommonJS build bundles each entry point separately, so the
 * runner in one entry and the Live handler in another would otherwise hold different copies.
 */
const CONTEXT = Symbol.for('@animahealth/adk/model-call-context')
const holder = globalThis as { [CONTEXT]?: ModelCallContext }

/** Installs the async context. A Node entry point that observes model calls installs it once. */
export function installModelCallContext(next: ModelCallContext): void {
  holder[CONTEXT] ??= next
}

/**
 * Runs `fn` with `observer` receiving every model call that runs and decisions started inside it
 * make, including those of work it starts in turn. An observer already in scope is not added
 * twice.
 *
 * @throws When no async context is installed.
 */
export function observeModelCalls<R>(observer: ModelCallObserver, fn: () => R): R {
  const context = holder[CONTEXT]
  if (!context) throw new Error('No model call context is installed')
  const observers = context.getStore() ?? []
  return observers.includes(observer) ? fn() : context.run([...observers, observer], fn)
}

/** The observers of the current scope. A run or decision reads them once, when it starts. */
export function modelCallObservers(): readonly ModelCallObserver[] {
  return holder[CONTEXT]?.getStore() ?? []
}
