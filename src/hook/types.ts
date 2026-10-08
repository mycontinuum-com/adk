import type {
  InvocationContext,
  ToolContext,
  RenderContext,
  ModelStepResult,
  ToolCallEvent,
  ToolResultEvent,
  StreamEvent,
  Event,
  Session,
  Runnable,
  StateSchema,
  TypedState,
} from '../types'
import type { RunResult } from '../types/runtime'

export interface TurnContext<S extends StateSchema = StateSchema> {
  readonly session: Session<S>
  readonly state: TypedState<S>
  readonly result: RunResult
  readonly runnable: Runnable<S>
}

/**
 * Unified lifecycle hook for observation and interception. Named "Hook" (not "Middleware" or
 * "Plugin"): middleware implies request/response pipelines, plugin implies heavyweight lifecycle. A
 * single interface (not split Observer + Interceptor) because cross-cutting concerns like rate
 * limiters need both observation and interception co-located.
 */
export interface Hook<S extends StateSchema = StateSchema> {
  name?: string

  onEvent?: (event: StreamEvent) => void

  onStep?: (stepEvents: Event[], session: Session<S>, runnable: Runnable<S>) => void

  beforeAgent?: (
    ctx: InvocationContext<S>,
  ) => string | Runnable<any> | void | Promise<string | Runnable<any> | void>

  afterAgent?: (
    ctx: InvocationContext<S>,
    output: unknown,
  ) => unknown | void | Promise<unknown | void>

  /**
   * BeforeModel/afterModel support returning a Runnable to redirect execution (hook-level
   * transfer). Enables context-aware routing and result-based escalation. beforeTool/afterTool
   * intentionally do not — tool-level transfers have no clear semantic.
   */
  beforeModel?: (
    ctx: InvocationContext<S>,
    renderCtx: RenderContext<S>,
  ) => ModelStepResult | Runnable<any> | void | Promise<ModelStepResult | Runnable<any> | void>

  /**
   * Runs while the model call is in flight, for an answer that takes time to work out. A step
   * returned before the model's step completes cancels the model call and replaces it, as a
   * `beforeModel` step would. Otherwise the model's step stands: when the hook returns nothing,
   * rejects, or is still pending as the model finishes. The model's stream is held until the hook
   * settles or the model's step completes. Only the first model attempt of a step is raced.
   *
   * `signal` aborts once the hook's answer can no longer be used: the model's step completed or
   * failed first, or the caller aborted. Pass it to the work the hook waits on.
   */
  duringModel?: (
    ctx: InvocationContext<S>,
    renderCtx: RenderContext<S>,
    signal: AbortSignal,
  ) => Promise<ModelStepResult | void>

  afterModel?: (
    ctx: InvocationContext<S>,
    result: ModelStepResult,
  ) => ModelStepResult | Runnable<any> | void | Promise<ModelStepResult | Runnable<any> | void>

  beforeTool?: (
    ctx: ToolContext<S>,
    call: ToolCallEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>

  afterTool?: (
    ctx: ToolContext<S>,
    result: ToolResultEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>

  /**
   * Runs within the handler.turn commit boundary — after the run completes but before
   * commitSession. State mutations made here are included in the commit atomically. Only fires when
   * using handler.turn (or handlers that delegate to it: rest, agui). Ignored when using app.run()
   * directly.
   */
  afterTurn?: (ctx: TurnContext<S>) => void | Promise<void>
}
