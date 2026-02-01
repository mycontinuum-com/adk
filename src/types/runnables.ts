import type { z } from 'zod';
import type {
  Event,
  ToolCallEvent,
  ToolResultEvent,
  StreamEvent,
  ModelUsage,
  ModelEndEvent,
} from './events';
import type { Session, SessionService } from './session';
import type { StateSchema, TypedState } from './schema';
import type { RunResult, RunConfig } from './runtime';
import type { Middleware } from '../middleware/types';
import type { ErrorHandler } from '../errors/types';
import type { EventChannel } from '../channels';

export type RunnableKind = 'agent' | 'step' | 'sequence' | 'parallel' | 'loop';

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: (error: Error) => boolean;
}

interface BaseModelConfig {
  name: string;
  temperature?: number;
  maxTokens?: number;
}

export interface OpenAIModel extends BaseModelConfig {
  provider: 'openai';
  reasoning?: {
    effort: 'minimal' | 'low' | 'medium' | 'high';
    summary?: 'auto' | 'detailed';
  };
  retry?: RetryConfig;
}

export interface VertexAIConfig {
  project: string;
  location: string;
  credentials?: string;
}

export interface GeminiModel extends BaseModelConfig {
  provider: 'gemini';
  thinkingConfig?: {
    thinkingBudget?: number;
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
    includeThoughts?: boolean;
  };
  retry?: RetryConfig;
  vertex?: VertexAIConfig;
}

export interface ClaudeModel extends BaseModelConfig {
  provider: 'claude';
  thinking?: {
    budgetTokens?: number;
  };
  retry?: RetryConfig;
  vertex: VertexAIConfig;
}

export type ModelConfig = OpenAIModel | GeminiModel | ClaudeModel;

export type Provider = ModelConfig['provider'];

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface FunctionToolHookContext<
  TInput = unknown,
  TYield = unknown,
  TResult = unknown,
  S extends StateSchema = StateSchema,
> extends Omit<ToolContext<S>, 'args'> {
  readonly args: TInput;
  readonly input?: TYield;
  readonly result?: TResult;
}

export type ToolHookContext<
  TInput = unknown,
  TYield = unknown,
  TResult = unknown,
  S extends StateSchema = StateSchema,
> = FunctionToolHookContext<TInput, TYield, TResult, S>;

export interface FunctionTool<
  TInput = unknown,
  TOutput = unknown,
  TYield = unknown,
  S extends StateSchema = StateSchema,
> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  yieldSchema?: z.ZodType<TYield>;
  prepare?(
    ctx: FunctionToolHookContext<TInput, unknown, unknown, S>,
  ): TInput | void | Promise<TInput | void>;
  execute?(
    ctx: FunctionToolHookContext<TInput, TYield, unknown, S>,
  ): TOutput | Promise<TOutput>;
  finalize?(
    ctx: FunctionToolHookContext<TInput, TYield, TOutput, S>,
  ): TOutput | void | Promise<TOutput | void>;
  timeout?: number;
  retry?: RetryConfig;
}

export interface WebSearchTool {
  type: 'web_search';
  searchContextSize?: 'low' | 'medium' | 'high';
  userLocation?: {
    type: 'approximate';
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
}

export type ProviderTool = WebSearchTool;

export type Tool<S extends StateSchema = StateSchema> = FunctionTool<unknown, unknown, unknown, S> | ProviderTool;

export interface RenderContext<S extends StateSchema = StateSchema> {
  readonly invocationId: string;
  readonly agentName: string;
  readonly session: Session<S>;
  readonly state: TypedState<S>;
  readonly agent: Agent<unknown, S>;
  events: Event[];
  functionTools: FunctionTool<unknown, unknown, unknown, S>[];
  providerTools: ProviderTool[];
  outputSchema?: z.ZodType;
  outputMode?: OutputMode;
  toolChoice?: ToolChoice;
  allowedTools?: string[];
}

export type ContextRenderer<S extends StateSchema = StateSchema> = (ctx: RenderContext<S>) => RenderContext<S>;

export interface ModelStepResult {
  stepEvents: Event[];
  toolCalls: ToolCallEvent[];
  terminal: boolean;
  usage?: ModelUsage;
  finishReason?: ModelEndEvent['finishReason'];
}

export interface Hooks<S extends StateSchema = StateSchema> {
  beforeAgent?: (
    ctx: InvocationContext<S>,
  ) => string | Runnable | void | Promise<string | Runnable | void>;
  afterAgent?: (
    ctx: InvocationContext<S>,
    output: string,
  ) => string | void | Promise<string | void>;
  beforeModel?: (
    ctx: InvocationContext<S>,
    renderCtx: RenderContext<S>,
  ) =>
    | ModelStepResult
    | Runnable
    | void
    | Promise<ModelStepResult | Runnable | void>;
  afterModel?: (
    ctx: InvocationContext<S>,
    result: ModelStepResult,
  ) =>
    | ModelStepResult
    | Runnable
    | void
    | Promise<ModelStepResult | Runnable | void>;
  beforeTool?: (
    ctx: ToolContext<S>,
    call: ToolCallEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;
  afterTool?: (
    ctx: ToolContext<S>,
    result: ToolResultEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;
}

export type SessionKeyOf<S extends StateSchema> = S['session'] extends Record<string, z.ZodType>
  ? keyof S['session'] & string
  : string;

export interface OutputKeyConfig<S extends StateSchema = StateSchema> {
  key: SessionKeyOf<S>;
}

export type OutputMode = 'native' | 'prompt';

export interface OutputSchemaConfig<T = unknown, S extends StateSchema = StateSchema> {
  key?: SessionKeyOf<S>;
  schema: z.ZodType<T>;
  mode?: OutputMode;
}

export type OutputConfig<T = unknown, S extends StateSchema = StateSchema> = 
  | OutputKeyConfig<S> 
  | OutputSchemaConfig<T, S>;

interface RunnableBase {
  name: string;
  description?: string;
}

export interface Agent<TOutput = unknown, S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'agent';
  model: ModelConfig;
  context: ContextRenderer<S>[];
  tools: Tool<S>[];
  output?: OutputConfig<TOutput, S>;
  toolChoice?: ToolChoice;
  maxSteps?: number;
  hooks?: Hooks<S>;
  middleware?: Middleware<S>[];
  errorHandlers?: ErrorHandler[];
}

export interface Sequence<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'sequence';
  runnables: Runnable<S>[];
}

export interface ParallelMergeContext<S extends StateSchema = StateSchema> {
  results: RunResult[];
  session: Session<S>;
  state: TypedState<S>;
  successfulBranches: number[];
  failedBranches: Array<{ index: number; error: string }>;
}

export interface Parallel<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'parallel';
  runnables: Runnable<S>[];
  merge?: (ctx: ParallelMergeContext<S>) => Event[];
  failFast?: boolean;
  branchTimeout?: number;
  minSuccessful?: number;
}

export interface LoopContext<S extends StateSchema = StateSchema> {
  invocationId: string;
  session: Session<S>;
  state: TypedState<S>;
  iteration: number;
  lastResult: RunResult | null;
}

export interface Loop<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'loop';
  runnable: Runnable<S>;
  maxIterations: number;
  while: (ctx: LoopContext<S>) => boolean | Promise<boolean>;
  yields?: boolean;
}

export type StepSignal =
  | { signal: 'skip' }
  | { signal: 'respond'; text: string }
  | { signal: 'fail'; message: string }
  | { signal: 'complete'; value: unknown; key?: string };

export type StepResult<S extends StateSchema = StateSchema> = StepSignal | Runnable<S> | void;

export interface StepContext<S extends StateSchema = StateSchema>
  extends OrchestrationContext<S> {
  readonly invocationId: string;
  readonly session: Session<S>;
  readonly state: TypedState<S>;
  skip(): StepSignal;
  fail(message: string): StepSignal;
  respond(text: string): StepSignal;
  complete<T>(value: T, key?: SessionKeyOf<S>): StepSignal;
}

export interface Step<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'step';
  execute: (ctx: StepContext<S>) => StepResult<S> | Promise<StepResult<S>>;
}

export type Runnable<S extends StateSchema = StateSchema> = 
  | Agent<unknown, S> 
  | Step<S> 
  | Sequence<S> 
  | Parallel<S> 
  | Loop<S>;

export interface InvocationContext<S extends StateSchema = StateSchema>
  extends OrchestrationContext<S> {
  readonly invocationId: string;
  readonly parentInvocationId?: string;
  readonly runnable: Runnable<S>;
  readonly session: Session<S>;
  readonly sessionService: SessionService;
  readonly state: TypedState<S>;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: StreamEvent) => void;
  endInvocation: boolean;
}

export interface SubRunConfig {
  id?: string;
  managed?: boolean;
  handoffOrigin?: import('./events').HandoffOrigin;
}

export interface SubRunner<S extends StateSchema = StateSchema> {
  run(
    runnable: Runnable<S>,
    parentInvocationId?: string,
    config?: SubRunConfig,
  ): AsyncGenerator<StreamEvent, RunResult>;
  runToChannel?(
    runnable: Runnable<S>,
    session: Session<S>,
    channel: EventChannel,
    config?: RunConfig & SubRunConfig,
  ): Promise<RunResult>;
}

/**
 * Handle returned by ctx.spawn() for managing a spawned agent.
 */
export interface SpawnHandle<TOutput = unknown> {
  invocationId: string;
  agentName: string;
  /** Await the spawned agent's completion. Timeout applies if specified in spawn(). */
  wait(): Promise<{
    status: 'completed' | 'error' | 'aborted';
    output?: TOutput;
    error?: string;
  }>;
  /** Abort the spawned agent. */
  abort(): void;
}

/**
 * Handle returned by ctx.dispatch() for fire-and-forget agents.
 */
export interface DispatchHandle {
  invocationId: string;
  agentName: string;
}

export interface CallResultTransfer {
  agent: Runnable;
  message?: string;
}

/**
 * Result returned by ctx.call() after the called agent completes.
 */
export interface CallResult<TOutput = unknown> {
  status: 'completed' | 'error' | 'aborted' | 'max_steps' | 'transferred';
  /** Output from the agent. Structured if output schema configured, otherwise last assistant text. */
  output?: TOutput;
  /** Number of model steps executed. */
  iterations: number;
  /** Error message if status is 'error'. */
  error?: string;
  /** Transfer target if status is 'transferred'. */
  transfer?: CallResultTransfer;
}

export interface HandoffOptions {
  message?: string;
  tempState?: Record<string, unknown>;
}

export interface CallOptions extends HandoffOptions {
  timeout?: number;
}

export interface SpawnOptions extends HandoffOptions {
  timeout?: number;
}

export type DispatchOptions = HandoffOptions;

/**
 * Orchestration primitives for agent-to-agent communication.
 * Available on both InvocationContext (hooks/middleware) and ToolContext (tools).
 *
 * For transfers, return the target Runnable directly from a hook or tool:
 * - From beforeAgent/beforeModel/afterModel hooks: `return targetAgent;`
 * - From tool execute: `return targetAgent;`
 */
export interface OrchestrationContext<S extends StateSchema = StateSchema> {
  /**
   * Synchronously call a sub-agent and wait for its completion.
   * The called agent runs in the same process and shares the session.
   * Child inherits parent's temp state, merged with any provided tempState overrides.
   * @throws Error if the called agent yields (use yielding tools directly for HITL patterns)
   * @returns CallResult with the agent's output, response text, and status
   */
  call(agent: Runnable<S>, options?: CallOptions): Promise<CallResult>;

  /**
   * Spawn an agent to run in parallel (same process).
   * Returns immediately with a handle to await or abort the spawned agent.
   * Child inherits parent's temp state, merged with any provided tempState overrides.
   * Errors in spawned agents don't crash the parent; retrieve via handle.wait().
   */
  spawn(agent: Runnable<S>, options?: SpawnOptions): SpawnHandle;

  /**
   * Dispatch an agent as fire-and-forget (no waiting).
   * Returns immediately with a handle containing the invocation ID.
   * Child inherits parent's temp state, merged with any provided tempState overrides.
   * The dispatched agent runs independently; errors are logged but not retrievable.
   */
  dispatch(agent: Runnable<S>, options?: DispatchOptions): DispatchHandle;
}

export interface ToolContext<S extends StateSchema = StateSchema>
  extends InvocationContext<S> {
  readonly callId: ToolCallEvent['callId'];
  readonly toolName: ToolCallEvent['name'];
  readonly args: ToolCallEvent['args'];
  readonly subRunner?: SubRunner<S>;
}

export interface ModelAdapter {
  step(
    ctx: RenderContext,
    config: ModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult>;
}
