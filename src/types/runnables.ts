import type { z } from 'zod';
import type {
  Event,
  ToolCallEvent,
  ToolResultEvent,
  StreamEvent,
  ModelUsage,
  ModelEndEvent,
} from './events';
import type {
  Session,
  SessionService,
  StateAccessorWithScopes,
} from './session';
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
> extends Omit<ToolContext, 'args'> {
  readonly args: TInput;
  readonly input?: TYield;
  readonly result?: TResult;
}

export type ToolHookContext<
  TInput = unknown,
  TYield = unknown,
  TResult = unknown,
> = FunctionToolHookContext<TInput, TYield, TResult>;

export interface FunctionTool<
  TInput = unknown,
  TOutput = unknown,
  TYield = unknown,
> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  yieldSchema?: z.ZodType<TYield>;
  prepare?(
    ctx: FunctionToolHookContext<TInput>,
  ): TInput | void | Promise<TInput | void>;
  execute?(
    ctx: FunctionToolHookContext<TInput, TYield>,
  ): TOutput | Promise<TOutput>;
  finalize?(
    ctx: FunctionToolHookContext<TInput, TYield, TOutput>,
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

export type Tool = FunctionTool | ProviderTool;

export interface RenderContext {
  readonly invocationId: string;
  readonly agentName: string;
  readonly session: Session;
  readonly state: StateAccessorWithScopes;
  readonly agent: Agent;
  events: Event[];
  functionTools: FunctionTool[];
  providerTools: ProviderTool[];
  outputSchema?: z.ZodType;
  outputMode?: OutputMode;
  toolChoice?: ToolChoice;
  allowedTools?: string[];
}

export type ContextRenderer = (ctx: RenderContext) => RenderContext;

export interface ModelStepResult {
  stepEvents: Event[];
  toolCalls: ToolCallEvent[];
  terminal: boolean;
  usage?: ModelUsage;
  finishReason?: ModelEndEvent['finishReason'];
}

export interface Hooks {
  beforeAgent?: (
    ctx: InvocationContext,
  ) => string | Runnable | void | Promise<string | Runnable | void>;
  afterAgent?: (
    ctx: InvocationContext,
    output: string,
  ) => string | void | Promise<string | void>;
  beforeModel?: (
    ctx: InvocationContext,
    renderCtx: RenderContext,
  ) =>
    | ModelStepResult
    | Runnable
    | void
    | Promise<ModelStepResult | Runnable | void>;
  afterModel?: (
    ctx: InvocationContext,
    result: ModelStepResult,
  ) =>
    | ModelStepResult
    | Runnable
    | void
    | Promise<ModelStepResult | Runnable | void>;
  beforeTool?: (
    ctx: ToolContext,
    call: ToolCallEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;
  afterTool?: (
    ctx: ToolContext,
    result: ToolResultEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;
}

export interface OutputKeyConfig {
  key: string;
}

export type OutputMode = 'native' | 'prompt';

export interface OutputSchemaConfig<T = unknown> {
  key?: string;
  schema: z.ZodType<T>;
  mode?: OutputMode;
}

export type OutputConfig<T = unknown> = OutputKeyConfig | OutputSchemaConfig<T>;

interface RunnableBase {
  name: string;
  description?: string;
}

export interface Agent<TOutput = unknown> extends RunnableBase {
  kind: 'agent';
  model: ModelConfig;
  context: ContextRenderer[];
  tools: Tool[];
  output?: OutputConfig<TOutput>;
  toolChoice?: ToolChoice;
  maxSteps?: number;
  hooks?: Hooks;
  middleware?: Middleware[];
  errorHandlers?: ErrorHandler[];
}

export interface Sequence extends RunnableBase {
  kind: 'sequence';
  runnables: Runnable[];
}

export interface ParallelMergeContext {
  results: RunResult[];
  session: Session;
  state: StateAccessorWithScopes;
  successfulBranches: number[];
  failedBranches: Array<{ index: number; error: string }>;
}

export interface Parallel extends RunnableBase {
  kind: 'parallel';
  runnables: Runnable[];
  merge?: (ctx: ParallelMergeContext) => Event[];
  failFast?: boolean;
  branchTimeout?: number;
  minSuccessful?: number;
}

export interface LoopContext {
  invocationId: string;
  session: Session;
  state: StateAccessorWithScopes;
  iteration: number;
  lastResult: RunResult | null;
}

export interface Loop extends RunnableBase {
  kind: 'loop';
  runnable: Runnable;
  maxIterations: number;
  while: (ctx: LoopContext) => boolean | Promise<boolean>;
  yields?: boolean;
}

export type StepSignal =
  | { signal: 'skip' }
  | { signal: 'respond'; text: string }
  | { signal: 'fail'; message: string }
  | { signal: 'complete'; value: unknown; key?: string };

export type StepResult = StepSignal | Runnable | void;

export interface StepContext extends OrchestrationContext {
  readonly invocationId: string;
  readonly session: Session;
  readonly state: StateAccessorWithScopes;
  skip(): StepSignal;
  fail(message: string): StepSignal;
  respond(text: string): StepSignal;
  complete<T>(value: T, key?: string): StepSignal;
}

export interface Step extends RunnableBase {
  kind: 'step';
  execute: (ctx: StepContext) => StepResult | Promise<StepResult>;
}

export type Runnable = Agent | Step | Sequence | Parallel | Loop;

export interface InvocationContext extends OrchestrationContext {
  readonly invocationId: string;
  readonly parentInvocationId?: string;
  readonly runnable: Runnable;
  readonly session: Session;
  readonly sessionService: SessionService;
  readonly state: StateAccessorWithScopes;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: StreamEvent) => void;
  endInvocation: boolean;
}

export interface SubRunConfig {
  id?: string;
  managed?: boolean;
  handoffOrigin?: import('./events').HandoffOrigin;
}

export interface SubRunner {
  run(
    runnable: Runnable,
    parentInvocationId?: string,
    config?: SubRunConfig,
  ): AsyncGenerator<StreamEvent, RunResult>;
  runToChannel?(
    runnable: Runnable,
    session: Session,
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
export interface OrchestrationContext {
  /**
   * Synchronously call a sub-agent and wait for its completion.
   * The called agent runs in the same process and shares the session.
   * Child inherits parent's temp state, merged with any provided tempState overrides.
   * @throws Error if the called agent yields (use yielding tools directly for HITL patterns)
   * @returns CallResult with the agent's output, response text, and status
   */
  call(agent: Runnable, options?: CallOptions): Promise<CallResult>;

  /**
   * Spawn an agent to run in parallel (same process).
   * Returns immediately with a handle to await or abort the spawned agent.
   * Child inherits parent's temp state, merged with any provided tempState overrides.
   * Errors in spawned agents don't crash the parent; retrieve via handle.wait().
   */
  spawn(agent: Runnable, options?: SpawnOptions): SpawnHandle;

  /**
   * Dispatch an agent as fire-and-forget (no waiting).
   * Returns immediately with a handle containing the invocation ID.
   * Child inherits parent's temp state, merged with any provided tempState overrides.
   * The dispatched agent runs independently; errors are logged but not retrievable.
   */
  dispatch(agent: Runnable, options?: DispatchOptions): DispatchHandle;
}

export interface ToolContext extends InvocationContext {
  readonly callId: ToolCallEvent['callId'];
  readonly toolName: ToolCallEvent['name'];
  readonly args: ToolCallEvent['args'];
  readonly subRunner?: SubRunner;
}

export interface ModelAdapter {
  step(
    ctx: RenderContext,
    config: ModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult>;
}
