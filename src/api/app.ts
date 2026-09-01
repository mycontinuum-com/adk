import type { AGUIEvent } from '@ag-ui/core'

import { z } from 'zod'

import type { AskOpts } from '../agents/ask'
import type { CLIConfig, CLIHandle } from '../cli/types'
import type { IncludeHistoryOptions } from '../context/history'
import type {
  MessagePrompt,
  EnrichmentPrompt,
  MessagePromptContext,
  EnrichmentPromptContext,
  TransformUserMessagesOptions,
} from '../context/prompt'
import type { ErrorHandler } from '../errors/types'
import type { Metric, MetricRun } from '../eval/metrics/types'
import type { ReportOptions } from '../eval/report'
import type { EvalCase, EvalOptions, EvalResult, ToolMock, ToolMocks } from '../eval/types'
import type {
  VoiceEvalCase,
  VoiceEvalCaseFactory,
  VoiceEvalOptions,
  VoiceEvalResult,
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
import type {
  Agent,
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
  ModelAdapter,
  Provider,
} from '../types/runnables'
import type { RunConfig, RunResult, StreamResult, TurnResult } from '../types/runtime'
import type { ErasedStateSchema, StateSchema } from '../types/schema'
import type { Session, Input, SessionStore, Sessions } from '../types/session'
import type { VoiceLoggingOptions } from '../voice/logging'
import type { VoiceHook } from '../voice/types'
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
import { BaseRunner } from '../core/runner'
import { OutputParseError } from '../errors/types'
import { generateReport } from '../eval/report'
import { evaluate as runEval } from '../eval/simulator'
import { aguiHandler } from '../handler/agui'
import { restHandler, type RestResponse } from '../handler/rest'
import { turn } from '../handler/turn'
import { cliHook, type CliHookOptions } from '../hook/cli'
import { loggingHook, type LoggingHookOptions } from '../hook/logging'
import { metricsHook, type MetricsHookOptions } from '../hook/metrics'
import { createMCPManager } from '../mcp/manager'
import { runSimulateLoop, type SimulateOptions } from '../run/simulate'
import { runTestLoop, type TestOptions } from '../run/test'
import { session as createSession, BaseSession, seedState } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService as createSessionService } from '../session/service'
import { assertZod3Schema, assertZod3StateSchema } from '../types/assert-zod-version'
import { applySchemaDefaults } from '../types/schema'
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
  adapters?: Partial<Record<Provider, ModelAdapter>>
}

type SessionSchemaOf<S extends StateSchema> = NonNullable<S['session']>
type SessionValueOf<S extends StateSchema, K extends keyof SessionSchemaOf<S>> =
  SessionSchemaOf<S>[K] extends z.ZodType<infer U> ? U : never

export interface AgentConfig<S extends StateSchema = StateSchema, TOutput = unknown> extends Omit<
  BaseAgentConfig<S, TOutput>,
  'output' | 'tools'
> {
  tools?: Tool<S>[]
  output?: SessionKeyOf<S> | OutputConfig<S, TOutput>
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

export interface HookNamespace<S extends StateSchema = StateSchema> {
  (hook: Hook<S>): Hook<S>
  logging(options?: LoggingHookOptions): Hook<S>
  voiceLogging(options?: VoiceLoggingOptions<S>): VoiceHook<S>
  voice(hook: Partial<VoiceHook<S>>): VoiceHook<S>
  metrics(options: MetricsHookOptions): Hook<S>
  cli(options?: CliHookOptions): Hook<S>
}

type UserHandlerConfig<S extends StateSchema> = Omit<HandlerConfig<S>, 'appName'>

export interface HandlerNamespace<S extends StateSchema = StateSchema> {
  rest(config: UserHandlerConfig<S>): (input: HandlerInput) => Promise<RestResponse>
  agui(config: UserHandlerConfig<S>): (input: HandlerInput) => AsyncIterable<AGUIEvent>
  turn(
    config: UserHandlerConfig<S>,
  ): (input: HandlerInput) => StreamResult<TurnResult> & { invocationId: string }
  voice(
    config: Omit<import('../voice/types').VoiceHandlerConfig<S>, 'sessionService' | 'appName'> & {
      sessionService?: import('../types/session').SessionService
    },
  ): import('../voice/types').VoiceHandlerHandle
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
  evaluate: ((
    cases: EvalCase<S> | EvalCase<S>[],
    options?: EvalOptions<S>,
  ) => Promise<EvalResult<S>>) & {
    voice: ((
      cases: VoiceEvalCase<S> | VoiceEvalCase<S>[],
      options?: VoiceEvalOptions<S>,
    ) => Promise<VoiceEvalResult<S>>) & {
      case(config: VoiceEvalCase<S> | VoiceEvalCaseFactory<S>): VoiceEvalCase<S>
      cases(config: (VoiceEvalCase<S> | VoiceEvalCaseFactory<S>)[]): VoiceEvalCase<S>[]
      report(options?: ReportOptions<S, VoiceEvalResult<S>>): (result: VoiceEvalResult<S>) => string
    }
    metric(config: Metric<MetricRun<S>>): Metric<MetricRun<S>>
    case(config: EvalCase<S>): EvalCase<S>
    cases(config: EvalCase<S>[]): EvalCase<S>[]
    report<R extends EvalResult<S> | VoiceEvalResult<S>>(
      options?: ReportOptions<S, R>,
    ): (result: R) => string
  }
  initialState(config: StateChanges<S>): StateChanges<S>

  cli(runnable: Runnable<S>): CLIHandle
  cli(runnable: Runnable<S>, input: string): CLIHandle
  cli(runnable: Runnable<S>, config: CLIConfig): CLIHandle

  close(): Promise<void>
}

function isPrimitiveZodType(zodSchema: z.ZodType | undefined): boolean {
  if (!zodSchema) return false
  return (
    zodSchema instanceof z.ZodString ||
    zodSchema instanceof z.ZodNumber ||
    zodSchema instanceof z.ZodBoolean ||
    zodSchema instanceof z.ZodEnum ||
    zodSchema instanceof z.ZodLiteral ||
    zodSchema instanceof z.ZodNull ||
    zodSchema instanceof z.ZodUndefined ||
    zodSchema instanceof z.ZodBigInt ||
    zodSchema instanceof z.ZodDate
  )
}

function normalizeOutput<S extends StateSchema, TOutput>(
  schema: S,
  output: SessionKeyOf<S> | OutputConfig<S, TOutput> | undefined,
): OutputConfig<S, TOutput> | undefined {
  if (output === undefined) return undefined

  if (typeof output === 'string') {
    const zodSchema = schema.session?.[output as string]
    if (isPrimitiveZodType(zodSchema)) {
      return { key: output } as OutputConfig<S, TOutput>
    }
    return {
      key: output,
      schema: zodSchema,
      mode: 'native',
    } as OutputSchemaConfig<S, TOutput>
  }

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

  assertZod3StateSchema(schema, 'adk({ schema })')

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

  const registeredTools: Array<{ name: string; yieldSchema?: z.ZodTypeAny }> = []

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
      cli: (opts?: CliHookOptions) => cliHook(opts) as Hook<S>,
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
      voice: (cfg) => {
        // Lazy require to avoid loading @livekit/agents until voice() is actually called
        const { voiceHandler } = require('../voice') as typeof import('../voice')
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

    agent<TOutput = unknown>(agentConfig: AgentConfig<S, TOutput>): Agent<S, TOutput> {
      const normalizedOutput = normalizeOutput<S, TOutput>(schema, agentConfig.output)
      return createAgent<S, TOutput>({
        ...agentConfig,
        output: normalizedOutput,
        hooks: agentConfig.hooks ?? appHooks,
        errorHandlers: agentConfig.errorHandlers ?? appErrorHandlers,
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
      assertZod3Schema(toolConfig.schema, `app.tool('${toolConfig.name}')`)
      assertZod3Schema(toolConfig.yieldSchema, `app.tool('${toolConfig.name}')`)
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
      const members = registeredTools.map((t) =>
        z.object({
          callId: z.string(),
          toolName: z.literal(t.name),
          input: t.yieldSchema ?? z.unknown(),
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

      for (let attempt = 0; attempt <= budget; attempt++) {
        try {
          // Run on a FRESH BaseSession (no session passed → executeRun creates one via new BaseSession)
          const stream = executeRun(ephemeralAgent as unknown as Runnable<S>, { input: prompt })

          // Thread the abort signal into the inner stream
          if (opts?.signal) {
            if (opts.signal.aborted) {
              stream.abort()
            } else {
              opts.signal.addEventListener('abort', () => stream.abort(), { once: true })
            }
          }

          const result = await stream
          if (opts?.schema) {
            return result.output.value as T
          }
          return (result.output.text ?? '') as T
        } catch (e) {
          // Only OutputParseError is retried; provider/transport errors surface immediately.
          // We check both instanceof (direct throw path) and e.name === 'OutputParseError'
          // (channel-deserialized path where the class is reconstructed as a plain Error).
          const isParseError =
            e instanceof OutputParseError || (e instanceof Error && e.name === 'OutputParseError')
          if (isParseError && attempt < budget) {
            continue
          }
          throw e
        }
      }

      // Unreachable but TypeScript requires a return/throw here
      throw new Error('[adk] app.ask: unexpected end of retry loop')
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

    evaluate: Object.assign(
      (
        caseOrCases: EvalCase<S> | EvalCase<S>[],
        options?: EvalOptions<S>,
      ): Promise<EvalResult<S>> => {
        return runEval(app, caseOrCases, options)
      },
      {
        voice: Object.assign(
          (
            caseOrCases: VoiceEvalCase<S> | VoiceEvalCase<S>[],
            options?: VoiceEvalOptions<S>,
          ): Promise<VoiceEvalResult<S>> => {
            const { evaluateVoice } =
              require('../eval/voice/evaluate') as typeof import('../eval/voice/evaluate')
            return evaluateVoice(caseOrCases, {
              ...options,
              schema: options?.schema ?? schema,
            })
          },
          {
            case: (evalCase: VoiceEvalCase<S> | VoiceEvalCaseFactory<S>) => {
              const { createVoiceEvalCase } =
                require('../eval/voice/control') as typeof import('../eval/voice/control')
              return createVoiceEvalCase(evalCase)
            },
            cases: (evalCases: (VoiceEvalCase<S> | VoiceEvalCaseFactory<S>)[]) => {
              const { createVoiceEvalCase } =
                require('../eval/voice/control') as typeof import('../eval/voice/control')
              return evalCases.map(createVoiceEvalCase)
            },
            report:
              (options?: ReportOptions<S, VoiceEvalResult<S>>) =>
              (result: VoiceEvalResult<S>): string =>
                generateReport(result, options),
          },
        ),
        metric: (metric: Metric<MetricRun<S>>) => metric,
        case: (evalCase: EvalCase<S>) => evalCase,
        cases: (evalCases: EvalCase<S>[]) => evalCases,
        report:
          <R extends EvalResult<S> | VoiceEvalResult<S>>(options?: ReportOptions<S, R>) =>
          (result: R): string =>
            generateReport(result, options),
      },
    ),

    initialState: (state: StateChanges<S>) => state,

    cli(runnable: Runnable<S>, inputOrConfig?: string | CLIConfig): CLIHandle {
      const cliConfig: CLIConfig =
        typeof inputOrConfig === 'string' ? { input: inputOrConfig } : (inputOrConfig ?? {})

      cliConfig.runner ??= new BaseRunner({
        sessionService: cliConfig.sessionService ?? appSessionService,
        adapters: appAdapters,
        hooks: prepend(appHooks, cliConfig.options?.hooks),
        errorHandlers: appErrorHandlers,
      })
      cliConfig.session ??= new BaseSession(appName)

      // Lazy require to avoid loading React/Ink until cli() is actually called
      const { cli: runCli } = require('../cli') as typeof import('../cli')

      return runCli(runnable, cliConfig)
    },

    async close(): Promise<void> {
      await mcpManager.disconnect()
      await resolvedStore.close()
    },
  }

  return app
}
