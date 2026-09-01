import type { z } from 'zod'

import type { EventChannel } from '../channels'
import type { OutputSignal, EndSignal } from '../core/tools'
import type { ErrorHandler } from '../errors/types'
import type { Hook } from '../hook/types'
import type { Event, ToolCallEvent, StreamEvent, ModelUsage, ModelEndEvent } from './events'
import type { RunResult, RunConfig, Output } from './runtime'
import type { ErasedStateSchema, StateSchema, TypedState } from './schema'
import type { Session, SessionService, MessageInput } from './session'

export type RunnableKind = 'agent' | 'step' | 'sequence' | 'parallel' | 'loop'

export interface RetryConfig {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  retryableErrors?: (error: Error) => boolean
}

interface BaseModelConfig {
  name: string
  temperature?: number
  maxTokens?: number
}

export interface TurnDetectionConfig {
  /**
   * 'server_vad' (default) uses the provider's server-side VAD. 'semantic' uses semantic turn
   * detection (OpenAI only).
   */
  type?: 'server_vad' | 'semantic'
  /** VAD activation threshold (0-1). Lower = more sensitive. Provider default if omitted. */
  threshold?: number
  /** Milliseconds of silence before the model considers the user's turn complete. */
  silenceDurationMs?: number
  /** Milliseconds of speech before VAD activates. */
  prefixPaddingMs?: number
}

export interface InputTranscriptionConfig {
  /** Transcription model (e.g. 'whisper-1', 'gpt-4o-mini-transcribe'). */
  model: string
  /** Optional prompt to guide transcription (e.g. language hints, domain vocabulary). */
  prompt?: string
}

export interface NoiseReductionConfig {
  /** 'near_field' for close-mic/phone, 'far_field' for speakerphone/room audio. */
  type: 'near_field' | 'far_field'
}

export interface OpenAIModel extends BaseModelConfig {
  provider: 'openai'
  reasoning?: {
    effort: 'minimal' | 'low' | 'medium' | 'high'
    summary?: 'auto' | 'detailed'
  }
  /** Explicit prompt caching for tagged context messages. */
  promptCache?: {
    /** Stable routing key, limited by OpenAI to 64 characters. */
    key: string
    /** Only explicit breakpoints are supported. */
    mode: 'explicit'
    /** Sliding retention window, refreshed on cache reuse. */
    ttl: '30m'
  }
  retry?: RetryConfig
}

export interface VertexAIConfig {
  project: string
  location: string
  credentials?: string
}

export interface GeminiModel extends BaseModelConfig {
  provider: 'gemini'
  thinkingConfig?: {
    thinkingBudget?: number
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
    includeThoughts?: boolean
  }
  retry?: RetryConfig
  vertex?: VertexAIConfig
}

export interface ClaudeModel extends BaseModelConfig {
  provider: 'claude'
  thinking?: {
    budgetTokens?: number
  }
  /**
   * Vertex Claude prompt caching configuration.
   *
   * Vertex supports Anthropic prompt caching via `cache_control` blocks, with TTL defaulting to 5
   * minutes and optionally extended to 1 hour for supported models.
   */
  promptCache?: {
    /**
     * Enable prompt caching. Defaults to true for Vertex Claude models. Set to false to fully
     * disable emitting `cache_control`.
     */
    enabled?: boolean
    /**
     * Cache TTL. Vertex supports `5m` (default) and `1h` (for supported models). Note: `1h` cache
     * writes are more expensive than `5m` cache writes.
     */
    ttl?: '5m' | '1h'
    /**
     * Which system blocks should be marked cacheable. - `all`: mark all system messages as
     * cacheable (default) - `tagged`: only cache system messages tagged via providerContext
     */
    system?: 'all' | 'tagged'
  }
  retry?: RetryConfig
  vertex: VertexAIConfig
}

/** Non-realtime provider model configs. */
export type ProviderModelConfig = OpenAIModel | GeminiModel | ClaudeModel

/** Unified wrapper for realtime (voice-capable) model configs. */
export interface RealtimeModelConfig {
  realtime: true
  /**
   * Model name, derived from the inner provider model. Populated automatically by the `realtime()`
   * / `openai.realtime()` / `gemini.realtime()` factories.
   */
  name: string
  /** The inner provider model (OpenAI, Gemini, etc.). */
  model: ProviderModelConfig
  /** Voice output configuration — only applies in audio mode. */
  voice?: string
  /** VAD and turn detection — passthrough to the realtime model provider. */
  turnDetection?: TurnDetectionConfig
  /**
   * Input audio transcription model and prompt. Produces text transcripts of user speech. OpenAI
   * only.
   */
  inputTranscription?: InputTranscriptionConfig
  /** Input audio noise reduction. OpenAI only. */
  noiseReduction?: NoiseReductionConfig
  /** LiveKit STT plugin instance — typed as unknown in core, concrete in voice/. */
  stt?: unknown
  /** LiveKit TTS plugin instance — typed as unknown in core, concrete in voice/. */
  tts?: unknown
  /** Provider-specific options passed directly to the LiveKit model constructor. */
  providerOptions?: Record<string, unknown>
}

export type ModelConfig = ProviderModelConfig | RealtimeModelConfig

export type Provider = ProviderModelConfig['provider']

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface ToolExecutionContext<
  TInput = unknown,
  TYield = unknown,
  TResult = unknown,
  S extends StateSchema = StateSchema,
> {
  readonly invocationId: string
  readonly parentInvocationId?: string
  readonly runnable: Runnable<S>
  readonly session: Session<S>
  readonly state: TypedState<S>
  readonly signal?: AbortSignal
  readonly callId: string
  readonly toolName: string
  readonly args: TInput
  readonly input?: TYield
  readonly result?: TResult
  /** Voice session for audio-mode capabilities. `undefined` in text mode. */
  readonly voice?: import('../voice/types').VoiceSession
  readonly waitForPlayout?: () => Promise<void>
  /** End the invocation with an explicit output value. The value becomes RunResult.output.value. */
  output<V = unknown>(value: V): OutputSignal
  /**
   * End the session by triggering the agent's output tool via the model. Return this from your
   * tool's execute: `return ctx.end()`. Requires voice mode with an `output` tool configured on the
   * agent.
   */
  end(): EndSignal
  run<TOut>(
    agent: Agent<S, TOut>,
    inputOrOptions?: string | HandoffOptions,
  ): Promise<SubRunResult<TOut>>
  run(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): Promise<SubRunResult>
  /** @deprecated Renamed to `run` in 0.5.1. Will be removed in 0.6.0. */
  call<TOut>(
    agent: Agent<S, TOut>,
    inputOrOptions?: string | HandoffOptions,
  ): Promise<SubRunResult<TOut>>
  /** @deprecated Renamed to `run` in 0.5.1. Will be removed in 0.6.0. */
  call(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): Promise<SubRunResult>
  spawn<TOut>(agent: Agent<S, TOut>, inputOrOptions?: string | HandoffOptions): SpawnHandle<TOut>
  spawn(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): SpawnHandle
  dispatch(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): DispatchHandle
}

export interface FunctionTool<
  TInput = unknown,
  TOutput = unknown,
  TYield = unknown,
  S extends StateSchema = StateSchema,
> {
  name: string
  description: string
  schema: z.ZodType<TInput>
  yieldSchema?: z.ZodType<TYield>
  prepare?(
    ctx: ToolExecutionContext<TInput, unknown, unknown, S>,
  ): TInput | void | Promise<TInput | void>
  execute?(ctx: ToolExecutionContext<TInput, TYield, unknown, S>): TOutput | Promise<TOutput>
  finalize?(
    ctx: ToolExecutionContext<TInput, TYield, TOutput, S>,
  ): TOutput | void | Promise<TOutput | void>
  timeout?: number
  retry?: RetryConfig
}

export interface WebSearchTool {
  type: 'web_search'
  searchContextSize?: 'low' | 'medium' | 'high'
  userLocation?: {
    type: 'approximate'
    country?: string
    city?: string
    region?: string
    timezone?: string
  }
}

export type ProviderTool = WebSearchTool

export interface MCPTool {
  readonly kind: 'mcp_server'
  readonly name: string
  tools(): Promise<FunctionTool<unknown, unknown, unknown, StateSchema>[]>
}

export type Tool<S extends StateSchema = StateSchema> =
  | FunctionTool<unknown, unknown, unknown, S>
  | ProviderTool
  | MCPTool

export interface RenderContext<S extends StateSchema = StateSchema> {
  readonly invocationId: string
  readonly agentName: string
  readonly session: Session<S>
  readonly state: TypedState<S>
  readonly agent: Agent<S>
  readonly events: readonly Event[]
  readonly functionTools: readonly FunctionTool<unknown, unknown, unknown, S>[]
  readonly providerTools: readonly ProviderTool[]
  readonly outputSchema?: z.ZodType
  readonly outputMode?: OutputMode
  readonly toolChoice?: ToolChoice
  readonly allowedTools?: readonly string[]
}

export type SyncContextRenderer<S extends StateSchema = StateSchema> = (
  ctx: RenderContext<S>,
) => RenderContext<S>

export type ContextRenderer<S extends StateSchema = StateSchema> = (
  ctx: RenderContext<S>,
) => RenderContext<S> | Promise<RenderContext<S>>

export interface ModelStepResult {
  stepEvents: Event[]
  toolCalls: ToolCallEvent[]
  terminal: boolean
  usage?: ModelUsage
  finishReason?: ModelEndEvent['finishReason']
}

export type { Hook, TurnContext } from '../hook/types'

export type SessionKeyOf<S extends StateSchema> =
  S['session'] extends Record<string, z.ZodType> ? keyof S['session'] & string : string

export interface OutputKeyConfig<S extends StateSchema = StateSchema> {
  key: SessionKeyOf<S>
}

export type OutputMode = 'native' | 'prompt'

export interface OutputSchemaConfig<S extends StateSchema = StateSchema, T = unknown> {
  key?: SessionKeyOf<S>
  schema: z.ZodType<T>
  mode?: OutputMode
}

export type OutputConfig<S extends StateSchema = StateSchema, T = unknown> =
  | OutputKeyConfig<S>
  | OutputSchemaConfig<S, T>
  | FunctionTool<T, unknown, unknown, S>

interface RunnableBase {
  name: string
  description?: string
}

export interface AgentTimeouts {
  /** End the session if no user speech (audio mode) or no user input (text mode) for this duration. */
  inactivity?: number
  /** Hard limit on total session duration. Enforced in both modes. */
  expiry?: number
  /** @deprecated Use `expiry` instead. Will be removed in 0.7.0. */
  maxDuration?: number
}

export interface Agent<
  S extends StateSchema = StateSchema,
  TOutput = unknown,
> extends RunnableBase {
  kind: 'agent'
  model: ModelConfig
  context: ContextRenderer<S>[]
  tools: Tool<S>[]
  output?: OutputConfig<S, TOutput>
  toolChoice?: ToolChoice
  maxSteps?: number
  hooks?: Hook<S>[]
  errorHandlers?: ErrorHandler[]
  /**
   * After terminal model output, yield for user input instead of completing. Defaults to true for
   * realtime models.
   */
  yields?: boolean
  /** Safety cap on yield/resume cycles (default: 100). */
  maxTurns?: number
  /** Timeout configuration for inactivity and max duration. */
  timeouts?: AgentTimeouts
}

export interface Sequence<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'sequence'
  runnables: Runnable<S>[]
}

export interface ParallelMergeContext<S extends StateSchema = StateSchema> {
  results: RunResult[]
  session: Session<S>
  state: TypedState<S>
  successfulBranches: number[]
  failedBranches: Array<{ index: number; error: string }>
}

export interface Parallel<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'parallel'
  runnables: Runnable<S>[]
  merge?: (ctx: ParallelMergeContext<S>) => Event[]
  failFast?: boolean
  branchTimeout?: number
  minSuccessful?: number
}

export interface LoopContext<S extends StateSchema = StateSchema> {
  invocationId: string
  session: Session<S>
  state: TypedState<S>
  iteration: number
  lastResult: RunResult | null
}

export interface Loop<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'loop'
  runnable: Runnable<S>
  maxIterations: number
  while: (ctx: LoopContext<S>) => boolean | Promise<boolean>
  yields?: boolean
}

export type StepSignal =
  | { signal: 'skip' }
  | { signal: 'respond'; text: string }
  | { signal: 'fail'; message: string }

export type StepResult<S extends StateSchema = StateSchema> = Runnable<S> | void

export interface StepContext<S extends StateSchema = StateSchema> extends OrchestrationContext<S> {
  readonly invocationId: string
  readonly session: Session<S>
  readonly state: TypedState<S>
  skip(): never
  fail(message: string): never
  respond(text: string): never
  /** Set the step's output value. The value becomes RunResult.output.value. */
  output<V = unknown>(value: V): void
}

export interface Step<S extends StateSchema = StateSchema> extends RunnableBase {
  kind: 'step'
  execute: (ctx: StepContext<S>) => StepResult<S> | Promise<StepResult<S>>
}

export type Runnable<S extends StateSchema = StateSchema> =
  | Agent<S>
  | Step<S>
  | Sequence<S>
  | Parallel<S>
  | Loop<S>

export interface InvocationContext<
  S extends StateSchema = StateSchema,
> extends OrchestrationContext<S> {
  readonly invocationId: string
  readonly parentInvocationId?: string
  readonly runnable: Runnable<S>
  readonly session: Session<S>
  readonly sessionService: SessionService
  readonly state: TypedState<S>
  readonly signal?: AbortSignal
  readonly onStream?: (event: StreamEvent) => void
  endInvocation: boolean
}

export interface SubRunConfig {
  id?: string
  managed?: boolean
  handoffOrigin?: import('./events').HandoffOrigin
}

export interface SubRunner<S extends StateSchema = StateSchema> {
  run(
    runnable: Runnable<S>,
    parentInvocationId?: string,
    config?: SubRunConfig,
  ): AsyncGenerator<StreamEvent, RunResult>
  runToChannel?(
    runnable: Runnable<S>,
    session: Session<S>,
    channel: EventChannel,
    config?: RunConfig & SubRunConfig,
  ): Promise<RunResult>
}

export interface SpawnResult<TOutput = unknown> {
  status: 'completed' | 'error' | 'aborted'
  output: Output<TOutput>
  error?: string
}

export interface SpawnHandle<TOutput = unknown> {
  invocationId: string
  agentName: string
  wait(): Promise<SpawnResult<TOutput>>
  abort(): void
}

/** Handle returned by ctx.dispatch() for fire-and-forget agents. */
export interface DispatchHandle {
  invocationId: string
  agentName: string
}

export interface SubRunResultTransfer {
  agent: Runnable<ErasedStateSchema>
  message?: string
}

export interface SubRunResult<TOutput = unknown> {
  status: 'completed' | 'error' | 'aborted' | 'max_steps' | 'transferred'
  output: Output<TOutput>
  iterations: number
  error?: string
  transfer?: SubRunResultTransfer
}

/** @deprecated Renamed to `SubRunResultTransfer` in 0.5.1. Will be removed in 0.6.0. */
export type CallResultTransfer = SubRunResultTransfer
/** @deprecated Renamed to `SubRunResult` in 0.5.1. Will be removed in 0.6.0. */
export type CallResult<TOutput = unknown> = SubRunResult<TOutput>

export interface HandoffInput {
  message?: string | MessageInput
  state?: Record<string, unknown>
}

export interface HandoffOptions {
  input?: string | HandoffInput
  timeout?: number
}

/**
 * Orchestration primitives for agent-to-agent communication. Available on both InvocationContext
 * (hooks) and ToolContext (tools).
 *
 * For transfers, return the target Runnable directly from a hook or tool: - From
 * beforeAgent/beforeModel/afterModel hooks: `return targetAgent;` - From tool execute: `return
 * targetAgent;`
 */
export interface NoteOpts {
  /** The kind of annotation. Defaults to 'log'. */
  kind?: 'phase' | 'log' | 'mark'
  /** Optional label, e.g. a phase title. */
  label?: string
  /** Optional structured data payload. */
  data?: Record<string, unknown>
}

export interface OrchestrationContext<S extends StateSchema = StateSchema> {
  /**
   * Emit a generic annotation event into the run's StreamEvent stream. Usable from any step,
   * workflow or otherwise — this is a general ADK primitive, not workflow-specific.
   *
   * @param message - Human-readable message or phase title.
   * @param opts - Optional kind (defaults to 'log'), label, and structured data.
   */
  note(message: string, opts?: NoteOpts): void
  run<TOutput>(
    agent: Agent<S, TOutput>,
    inputOrOptions?: string | HandoffOptions,
  ): Promise<SubRunResult<TOutput>>
  run(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): Promise<SubRunResult>

  /** @deprecated Renamed to `run` in 0.5.1. Will be removed in 0.6.0. */
  call<TOutput>(
    agent: Agent<S, TOutput>,
    inputOrOptions?: string | HandoffOptions,
  ): Promise<SubRunResult<TOutput>>
  /** @deprecated Renamed to `run` in 0.5.1. Will be removed in 0.6.0. */
  call(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): Promise<SubRunResult>

  spawn<TOutput>(
    agent: Agent<S, TOutput>,
    inputOrOptions?: string | HandoffOptions,
  ): SpawnHandle<TOutput>
  spawn(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): SpawnHandle

  dispatch(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): DispatchHandle
}

export interface ToolContext<S extends StateSchema = StateSchema> extends InvocationContext<S> {
  readonly callId: ToolCallEvent['callId']
  readonly toolName: ToolCallEvent['name']
  readonly args: ToolCallEvent['args']
  readonly subRunner?: SubRunner<S>
  /** Voice session for audio-mode capabilities. `undefined` in text mode. */
  readonly voice?: import('../voice/types').VoiceSession
  /**
   * Wait for the agent's speech (prior to this tool call) to finish playing out to the user. Only
   * available in voice mode with realtime models. Resolves immediately in text mode or if no speech
   * is pending.
   */
  readonly waitForPlayout?: () => Promise<void>
  /** End the invocation with an explicit output value. The value becomes RunResult.output.value. */
  output<V = unknown>(value: V): OutputSignal
  /**
   * End the session by triggering the agent's output tool via the model. Return this from your
   * tool's execute: `return ctx.end()`. Requires voice mode with an `output` tool configured on the
   * agent.
   */
  end(): EndSignal
}

export interface ModelAdapter {
  step(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult>
}
