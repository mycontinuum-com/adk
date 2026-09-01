import type { WorkflowRunnerConfig } from '../agents/config'
import type { EventChannel } from '../channels/types'
import type { ErrorHandler } from '../errors/types'
import type { Hook } from '../hook/types'
import type {
  StreamEvent,
  HandoffOrigin,
  InvocationStartEvent,
  ModelEndEvent,
  Event,
  AssistantEvent,
} from '../types/events'
import type {
  Runnable,
  Agent,
  ModelAdapter,
  ModelConfig,
  Provider,
  SubRunConfig,
} from '../types/runnables'
import type {
  RunConfig,
  RunResult,
  Output,
  StreamResult,
  Runner,
  UsageSummary,
  ModelUsageEntry,
} from '../types/runtime'
import type { InternalRunConfig } from '../types/runtime'
import type { ErasedStateSchema } from '../types/schema'
import type { Session, SessionService } from '../types/session'
import type { ResumeContext } from './invocation'

import { runLoop, type LoopResumeContext } from '../agents/loop'
import { runParallel, type ParallelResumeContext } from '../agents/parallel'
import { runAgent } from '../agents/reasoning'
import { runSequence, type SequenceResumeContext } from '../agents/sequential'
import { runStep, type StepResumeContext } from '../agents/step'
import { InMemoryChannel } from '../channels/inMemory'
import { PipelineStructureChangedError } from '../errors/pipeline'
import { composeHooks } from '../hook/compose'
import { isRealtimeConfig, getModelProvider } from '../providers/models'
import { calculateCost } from '../providers/pricing'
import { BaseSession } from '../session'
import { computePipelineFingerprint } from '../session/fingerprint'
import { InMemoryStore } from '../session/memory'
import { computeResumeContext, type RunnableResumeContext } from '../session/resume/context'
import { sessionService } from '../session/service'
import { ADAPTER, REALTIME_ADAPTER, getSymbol } from './adapter-symbol'

/** Prevents executing against a session started with a different agent configuration. */
function validatePipelineFingerprint(session: Session, currentFingerprint: string): void {
  const rootInvocationStart = session.events.find(
    (e): e is InvocationStartEvent => e.type === 'invocation_start' && !e.parentInvocationId,
  )
  const storedFingerprint = rootInvocationStart?.fingerprint

  if (storedFingerprint && storedFingerprint !== currentFingerprint) {
    throw new PipelineStructureChangedError(session.id, storedFingerprint, currentFingerprint)
  }
}

function computeUsageSummary(events: readonly Event[]): UsageSummary | undefined {
  const modelEndEvents = events.filter(
    (e): e is ModelEndEvent => e.type === 'model_end' && e.usage !== undefined,
  )

  if (modelEndEvents.length === 0) return undefined

  const byModel = new Map<
    string,
    {
      calls: number
      inputTokens: number
      outputTokens: number
      cachedTokens: number
      cacheWriteTokens: number
      reasoningTokens: number
      audioInputTokens: number
      audioOutputTokens: number
      inputCost: number
      outputCost: number
      hasCost: boolean
    }
  >()

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCachedTokens = 0
  let totalCacheWriteTokens = 0
  let totalReasoningTokens = 0
  let totalAudioInputTokens = 0
  let totalAudioOutputTokens = 0
  let totalInputCost = 0
  let totalOutputCost = 0
  let hasCostData = false

  for (const event of modelEndEvents) {
    const u = event.usage!
    const input = u.inputTokens
    const output = u.outputTokens
    const cached = u.cachedTokens ?? 0
    const cacheWrite = u.cacheWriteTokens ?? 0
    const reasoning = u.reasoningTokens ?? 0
    const audioIn = u.audioInputTokens ?? 0
    const audioOut = u.audioOutputTokens ?? 0

    totalInputTokens += input
    totalOutputTokens += output
    totalCachedTokens += cached
    totalCacheWriteTokens += cacheWrite
    totalReasoningTokens += reasoning
    totalAudioInputTokens += audioIn
    totalAudioOutputTokens += audioOut

    const cost = calculateCost(u)
    if (cost) {
      totalInputCost += cost.inputCost
      totalOutputCost += cost.outputCost
      hasCostData = true
    }

    const name = u.modelName ?? 'unknown'
    let entry = byModel.get(name)
    if (!entry) {
      entry = {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        inputCost: 0,
        outputCost: 0,
        hasCost: false,
      }
      byModel.set(name, entry)
    }
    entry.calls++
    entry.inputTokens += input
    entry.outputTokens += output
    entry.cachedTokens += cached
    entry.cacheWriteTokens += cacheWrite
    entry.reasoningTokens += reasoning
    entry.audioInputTokens += audioIn
    entry.audioOutputTokens += audioOut
    if (cost) {
      entry.inputCost += cost.inputCost
      entry.outputCost += cost.outputCost
      entry.hasCost = true
    }
  }

  const models: ModelUsageEntry[] = []
  for (const [modelName, e] of byModel) {
    models.push({
      modelName,
      calls: e.calls,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cachedTokens: e.cachedTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      reasoningTokens: e.reasoningTokens,
      audioInputTokens: e.audioInputTokens,
      audioOutputTokens: e.audioOutputTokens,
      ...(e.hasCost && {
        cost: {
          inputCost: e.inputCost,
          outputCost: e.outputCost,
          totalCost: e.inputCost + e.outputCost,
          currency: 'USD' as const,
        },
      }),
    })
  }

  const totalCost = totalInputCost + totalOutputCost

  return {
    models,
    totalInputTokens,
    totalOutputTokens,
    totalCachedTokens,
    totalCacheWriteTokens,
    totalReasoningTokens,
    totalAudioInputTokens,
    totalAudioOutputTokens,
    modelCalls: modelEndEvents.length,
    ...(hasCostData && {
      cost: {
        inputCost: totalInputCost,
        outputCost: totalOutputCost,
        totalCost,
        currency: 'USD' as const,
      },
    }),
  }
}

function computeOutput<TOutput>(
  events: readonly Event[],
  structuredValue?: TOutput,
): Output<TOutput> {
  const assistantEvents = events.filter((e): e is AssistantEvent => e.type === 'assistant')
  const lastAssistant = assistantEvents[assistantEvents.length - 1]
  const allMedia = assistantEvents.flatMap((e) => e.media ?? [])

  return {
    text: lastAssistant?.text,
    value: structuredValue,
    items: assistantEvents,
    media: allMedia.length > 0 ? allMedia : undefined,
  }
}

export function createStreamResult<T>(
  generator: AsyncGenerator<StreamEvent, T>,
  abortController: AbortController,
): StreamResult<T> {
  let consumed = false
  let cachedPromise: Promise<T> | undefined

  const consumeGenerator = async (): Promise<T> => {
    let iterResult = await generator.next()
    while (!iterResult.done) {
      iterResult = await generator.next()
    }
    return iterResult.value
  }

  const getPromise = (): Promise<T> => {
    if (cachedPromise) return cachedPromise
    consumed = true
    cachedPromise = consumeGenerator()
    return cachedPromise
  }

  const iterable: StreamResult<T> = {
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error('Stream already consumed')
      }
      consumed = true
      return generator
    },
    // oxlint-disable-next-line eslint-plugin-unicorn(no-thenable)
    then(onFulfilled, onRejected) {
      return getPromise().then(onFulfilled, onRejected)
    },
    abort() {
      abortController.abort()
    },
  }

  return iterable
}

function withTimeout<T>(
  generator: AsyncGenerator<StreamEvent, T>,
  timeoutMs: number,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
  })

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId)
  }
  signal.addEventListener('abort', cleanup)

  return (async function* (): AsyncGenerator<StreamEvent, T> {
    try {
      let result = await Promise.race([generator.next(), timeoutPromise])
      while (!result.done) {
        yield result.value
        result = await Promise.race([generator.next(), timeoutPromise])
      }
      cleanup()
      return result.value
    } catch (error) {
      cleanup()
      throw error
    }
  })()
}

export interface BaseRunnerConfig {
  sessionService?: SessionService
  adapters?: Map<Provider, ModelAdapter> | Partial<Record<Provider, ModelAdapter>>
  hooks?: Hook<ErasedStateSchema>[]
  errorHandlers?: ErrorHandler[]
}

/**
 * Executes runnables (agents, sequences, loops, etc.) and manages their lifecycle. Holds no mutable
 * state between run() calls — safe to call concurrently with different sessions. Each call owns its
 * event channel and abort controller. Session is shared mutable state; callers are responsible for
 * isolation.
 */
export class BaseRunner implements Runner {
  private sessionService: SessionService
  private adapters: Map<Provider, ModelAdapter> | null
  private adapterConfig?: Partial<Record<Provider, ModelAdapter>>
  private realtimeAdapters = new Map<Provider, ModelAdapter>()
  private agentRegistry = new Map<string, Agent>()
  readonly hooks: readonly Hook<ErasedStateSchema>[]
  readonly errorHandlers: readonly ErrorHandler[]

  constructor(config?: BaseRunnerConfig) {
    this.sessionService = config?.sessionService ?? sessionService(new InMemoryStore())
    this.hooks = config?.hooks ?? []
    this.errorHandlers = config?.errorHandlers ?? []

    if (config?.adapters) {
      if (config.adapters instanceof Map) {
        this.adapters = config.adapters
      } else {
        this.adapters = null
        this.adapterConfig = config.adapters
      }
    } else {
      this.adapters = null
    }
  }

  getAgent(name: string): Agent | undefined {
    return this.agentRegistry.get(name)
  }

  private async getAdapter(config: ModelConfig): Promise<ModelAdapter> {
    const provider = getModelProvider(config)
    const custom = this.adapterConfig?.[provider]
    if (custom) return custom

    if (isRealtimeConfig(config) && !(config.stt && config.tts)) {
      let rtAdapter = this.realtimeAdapters.get(provider)
      if (rtAdapter) return rtAdapter

      const rtFactory = getSymbol<() => ModelAdapter>(config, REALTIME_ADAPTER)
      if (rtFactory) {
        rtAdapter = rtFactory()
      } else {
        rtAdapter = await this.loadRealtimeAdapter(provider)
      }
      this.realtimeAdapters.set(provider, rtAdapter)
      return rtAdapter
    }

    if (!this.adapters) {
      this.adapters = new Map<Provider, ModelAdapter>()
      if (this.adapterConfig) {
        for (const [p, adapter] of Object.entries(this.adapterConfig)) {
          if (adapter) this.adapters.set(p as Provider, adapter)
        }
      }
    }

    let adapter = this.adapters.get(provider)
    if (!adapter) {
      const factory = getSymbol<() => ModelAdapter>(config, ADAPTER)
      if (factory) {
        adapter = factory()
      } else {
        adapter = await this.loadAdapter(provider)
      }
      this.adapters.set(provider, adapter)
    }
    return adapter
  }

  private async loadAdapter(provider: Provider): Promise<ModelAdapter> {
    switch (provider) {
      case 'openai':
        return new (await import('../providers/openai.js')).OpenAIAdapter()
      case 'gemini':
        return new (await import('../providers/gemini.js')).GeminiAdapter()
      case 'claude':
        return new (await import('../providers/claude.js')).ClaudeAdapter()
      default:
        throw new Error(
          `No adapter for provider '${provider}'. Import '@animahealth/adk/${provider}' to use it.`,
        )
    }
  }

  private async loadRealtimeAdapter(provider: Provider): Promise<ModelAdapter> {
    switch (provider) {
      case 'openai':
        return new (await import('../providers/openai-realtime.js')).OpenAIRealtimeTextAdapter()
      case 'gemini':
        return new (await import('../providers/gemini-realtime.js')).GeminiRealtimeTextAdapter()
      default:
        throw new Error(
          `Realtime adapter for '${provider}' is not available. Import '@animahealth/adk/${provider}' to use it.`,
        )
    }
  }

  run(runnable: Runnable<ErasedStateSchema>, session: Session, config?: RunConfig): StreamResult {
    const abortController = new AbortController()
    const eventChannel = new InMemoryChannel()

    const runnableHooks = runnable.kind === 'agent' ? (runnable.hooks ?? []) : []
    const callSiteHooks = config?.hooks ?? []
    // Composition order: app hooks (outermost) → agent hooks → call-site hooks (innermost)
    const composed = composeHooks([...this.hooks, ...runnableHooks, ...callSiteHooks])

    const mergedOnStream = (event: StreamEvent) => {
      composed.onEvent?.(event)
    }

    const mergedConfig: InternalRunConfig = {
      ...config,
      onStream: mergedOnStream,
      onStep: composed.onStep,
    }

    if (mergedConfig.onStream) {
      session.onStateChange((event) => {
        mergedConfig.onStream!(event)
      })
    }

    let resumeContext = computeResumeContext(session.events, runnable)
    if (!resumeContext && config?.invocationId) {
      resumeContext = { invocationId: config.invocationId, yieldIndex: -1 }
    }
    const currentFingerprint = computePipelineFingerprint(runnable)

    if (resumeContext) {
      validatePipelineFingerprint(session, currentFingerprint)
    }

    const mainGenerator = this.execute(
      runnable,
      session,
      mergedConfig,
      abortController.signal,
      undefined,
      resumeContext,
      undefined,
      undefined,
      currentFingerprint,
      eventChannel,
    )

    eventChannel.registerGenerator('main', mainGenerator, true)

    abortController.signal.addEventListener('abort', () => {
      eventChannel.abort('Aborted')
    })

    let generator = this.wrapChannelWithResult(
      eventChannel.events(),
      session,
      runnable,
      config?.timeout,
      abortController.signal,
    )

    return createStreamResult(generator, abortController)
  }

  async runToChannel(
    runnable: Runnable<ErasedStateSchema>,
    session: Session,
    channel: EventChannel,
    config?: RunConfig & SubRunConfig,
  ): Promise<RunResult> {
    const mergedConfig: InternalRunConfig = {
      ...config,
      onStream: (event) => {
        channel.push(event)
      },
    }

    const resumeContext = computeResumeContext(session.events, runnable)
    const currentFingerprint = computePipelineFingerprint(runnable)

    const generator = this.execute(
      runnable,
      session,
      mergedConfig,
      new AbortController().signal,
      config?.id,
      resumeContext,
      config?.managed,
      undefined,
      currentFingerprint,
      channel,
    )

    if (channel.registerGenerator) {
      const { result, error } = await channel.registerGenerator(
        config?.id ?? 'runToChannel',
        generator,
      )
      if (error) throw error
      return result as RunResult
    }

    let iterResult = await generator.next()
    while (!iterResult.done) {
      channel.push(iterResult.value)
      iterResult = await generator.next()
    }

    return iterResult.value
  }

  private async *wrapChannelWithResult(
    channelEvents: AsyncGenerator<StreamEvent>,
    session: Session,
    runnable: Runnable<ErasedStateSchema>,
    timeout?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, RunResult> {
    let generator: AsyncGenerator<StreamEvent> = channelEvents

    if (timeout && signal) {
      generator = withTimeout(channelEvents, timeout, signal)
    }

    let result = await generator.next()
    while (!result.done) {
      yield result.value
      result = await generator.next()
    }

    const channelResult = result.value

    if (channelResult.thrownError) {
      throw channelResult.thrownError
    }

    if (channelResult.aborted) {
      throw new Error(channelResult.abortReason ?? 'Aborted')
    }

    const mainResult = channelResult.mainResult

    if (!mainResult) {
      const abortOutput = computeOutput(session.events)
      return {
        session,
        state: session.state,
        iterations: 0,
        runnable,
        status: 'aborted',
        output: abortOutput,
      }
    }

    const resolvedOutput = mainResult.output ?? computeOutput(session.events)
    const base = {
      runnable,
      session,
      state: session.state,
      iterations: mainResult.iterations,
      usage: computeUsageSummary(session.events),
      output: resolvedOutput,
    }

    switch (mainResult.status) {
      case 'completed':
        return { ...base, status: 'completed' }
      case 'error':
        return {
          ...base,
          status: 'error',
          error: mainResult.error ?? 'Unknown error',
        }
      case 'yielded_message':
        return {
          ...base,
          status: 'yielded_message',
          yieldedInvocationId: mainResult.yieldedInvocationId ?? '',
        }
      case 'yielded_tool': {
        const yieldedTools = mainResult.yieldedTools ?? []
        return {
          ...base,
          status: 'yielded_tool',
          yieldedTools,
        }
      }
      case 'max_steps':
        return { ...base, status: 'max_steps' }
      case 'max_turns':
        return { ...base, status: 'max_turns' }
      case 'max_duration':
        return { ...base, status: 'max_duration' }
      case 'inactivity_timeout':
        return { ...base, status: 'inactivity_timeout' }
      default:
        return { ...base, status: 'aborted' }
    }
  }

  private async *execute(
    runnable: Runnable<ErasedStateSchema>,
    session: Session,
    config: InternalRunConfig | undefined,
    signal: AbortSignal,
    parentInvocationId?: string,
    resumeContext?: RunnableResumeContext,
    managed?: boolean,
    handoffOrigin?: HandoffOrigin,
    fingerprint?: string,
    channel?: EventChannel,
  ): AsyncGenerator<StreamEvent, RunResult> {
    const subRunner = {
      run: (
        subRunnable: Runnable<ErasedStateSchema>,
        subParentInvocationId?: string,
        subConfig?: SubRunConfig,
      ) =>
        this.execute(
          subRunnable,
          session,
          config,
          signal,
          subParentInvocationId,
          subConfig?.id ? { invocationId: subConfig.id, yieldIndex: -1 } : undefined,
          subConfig?.managed,
          subConfig?.handoffOrigin,
          undefined,
          channel,
        ),
    }

    const workflowConfig: WorkflowRunnerConfig = {
      sessionService: this.sessionService,
      run: this.execute.bind(this),
      subRunner,
      onStream: config?.onStream,
      signal,
      fingerprint,
      channel,
    }

    if (runnable.kind === 'agent') {
      this.agentRegistry.set(runnable.name, runnable)
    }

    switch (runnable.kind) {
      case 'agent': {
        // Recorded before the agent runs so a transfer can resolve the invocation_start this run
        // appended, rather than an earlier run's in a multi-run session.
        const initialEventCount = session.events.length

        const agentResult = yield* runAgent(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          {
            sessionService: this.sessionService,
            getAdapter: this.getAdapter.bind(this),
            runnerHooks: this.hooks,
            runnerErrorHandlers: this.errorHandlers,
            subRunner,
            runConfig: config,
            signal,
            managed,
            handoffOrigin,
            fingerprint,
            channel,
          },
          resumeContext as ResumeContext | undefined,
        )

        if (agentResult.status === 'transferred' && agentResult.transfer) {
          const { agent: targetAgent, invocationId: toInvocationId } = agentResult.transfer

          const fromInvocationId =
            session.events.slice(initialEventCount).find((e) => e.type === 'invocation_start')
              ?.invocationId ?? ''

          ;(session as BaseSession).inheritTempState(fromInvocationId, toInvocationId)

          const transferOrigin: HandoffOrigin = {
            type: 'transfer',
            invocationId: fromInvocationId,
            agentName: runnable.name,
          }

          return yield* this.execute(
            targetAgent,
            session,
            config,
            signal,
            undefined,
            { invocationId: toInvocationId, yieldIndex: -1 },
            false,
            transferOrigin,
          )
        }

        return agentResult
      }
      case 'sequence':
        return yield* runSequence(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as SequenceResumeContext | undefined,
        )
      case 'parallel':
        return yield* runParallel(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as ParallelResumeContext | undefined,
        )
      case 'loop':
        return yield* runLoop(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as LoopResumeContext | undefined,
        )
      case 'step':
        return yield* runStep(
          runnable,
          session,
          config,
          signal,
          parentInvocationId,
          workflowConfig,
          resumeContext as StepResumeContext | undefined,
        )
    }
  }
}
