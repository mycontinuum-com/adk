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
