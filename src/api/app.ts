import type { AGUIEvent } from '@ag-ui/core'

import { z } from 'zod'

import type { AskOpts } from '../agents/ask'
import type { IncludeHistoryOptions } from '../context/history'
import type {
  MessagePrompt,
  EnrichmentPrompt,
  MessagePromptContext,
  EnrichmentPromptContext,
  TransformUserMessagesOptions,
} from '../context/prompt'
import type { ErrorHandler } from '../errors/types'
import type { AskOutcome, JudgeMetricConfig } from '../eval/metrics/judge'
import type { Metric, MetricRun } from '../eval/metrics/types'
import type { EvalDispatchOptions } from '../eval/mixed'
import type { ReportOptions } from '../eval/report'
import type {
  AnyEvalCase,
  AnyEvalCaseResult,
  BaseEvalResult,
  EvalCase,
  EvalOptions,
  EvalResult,
  MixedEvalOptions,
  MixedEvalResult,
  ToolMock,
  ToolMocks,
} from '../eval/types'
import type {
  VoiceEvalCase,
  VoiceEvalCaseFactory,
  VoiceEvalOptions,
  VoiceEvalResult,
  VoiceRunResult,
} from '../eval/voice/types'
import type { HandlerInput, HandlerConfig } from '../handler/types'
import type { Hook } from '../hook/types'
import type {
  MCPServer,
  MCPServerConfig,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
} from '../mcp/types'
import type { SessionOptions } from '../session'
import type { StateChanges } from '../session/seedState'
import type { TerminalConfig, TerminalHandle } from '../terminal/types'
import type { ModelUsage } from '../types/events'
import type {
  Agent,
  LiveAgent,
  LiveAgentConfig,
  Sequence,
  Parallel,
  Loop,
  Step,
  Runnable,
  FunctionTool,
  Tool,
  ContextRenderer,
  RenderContext,
  OutputConfig,
  OutputSchemaConfig,
  ToolChoice,
  SessionKeyOf,
  ModelConfig,
  AdapterRegistry,
} from '../types/runnables'
import type { RunConfig, RunResult, StreamResult, TurnResult, UsageSummary } from '../types/runtime'
import type { ErasedStateSchema, StateSchema } from '../types/schema'
import type { Session, Input, SessionStore, Sessions } from '../types/session'
import type { AnyZodSchema, ZodSchema } from '../types/zod'
import type { LiveVoiceHandlerConfig } from '../voice/live-types'
import type { VoiceLoggingOptions } from '../voice/logging'
import type { VoiceHook, VoiceHandlerConfig, VoiceHandlerHandle } from '../voice/types'
import type { SearchResult, FetchPageResult } from '../web/types'
import type { Spec } from './spec'

import {
  agent as createAgent,
  step as createStep,
  sequence as createSequence,
  parallel as createParallel,
  loop as createLoop,
  type AgentConfig as BaseAgentConfig,
  type StepConfig,
  type SequenceConfig,
  type ParallelConfig,
  type LoopConfig,
} from '../agents/factory'
import { injectCacheableUserMessage } from '../context/cache'
import {
  limitTools,
  pruneReasoning,
  pruneUserMessages,
  selectRecentEvents,
  setToolChoice,
} from '../context/filters'
import { includeHistory } from '../context/history'
import {
  enrichment,
  injectSystemMessage,
  injectUserMessage,
  message,
  transformUserMessages,
} from '../context/prompt'
import { BaseRunner, summarizeModelUsage } from '../core/runner'
import { OutputParseError } from '../errors/types'
import { createJudgeMetric } from '../eval/metrics/judge'
import { evaluate as runEval } from '../eval/mixed'
import { generateReport } from '../eval/report'
import { createVoiceEvalCase } from '../eval/voice/control'
import { aguiHandler } from '../handler/agui'
import { restHandler, type RestResponse } from '../handler/rest'
import { turn } from '../handler/turn'
import { consoleHook, type ConsoleHookOptions } from '../hook/console'
import { loggingHook, type LoggingHookOptions } from '../hook/logging'
import { metricsHook, type MetricsHookOptions } from '../hook/metrics'
import { createMCPManager } from '../mcp/manager'
import { loadPricing, RESULT_PRICING_WAIT_MS } from '../providers/pricing'
import { runSimulateLoop, type SimulateOptions } from '../run/simulate'
import { runTestLoop, type TestOptions } from '../run/test'
import { session as createSession, BaseSession, seedState } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService as createSessionService } from '../session/service'
import { assertSupportedSchema, assertSupportedStateSchema } from '../types/assert-zod-version'
import { applySchemaDefaults } from '../types/schema'
import { isPrimitiveSchema, isZod4Schema, registerSchemaBridge } from '../types/zod'
import {
  webSearch as webSearchSpec,
  fetchPage as fetchPageSpec,
  takeScreenshot as takeScreenshotSpec,
  type WebSearchConfig,
  type FetchPageConfig,
  type TakeScreenshotConfig,
} from '../web/tools'

export interface AdkConfig<S extends StateSchema> {
  name?: string
  schema?: S
  /** Session storage backend. Defaults to an in-memory store. */
  store?: SessionStore
  hooks?: Hook<S>[]
  errorHandlers?: ErrorHandler[]
  /**
   * Default model used by `app.ask` when `opts.model` is omitted. Omitting this field means
   * `app.ask` without an explicit model will throw if no model is provided.
   */
  defaultModel?: ModelConfig
  /**
   * Model adapters to use for this app. Allows injecting mock adapters in tests. When not set, the
   * app loads adapters from the installed provider packages.
   */
  adapters?: AdapterRegistry
}

type SessionSchemaOf<S extends StateSchema> = NonNullable<S['session']>
type SessionValueOf<S extends StateSchema, K extends keyof SessionSchemaOf<S>> =
  SessionSchemaOf<S>[K] extends ZodSchema<infer U> ? U : never

export interface AgentConfig<S extends StateSchema = StateSchema, TOutput = unknown> extends Omit<
  BaseAgentConfig<S, TOutput>,
  'output' | 'tools'
> {
  tools?: Tool<S>[]
  output?: SessionKeyOf<S> | OutputConfig<S, TOutput>
}

function isLiveAgentConfig<S extends StateSchema, T>(
  config: AgentConfig<S, T> | LiveAgentConfig<S>,
): config is LiveAgentConfig<S> {
  return config.model != null && 'kind' in config.model && config.model.kind === 'live'
}

export type { StepConfig, SequenceConfig, ParallelConfig, LoopConfig }

import type { ToolConfig as SpecToolConfig } from './spec'
export type ToolConfig<TInput, TOutput, TYield, S extends StateSchema> = SpecToolConfig<
  TInput,
  TOutput,
  TYield,
  S
>

export interface RunOptions {
  voice?: RunConfig['voice']
  session?: Session
  input?: string | Input
  hooks?: Hook<ErasedStateSchema>[]
  errorHandlers?: ErrorHandler[]
  timeout?: number
}

/**
 * Context namespace providing both built-in context renderers and custom renderer creation.
 *
 * **As a namespace** - Access built-in context renderers:
 *
 * ```typescript
 * app.context.system('You are helpful')
 * app.context.history()
 * app.context.transform((msg) => msg.toUpperCase())
 * ```
 *
 * **As a function** - Create a custom context renderer with direct RenderContext access:
 *
 * ```typescript
 * app.context((ctx) => ({
 *   ...ctx,
 *   events: [...ctx.events, { type: 'system', text: 'Custom', ... }],
 * }))
 * ```
 */
export interface ContextNamespace<S extends StateSchema> {
  /**
   * Create a custom context renderer with direct access to the RenderContext. Use this for advanced
   * context manipulation not covered by built-in methods.
   *
   * @example
   *   app.context((ctx) => ({
   *     ...ctx,
   *     events: ctx.events.filter((e) => e.type !== 'thought'),
   *   }))
   *
   * @param render - Function that receives and returns the RenderContext
   */
  (render: (ctx: RenderContext<S>) => RenderContext<S>): ContextRenderer<S>

  /** Inject a system message into the context. */
  system(text: string): ContextRenderer<S>
  /** Inject a dynamic system message using state. */
  system(fn: (ctx: MessagePromptContext<S>) => string): ContextRenderer<S>
  /** Inject a system message from a pre-built prompt. */
  system(prompt: MessagePrompt<S>): ContextRenderer<S>

  /** Inject a user message into the context. */
  user(text: string): ContextRenderer<S>
  /** Inject a dynamic user message using state. */
  user(fn: (ctx: MessagePromptContext<S>) => string): ContextRenderer<S>
  /** Inject a user message from a pre-built prompt. */
  user(prompt: MessagePrompt<S>): ContextRenderer<S>

  /** Inject a user message tagged for provider prompt caching. */
  cacheableUser(text: string): ContextRenderer<S>

  /** Include conversation history in the context. */
  history(options?: IncludeHistoryOptions): ContextRenderer<S>
  /** Transform user messages in the context. */
  transform(
    transform: ((msg: string) => string) | EnrichmentPrompt<S>,
    options?: TransformUserMessagesOptions,
  ): ContextRenderer<S>
  /** Remove user messages from context. */
  pruneUserMessages(scope: 'self' | 'all'): ContextRenderer<S>
  /** Keep only the N most recent events. */
  selectRecent(count: number): ContextRenderer<S>
  /** Remove reasoning/thought events from context. */
  pruneReasoning(): ContextRenderer<S>
  /** Restrict available tools to the specified names. */
  limitTools(names: string[]): ContextRenderer<S>
  /** Set the tool choice strategy. */
  toolChoice(choice: ToolChoice): ContextRenderer<S>
}

type WebSearchArgs = { query: string; country?: string | null }
type WebSearchResult = { results: SearchResult[] }
type FetchPageArgs = {
  urls: string | string[]
  includeSelectors?: boolean | null
}
type FetchPageResult_ = { results: FetchPageResult[] }
type ScreenshotTarget = { url: string; selector?: string | null }
type TakeScreenshotArgs = {
  targets: ScreenshotTarget | ScreenshotTarget[]
  fullPage?: boolean | null
}
type TakeScreenshotResult = {
  results: Array<{
    success: boolean
    url: string
    selector?: string
    title?: string
    width?: number
    height?: number
    error?: string
  }>
}
export interface ToolsNamespace<S extends StateSchema> {
  webSearch(config?: WebSearchConfig): FunctionTool<WebSearchArgs, WebSearchResult, never, S>
  fetchPage(config?: FetchPageConfig): FunctionTool<FetchPageArgs, FetchPageResult_, never, S>
  takeScreenshot(
    config?: TakeScreenshotConfig,
  ): FunctionTool<TakeScreenshotArgs, TakeScreenshotResult, never, S>
  mock(config: ToolMock<S>): ToolMock<S>
  mocks(config: ToolMocks<S>): ToolMocks<S>
}

export interface MCPNamespace<S extends StateSchema> {
  server(config: MCPServerConfig): MCPServer<S>
  servers(): MCPServer<S>[]
  get(name: string): MCPServer<S> | undefined
  connect(): Promise<void>
  disconnect(): Promise<void>
  toolDefinitions(): Promise<MCPToolInfo[]>
  tools(): Promise<FunctionTool<unknown, unknown, unknown, S>[]>
  resourceDefinitions(): Promise<MCPResourceInfo[]>
  promptDefinitions(): Promise<MCPPromptInfo[]>
}

interface HookNamespace<S extends StateSchema = StateSchema> {
  (hook: Hook<S>): Hook<S>
  logging(options?: LoggingHookOptions): Hook<S>
  voiceLogging(options?: VoiceLoggingOptions<S>): VoiceHook<S>
  voice(hook: Partial<VoiceHook<S>>): VoiceHook<S>
  metrics(options: MetricsHookOptions): Hook<S>
  console(options?: ConsoleHookOptions): Hook<S>
}

type UserHandlerConfig<S extends StateSchema> = Omit<HandlerConfig<S>, 'appName'>
type UserVoiceHandlerConfig<S extends StateSchema> = Omit<
  VoiceHandlerConfig<S>,
  'sessionService' | 'appName'
> & {
  sessionService?: import('../types/session').SessionService
}

interface HandlerNamespace<S extends StateSchema = StateSchema> {
  rest(config: UserHandlerConfig<S>): (input: HandlerInput) => Promise<RestResponse>
  agui(config: UserHandlerConfig<S>): (input: HandlerInput) => AsyncIterable<AGUIEvent>
  turn(
    config: UserHandlerConfig<S>,
  ): (input: HandlerInput) => StreamResult<TurnResult> & { invocationId: string }
  voice<T>(config: LiveVoiceHandlerConfig<S, T>): VoiceHandlerHandle
  voice(config: UserVoiceHandlerConfig<S>): VoiceHandlerHandle
}

export interface AdkApp<S extends StateSchema> {
  readonly schema: S
  readonly hooks?: Hook<S>[]
  readonly errorHandlers?: ErrorHandler[]
  readonly sessions: Sessions<S>
  /**
   * The app's configured default model. Used by `app.ask` when `opts.model` is omitted. Undefined
   * if no default model was configured in `AdkConfig`.
   */
  readonly defaultModel?: ModelConfig

  readonly context: ContextNamespace<S>
  readonly tools: ToolsNamespace<S>
  readonly mcp: MCPNamespace<S>
  readonly hook: HookNamespace<S>
  readonly handler: HandlerNamespace<S>

  use<T>(s: Spec<T, S>): T

  agent(config: LiveAgentConfig<S>): LiveAgent<S>
  agent<K extends SessionKeyOf<S>>(
    config: Omit<AgentConfig<S, SessionValueOf<S, K>>, 'output'> & {
      output: K
    },
  ): Agent<S, SessionValueOf<S, K>>
  agent<TOutput = unknown>(
    config: Omit<AgentConfig<S, TOutput>, 'output'> & {
      output?: OutputConfig<S, TOutput>
    },
  ): Agent<S, TOutput>
  agent<TOutput = unknown>(config: AgentConfig<S, TOutput>): Agent<S, TOutput>

  /**
   * Bind a component that reads session state and runs to completion using this app's runner.
   * Parent input messages are not forwarded; yielded or incomplete children fail the binding.
   */
  bind<C extends StateSchema>(
    component: { app: Pick<AdkApp<C>, 'schema'>; runnable: Runnable<C> } & (S extends C
      ? unknown
      : never),
  ): Step<S>

  step(config: StepConfig<S>): Step<S>
  sequence(config: SequenceConfig<S>): Sequence<S>
  parallel(config: ParallelConfig<S>): Parallel<S>
  loop(config: LoopConfig<S>): Loop<S>

  tool<TInput, TOutput, TYield = never>(
    config: SpecToolConfig<TInput, TOutput, TYield, S>,
  ): FunctionTool<TInput, TOutput, TYield, S>

  toolInputsSchema(): z.ZodArray<z.ZodTypeAny>

  message(fn: (ctx: MessagePromptContext<S>) => string): MessagePrompt<S>
  message(text: string): MessagePrompt<S>

  enrichment(fn: (ctx: EnrichmentPromptContext<S>) => string): EnrichmentPrompt<S>

  /** @deprecated Use `app.sessions.create()` instead. */
  session(options?: SessionOptions): Promise<Session<S>>
  run<TOutput>(runnable: Agent<S, TOutput>, input: string): StreamResult<RunResult<S, TOutput>>
  run<TOutput>(runnable: Agent<S, TOutput>, config: RunOptions): StreamResult<RunResult<S, TOutput>>
  run(runnable: Runnable<S>, input: string): StreamResult<RunResult<S>>
  run(runnable: Runnable<S>, config: RunOptions): StreamResult<RunResult<S>>

  /**
   * One-shot, no-tools, isolated (fresh BaseSession) typed LLM call.
   *
   * Without a schema: returns the assistant text as `string`. With a schema: returns the
   * schema-validated value typed as `T`.
   *
   * Each call runs on its own fresh BaseSession — no state bleeds between calls. Only
   * `OutputParseError` is retried (up to `opts.retries`, default 2 when a schema is set); provider
   * errors surface immediately.
   *
   * This is the terse front-door to `app.agent` + `app.run` for reasoning, judging, extraction, and
   * verdict nodes. Tool-using and coding nodes must use `app.agent`/`CodingAgent` instead.
   */
  ask(prompt: string): Promise<string>
  ask<T>(prompt: string, opts: AskOpts<T> & { schema: z.ZodType<T> }): Promise<T>
  ask<T = string>(prompt: string, opts?: AskOpts<T>): Promise<T>

  test<TOutput>(runnable: Agent<S, TOutput>, options: TestOptions): Promise<RunResult<S, TOutput>>
  test(runnable: Runnable<S>, options: TestOptions): Promise<RunResult<S>>
  simulate<TOutput>(
    runnable: Agent<S, TOutput>,
    options: SimulateOptions,
  ): Promise<RunResult<S, TOutput>>
  simulate(runnable: Runnable<S>, options: SimulateOptions): Promise<RunResult<S>>
  evaluate: {
    (cases: EvalCase<S> | EvalCase<S>[], options?: EvalOptions<S>): Promise<EvalResult<S>>
    (
      cases: AnyEvalCase<S> | AnyEvalCase<S>[],
      options?: MixedEvalOptions<S>,
    ): Promise<MixedEvalResult<S>>
    cli(cases: AnyEvalCase<S>[], options?: MixedEvalOptions<S>): Promise<0 | 1 | 2>
    voice: {
      <T>(cases: VoiceEvalCase<S, T>, options?: VoiceEvalOptions<S>): Promise<VoiceEvalResult<S>>
      (cases: VoiceEvalCase<S>[], options?: VoiceEvalOptions<S>): Promise<VoiceEvalResult<S>>
      case<T>(config: VoiceEvalCase<S, T> | VoiceEvalCaseFactory<S, T>): VoiceEvalCase<S, T>
      cases(config: (VoiceEvalCase<S> | VoiceEvalCaseFactory<S>)[]): VoiceEvalCase<S>[]
      report(options?: ReportOptions<S, VoiceEvalResult<S>>): (result: VoiceEvalResult<S>) => string
    }
    metric(config: Metric<MetricRun<S>>): Metric<MetricRun<S>>
    /**
     * An LLM-judge metric for text and voice cases. One model call per run returns a verdict and a
     * one-sentence reason for each criterion. A failed or malformed call makes the case `error`.
     */
    judge(config: JudgeMetricConfig): Metric<MetricRun<S> | VoiceRunResult<S>>
    case(config: EvalCase<S>): EvalCase<S>
    cases<C extends AnyEvalCase<S>>(config: C[]): C[]
    report<R extends BaseEvalResult<AnyEvalCaseResult<S>>>(
      options?: ReportOptions<S, R>,
    ): (result: R) => string
  }
  initialState(config: StateChanges<S>): StateChanges<S>

  terminal(runnable: Runnable<S>): TerminalHandle
  terminal(runnable: Runnable<S>, input: string): TerminalHandle
  terminal(runnable: Runnable<S>, config: TerminalConfig): TerminalHandle

  close(): Promise<void>
}

function modelCalls(session: Session): (ModelUsage | undefined)[] {
  return session.events.flatMap((event) => (event.type === 'model_end' ? [event.usage] : []))
}

async function priced(calls: (ModelUsage | undefined)[]): Promise<UsageSummary | undefined> {
  return summarizeModelUsage(calls, await loadPricing({ maxWaitMs: RESULT_PRICING_WAIT_MS }))
}

/**
 * Strips optional/nullable/default wrappers so a session key declared as `z.string().optional()` is
 * still recognised as primitive: a wrapped primitive that fell through to the schema path would
 * have the model's prose parsed as a value (the first number in "last 7 days" became "7").
 */
function normalizeOutput<S extends StateSchema, TOutput>(
  schema: S,
  output: SessionKeyOf<S> | OutputConfig<S, TOutput> | undefined,
): OutputConfig<S, TOutput> | undefined {
  if (output === undefined) return undefined

  if (typeof output === 'string') {
    const zodSchema = schema.session?.[output as string]
    if (isPrimitiveSchema(zodSchema)) {
      return { key: output } as OutputConfig<S, TOutput>
    }
    return {
      key: output,
      schema: zodSchema,
      mode: 'native',
    } as OutputSchemaConfig<S, TOutput>
  }

  if ('schema' in output) assertSupportedSchema(output.schema, 'app.agent({ output })')
  return output
}

function prepend<T>(base: T[] | undefined, extra: T[] | undefined): T[] | undefined {
  if (!base?.length) return extra
  if (!extra?.length) return base
  return [...base, ...extra]
}

function identityContextFn<S extends StateSchema>(
  render: (ctx: RenderContext<S>) => RenderContext<S>,
): ContextRenderer<S> {
  return render
}

export function adk(): AdkApp<StateSchema>
export function adk<S extends StateSchema>(config: AdkConfig<S>): AdkApp<S>
export function adk<S extends StateSchema>(config?: AdkConfig<S>): AdkApp<S> {
  const {
    name: appName = 'adk-app',
    schema = {} as S,
    store: appStore,
    hooks: appHooks,
    errorHandlers: appErrorHandlers,
    defaultModel: appDefaultModel,
    adapters: appAdapters,
  } = config ?? {}

  assertSupportedStateSchema(schema, 'adk({ schema })')

  const resolvedStore = appStore ?? inMemoryStore()
  const appSessionService = createSessionService(resolvedStore)

  const contextFn = identityContextFn<S> as unknown as ContextNamespace<S>

  contextFn.system = (
    input: string | ((ctx: MessagePromptContext<S>) => string) | MessagePrompt<S>,
  ): ContextRenderer<S> => {
    if (typeof input === 'string') {
      return injectSystemMessage<S>(input)
    }
    if (typeof input === 'function') {
      return injectSystemMessage<S>(message<S>(schema, input))
    }
    return injectSystemMessage<S>(input)
  }

  contextFn.user = (
    input: string | ((ctx: MessagePromptContext<S>) => string) | MessagePrompt<S>,
  ): ContextRenderer<S> => {
    if (typeof input === 'string') {
      return injectUserMessage<S>(message<S>(schema, input))
    }
    if (typeof input === 'function') {
      return injectUserMessage<S>(message<S>(schema, input))
    }
    return injectUserMessage<S>(input)
  }

  contextFn.cacheableUser = (text: string): ContextRenderer<S> => {
    return injectCacheableUserMessage<S>(text)
  }

  contextFn.history = (options?: IncludeHistoryOptions): ContextRenderer<S> => {
    return includeHistory<S>(options)
  }

  contextFn.transform = (
    transform: ((msg: string) => string) | EnrichmentPrompt<S>,
    options?: TransformUserMessagesOptions,
  ): ContextRenderer<S> => {
    return transformUserMessages<S>(transform, options)
  }

  contextFn.pruneUserMessages = (scope: 'self' | 'all'): ContextRenderer<S> => {
    return pruneUserMessages<S>(scope)
  }

  contextFn.selectRecent = (count: number): ContextRenderer<S> => {
    return selectRecentEvents<S>(count)
  }

  contextFn.pruneReasoning = (): ContextRenderer<S> => {
    return pruneReasoning<S>()
  }

  contextFn.limitTools = (names: string[]): ContextRenderer<S> => {
    return limitTools<S>(names)
  }

  contextFn.toolChoice = (choice: ToolChoice): ContextRenderer<S> => {
    return setToolChoice<S>(choice)
  }

  const contextNamespace = contextFn as ContextNamespace<S>

  const executeRun = (
    runnable: Runnable<ErasedStateSchema>,
    inputOrConfig: string | RunOptions,
  ): StreamResult => {
    // Guard: v2 options (resume, background, runId) are not implemented in v1.
    // Reject immediately with a descriptive error — do NOT silently accept-and-ignore.
    if (typeof inputOrConfig === 'object' && inputOrConfig !== null) {
      const v2Keys = ['resume', 'background', 'runId'] as const
      for (const key of v2Keys) {
        if (key in inputOrConfig) {
          throw new Error(
            `[adk] app.run: '${key}' is deferred to v2 (durable resume / background execution on the process-runtime gateway). Remove this option or wait for v2.`,
          )
        }
      }
    }

    const runner = new BaseRunner({
      sessionService: appSessionService,
      hooks: appHooks,
      errorHandlers: appErrorHandlers,
      adapters: appAdapters,
    })
    const opts: RunOptions =
      typeof inputOrConfig === 'string' ? { input: { message: inputOrConfig } } : inputOrConfig
    const input = typeof opts.input === 'string' ? { message: opts.input } : opts.input
    const sess = (opts.session ?? new BaseSession(appName)) as BaseSession

    if (input?.state) {
      sess.state.update(applySchemaDefaults(input.state, schema?.session))
    }

    if (input?.initialState) {
      seedState(sess, input.initialState, schema)
    }

    if (input?.tools?.length) {
      sess.input.tools(input.tools)
    }

    if (input?.message !== undefined && !input?.tools?.length) {
      sess.input.message(input.message)
    }

    const runConfig: RunConfig = {
      voice: opts.voice,
      timeout: opts.timeout,
      hooks: opts.hooks,
      errorHandlers: opts.errorHandlers,
    }

    return runner.run(runnable, sess, runConfig)
  }

  const toolsNamespace: ToolsNamespace<S> = {
    webSearch: (toolConfig) =>
      webSearchSpec(toolConfig)(app as unknown as AdkApp<StateSchema>) as unknown as FunctionTool<
        WebSearchArgs,
        WebSearchResult,
        never,
        S
      >,
    fetchPage: (toolConfig) =>
      fetchPageSpec(toolConfig)(app as unknown as AdkApp<StateSchema>) as unknown as FunctionTool<
        FetchPageArgs,
        FetchPageResult_,
        never,
        S
      >,
    takeScreenshot: (toolConfig) =>
      takeScreenshotSpec(toolConfig)(
        app as unknown as AdkApp<StateSchema>,
      ) as unknown as FunctionTool<TakeScreenshotArgs, TakeScreenshotResult, never, S>,
    mock: (toolConfig) => toolConfig,
    mocks: (toolConfig) => toolConfig,
  }

  const registeredTools: Array<{ name: string; yieldSchema?: AnyZodSchema }> = []

  const mcpManager = createMCPManager<S>()

  const mcpNamespace: MCPNamespace<S> = {
    server: (mcpConfig) => mcpManager.server(mcpConfig),
    servers: () => mcpManager.servers(),
    get: (name) => mcpManager.get(name),
    connect: () => mcpManager.connect(),
    disconnect: () => mcpManager.disconnect(),
    toolDefinitions: async () => {
      const results = await Promise.all(mcpManager.servers().map((s) => s.toolDefinitions()))
      return results.flat()
    },
    tools: () => mcpManager.getAllTools(),
    resourceDefinitions: async () => {
      const results = await Promise.all(mcpManager.servers().map((s) => s.resourceDefinitions()))
      return results.flat()
    },
    promptDefinitions: async () => {
      const results = await Promise.all(mcpManager.servers().map((s) => s.promptDefinitions()))
      return results.flat()
    },
  }

  function appAgent(agentConfig: LiveAgentConfig<S>): LiveAgent<S>
  function appAgent<T>(agentConfig: AgentConfig<S, T>): Agent<S, T>
  function appAgent<T>(
    agentConfig: AgentConfig<S, T> | LiveAgentConfig<S>,
  ): Agent<S, T> | LiveAgent<S> {
    if (isLiveAgentConfig(agentConfig)) return { ...agentConfig, kind: 'live-agent', tools: [] }
    return createAgent<S, T>({
      ...agentConfig,
      output: normalizeOutput<S, T>(schema, agentConfig.output),
      hooks: agentConfig.hooks ?? appHooks,
      errorHandlers: agentConfig.errorHandlers ?? appErrorHandlers,
    })
  }

  /**
   * `app.ask` with the usage it spent, summed over every attempt, parse retries included. A failed
   * call reports its usage too. The runner records a call that failed or was aborted as a call
   * without usage, so its cost reads as unavailable, never as free.
   */
  async function askWithUsage<T = string>(
    prompt: string,
    opts?: AskOpts<T>,
  ): Promise<AskOutcome<T>> {
    // Resolve model: opts.model ?? app.defaultModel; error if neither is set
    const resolvedModel = opts?.model ?? appDefaultModel
    if (!resolvedModel) {
      throw new Error(
        '[adk] app.ask: no model configured. Pass opts.model or set defaultModel in adk({ defaultModel }).',
      )
    }

    // Build the context array: [system(opts.system), history()] when system is set, else [history()]
    const contextRenderers = opts?.system
      ? [injectSystemMessage<S>(opts.system), includeHistory<S>()]
      : [includeHistory<S>()]

    // Build an ephemeral no-tools agent — NO tools, NO handlers
    const ephemeralAgent = createAgent<S, T>({
      name: 'ask-ephemeral',
      model: resolvedModel,
      context: contextRenderers,
      tools: [],
      output: opts?.schema ? ({ schema: opts.schema } as OutputConfig<S, T>) : undefined,
    })

    // Retry budget: opts.retries ?? (opts.schema ? 2 : 0)
    const budget = opts?.retries ?? (opts?.schema ? 2 : 0)
    const spent: (ModelUsage | undefined)[] = []

    for (let attempt = 0; attempt <= budget; attempt++) {
      // Each attempt runs on a FRESH BaseSession, kept so a failed attempt's usage can be counted
      const session = new BaseSession(appName)
      try {
        const stream = executeRun(ephemeralAgent as unknown as Runnable<S>, {
          input: prompt,
          session,
        })

        // Thread the abort signal into the inner stream
        if (opts?.signal) {
          if (opts.signal.aborted) {
            stream.abort()
          } else {
            opts.signal.addEventListener('abort', () => stream.abort(), { once: true })
          }
        }

        const result = await stream
        const value = (opts?.schema ? result.output.value : (result.output.text ?? '')) as T
        if (!spent.length) return { ok: true, value, usage: result.usage }
        return { ok: true, value, usage: await priced([...spent, ...modelCalls(session)]) }
      } catch (e) {
        // Only OutputParseError is retried; provider/transport errors surface immediately.
        // We check both instanceof (direct throw path) and e.name === 'OutputParseError'
        // (channel-deserialized path where the class is reconstructed as a plain Error).
        const isParseError =
          e instanceof OutputParseError || (e instanceof Error && e.name === 'OutputParseError')
        spent.push(...modelCalls(session))
        if (isParseError && attempt < budget) continue
        return { ok: false, error: e, usage: await priced(spent) }
      }
    }

    // Unreachable but TypeScript requires a return/throw here
    throw new Error('[adk] app.ask: unexpected end of retry loop')
  }

  const app: AdkApp<S> = {
    schema,
    hooks: appHooks,
    errorHandlers: appErrorHandlers,
    defaultModel: appDefaultModel,
    sessions: {
      create(options) {
        return appSessionService.createSession(appName, options) as Promise<Session<S>>
      },
      get(sessionId) {
        return appSessionService.getSession(appName, sessionId) as Promise<Session<S> | null>
      },
      async delete(sessionId) {
        return appSessionService.deleteSession(appName, sessionId)
      },
      list() {
        return appSessionService.listSessions(appName)
      },
      commit(session, expectedVersion?) {
        return appSessionService.commitSession(session, expectedVersion)
      },
      merge(session, latest?) {
        return appSessionService.mergeSession(session, latest)
      },
    },

    context: contextNamespace,
    tools: toolsNamespace,
    mcp: mcpNamespace,
    hook: Object.assign((h: Hook<S>): Hook<S> => h, {
      logging: (opts?: LoggingHookOptions) => loggingHook(opts) as Hook<S>,
      voiceLogging: (opts?: import('../voice/logging').VoiceLoggingOptions<S>) => {
        const { voiceLoggingHook } =
          require('../voice/logging') as typeof import('../voice/logging')
        return voiceLoggingHook<S>(opts)
      },
      voice: (h: Partial<VoiceHook<S>>): VoiceHook<S> => h as VoiceHook<S>,
      metrics: (opts: MetricsHookOptions) => metricsHook(opts) as Hook<S>,
      console: (opts?: ConsoleHookOptions) => consoleHook(opts) as Hook<S>,
    }),
    handler: {
      rest: (cfg) =>
        restHandler({
          ...cfg,
          appName,
          schema,
          sessionService: cfg.sessionService ?? appSessionService,
          adapters: cfg.adapters ?? appAdapters,
          hooks: prepend(appHooks, cfg.hooks),
          errorHandlers: prepend(appErrorHandlers, cfg.errorHandlers),
        }),
      agui: (cfg) =>
        aguiHandler({
          ...cfg,
          appName,
          schema,
          sessionService: cfg.sessionService ?? appSessionService,
          adapters: cfg.adapters ?? appAdapters,
          hooks: prepend(appHooks, cfg.hooks),
          errorHandlers: prepend(appErrorHandlers, cfg.errorHandlers),
        }),
      turn: (cfg) => {
        const merged = {
          ...cfg,
          appName,
          schema,
          sessionService: cfg.sessionService ?? appSessionService,
          adapters: cfg.adapters ?? appAdapters,
          hooks: prepend(appHooks, cfg.hooks),
          errorHandlers: prepend(appErrorHandlers, cfg.errorHandlers),
        }
        return (input) => turn(merged, input)
      },
      voice: <T>(cfg: LiveVoiceHandlerConfig<S, T> | UserVoiceHandlerConfig<S>) => {
        // Lazy require to avoid loading @livekit/agents until voice() is actually called
        const { voiceHandler, createLiveVoiceHandler } =
          require('../voice') as typeof import('../voice')
        if ('backend' in cfg)
          return createLiveVoiceHandler(cfg, {
            app,
            store: resolvedStore,
            sessionService: appSessionService,
          })
        // appHooks are Hook[] which are structurally valid VoiceHook[] (no lifecycle fields set)
        const mergedHooks = prepend(appHooks as import('../voice/types').VoiceHook<S>[], cfg.hooks)
        return voiceHandler({
          ...cfg,
          appName,
          schema,
          sessionService: cfg.sessionService ?? appSessionService,
          adapters: cfg.adapters ?? appAdapters,
          hooks: mergedHooks,
          errorHandlers: prepend(appErrorHandlers, cfg.errorHandlers),
        })
      },
    },

    use<T>(s: Spec<T, S>): T {
      return s(this)
    },

    agent: appAgent,

    bind<C extends StateSchema>(
      component: { app: Pick<AdkApp<C>, 'schema'>; runnable: Runnable<C> } & (S extends C
        ? unknown
        : never),
    ): Step<S> {
      const childSchema = component.app.schema
      if (Object.keys(childSchema).some((scope) => scope !== 'session'))
        throw new Error('app.bind currently supports session state only')
      for (const key of Object.keys(childSchema.session ?? {})) {
        if (!Object.hasOwn(schema.session ?? {}, key))
          throw new Error(`app.bind: parent session schema is missing '${key}'`)
      }
      return createStep<S>({
        name: `bind-${component.runnable.name}`,
        execute: async (ctx) => {
          const childInput = Object.fromEntries(
            Object.keys(childSchema.session ?? {}).map((key) => [key, ctx.state[key]]),
          )
          const input = applySchemaDefaults(childInput, childSchema.session)
          ctx.session.boundState<StateSchema>(ctx.invocationId).update(input)
          const child = component.runnable as Runnable<S>
          const result = await ctx.run(child)
          if (result.status !== 'completed')
            throw new Error(result.error ?? `${component.runnable.name} ${result.status}`)
          applySchemaDefaults(ctx.state, schema.session)
          ctx.output(result.output.value)
        },
      })
    },

    step(stepConfig: StepConfig<S>): Step<S> {
      return createStep<S>(stepConfig)
    },

    sequence(sequenceConfig: SequenceConfig<S>): Sequence<S> {
      return createSequence<S>(sequenceConfig)
    },

    parallel(parallelConfig: ParallelConfig<S>): Parallel<S> {
      return createParallel<S>(parallelConfig)
    },

    loop(loopConfig: LoopConfig<S>): Loop<S> {
      return createLoop<S>(loopConfig)
    },

    tool<TInput, TOutput, TYield = never>(
      toolConfig: SpecToolConfig<TInput, TOutput, TYield, S>,
    ): FunctionTool<TInput, TOutput, TYield, S> {
      if (!toolConfig.yieldSchema && !toolConfig.execute) {
        throw new Error(`Tool '${toolConfig.name}' must have either 'execute' or 'yieldSchema'`)
      }
      assertSupportedSchema(toolConfig.schema, `app.tool('${toolConfig.name}')`)
      assertSupportedSchema(toolConfig.yieldSchema, `app.tool('${toolConfig.name}')`)
      registeredTools.push({
        name: toolConfig.name,
        yieldSchema: toolConfig.yieldSchema,
      })
      return {
        name: toolConfig.name,
        description: toolConfig.description,
        schema: toolConfig.schema,
        yieldSchema: toolConfig.yieldSchema,
        prepare: toolConfig.prepare,
        execute: toolConfig.execute,
        finalize: toolConfig.finalize,
        timeout: toolConfig.timeout,
        retry: toolConfig.retry,
      }
    },

    toolInputsSchema(): z.ZodArray<z.ZodTypeAny> {
      const rootIsZod4 = isZod4Schema(z.string())
      const inRootGeneration = (inputSchema: AnyZodSchema): z.ZodTypeAny => {
        if (isZod4Schema(inputSchema) === rootIsZod4) return inputSchema as z.ZodTypeAny
        const bridge = z.any().transform((value, ctx) => {
          const parsed = inputSchema.safeParse(value)
          if (parsed.success) return parsed.data
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message })
          }
          return z.NEVER
        })
        registerSchemaBridge(bridge, inputSchema)
        return bridge
      }
      const members = registeredTools.map((t) =>
        z.object({
          callId: z.string(),
          toolName: z.literal(t.name),
          input: t.yieldSchema ? inRootGeneration(t.yieldSchema) : z.unknown(),
        }),
      )

      if (members.length === 0) {
        return z.array(
          z.object({
            callId: z.string(),
            toolName: z.string(),
            input: z.unknown(),
          }),
        )
      }

      if (members.length === 1) {
        return z.array(members[0])
      }

      return z.array(
        z.discriminatedUnion(
          'toolName',
          members as [(typeof members)[0], (typeof members)[0], ...typeof members],
        ),
      )
    },

    message(input: string | ((ctx: MessagePromptContext<S>) => string)): MessagePrompt<S> {
      return message<S>(schema, input)
    },

    enrichment(fn: (ctx: EnrichmentPromptContext<S>) => string): EnrichmentPrompt<S> {
      return enrichment<S>(schema, fn)
    },

    async session(options?: SessionOptions): Promise<Session<S>> {
      return createSession(appName, {
        ...options,
        sessionService: options?.sessionService ?? appSessionService,
      }) as Promise<Session<S>>
    },

    run(runnable: Runnable<S>, inputOrConfig: string | RunOptions): StreamResult<RunResult<S>> {
      return executeRun(runnable, inputOrConfig) as StreamResult<RunResult<S>>
    },

    async ask<T = string>(prompt: string, opts?: AskOpts<T>): Promise<T> {
      const outcome = await askWithUsage(prompt, opts)
      if (!outcome.ok) throw outcome.error
      return outcome.value
    },

    test(runnable: Runnable<S>, options: TestOptions): Promise<RunResult<S>> {
      return runTestLoop(runnable, (rn, cfg) => executeRun(rn, cfg), options) as Promise<
        RunResult<S>
      >
    },

    simulate(runnable: Runnable<S>, options: SimulateOptions): Promise<RunResult<S>> {
      return runSimulateLoop(runnable, (rn, cfg) => executeRun(rn, cfg), options) as Promise<
        RunResult<S>
      >
    },

    evaluate: Object.assign(evaluate, {
      cli: async (cases: AnyEvalCase<S>[], options?: MixedEvalOptions<S>) => {
        const { evalCli } = await import('../eval/cli.js')
        return evalCli(app, cases, options)
      },
      voice: Object.assign(
        async <T>(
          caseOrCases: VoiceEvalCase<S, T> | VoiceEvalCase<S>[],
          options?: VoiceEvalOptions<S>,
        ): Promise<VoiceEvalResult<S>> => {
          const { evaluateVoice } = await import('../eval/voice/evaluate.js')
          return evaluateVoice(
            caseOrCases,
            { ...options, schema: options?.schema ?? schema },
            { app, store: resolvedStore, sessionService: appSessionService },
          )
        },
        {
          case: <T>(evalCase: VoiceEvalCase<S, T> | VoiceEvalCaseFactory<S, T>) =>
            createVoiceEvalCase(evalCase),
          cases: (evalCases: (VoiceEvalCase<S> | VoiceEvalCaseFactory<S>)[]) =>
            evalCases.map(createVoiceEvalCase),
          report:
            (options?: ReportOptions<S, VoiceEvalResult<S>>) =>
            (result: VoiceEvalResult<S>): string =>
              generateReport(result, options),
        },
      ),
      metric: (metric: Metric<MetricRun<S>>) => metric,
      judge: (judgeConfig: JudgeMetricConfig) => createJudgeMetric<S>(judgeConfig, askWithUsage),
      case: (evalCase: EvalCase<S>) => evalCase,
      cases: <C extends AnyEvalCase<S>>(evalCases: C[]) => evalCases,
      report:
        <R extends BaseEvalResult<AnyEvalCaseResult<S>>>(options?: ReportOptions<S, R>) =>
        (result: R): string =>
          generateReport(result, options),
    }),

    initialState: (state: StateChanges<S>) => state,

    terminal(runnable: Runnable<S>, inputOrConfig?: string | TerminalConfig): TerminalHandle {
      const terminalConfig: TerminalConfig =
        typeof inputOrConfig === 'string' ? { input: inputOrConfig } : (inputOrConfig ?? {})

      terminalConfig.runner ??= new BaseRunner({
        sessionService: terminalConfig.sessionService ?? appSessionService,
        adapters: appAdapters,
        hooks: prepend(appHooks, terminalConfig.options?.hooks),
        errorHandlers: appErrorHandlers,
      })
      terminalConfig.session ??= new BaseSession(appName)

      // Lazy require to avoid loading React/Ink until terminal() is actually called
      const { terminal: runTerminal } = require('../terminal') as typeof import('../terminal')

      return runTerminal(runnable, terminalConfig)
    },

    async close(): Promise<void> {
      await mcpManager.disconnect()
      await resolvedStore.close()
    },
  }

  function evaluate(
    cases: EvalCase<S> | EvalCase<S>[],
    options?: EvalOptions<S>,
  ): Promise<EvalResult<S>>
  function evaluate(
    cases: AnyEvalCase<S> | AnyEvalCase<S>[],
    options?: MixedEvalOptions<S>,
  ): Promise<MixedEvalResult<S>>
  function evaluate(
    cases: AnyEvalCase<S> | AnyEvalCase<S>[],
    options?: EvalDispatchOptions<S>,
  ): Promise<MixedEvalResult<S>> {
    return runEval(app, cases, options, {
      app,
      store: resolvedStore,
      sessionService: appSessionService,
    })
  }

  return app
}
