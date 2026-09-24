import { randomUUID } from 'node:crypto'

import type { AdkApp } from '../api/app'
import type { ModelUsage } from '../types/events'
import type { StateSchema } from '../types/schema'
import type { Session, SessionService, SessionStore } from '../types/session'
import type { GPTLiveTranscript, GPTLiveTranscriptSnapshot } from './gpt-live-transcript'
import type {
  LiveCallUsage,
  LiveVoiceContext,
  LiveVoiceControls,
  LiveVoiceDelegation,
  LiveVoiceExitContext,
  LiveVoiceHandlerConfig,
  LiveVoiceHook,
} from './live-types'
import type { VoiceDeps } from './livekit-types'
import type { VoiceHandlerHandle } from './types'

import { buildLiveContextAsync } from '../context/build'
import { summarizeModelUsage } from '../core/runner'
import { resolveOpenAIConnection } from '../providers/openai-endpoints'
import { sumCosts, usageCost } from '../providers/pricing'
import { seedState } from '../session/seedState'
import { applySchemaDefaults } from '../types/schema'
import { openGPTLiveTranscript } from './gpt-live-transcript'
import { liveHistory, completedBackendWork } from './live-history'
import { seedLiveState, applyLiveState } from './live-state'
import { backendModelCalls, LiveVoiceMeter } from './live-usage'
import { defaultVoiceDeps } from './livekit-types'
import { terminateLiveKitCall } from './termination'

export type LiveVoiceAppContext<S extends StateSchema> = {
  app: AdkApp<S>
  store: SessionStore
  sessionService: SessionService
}

export type LiveVoiceJob = Pick<
  import('@livekit/agents').JobContext,
  'room' | 'connect' | 'waitForParticipant' | 'addShutdownCallback' | 'shutdown'
>

interface LiveDeps {
  agents(): typeof import('@livekit/agents')
  openai(): typeof import('@livekit/agents-plugin-openai')
  livekitServer: VoiceDeps['livekitServer']
  clock?: () => number
}

type LiveKitAgents = ReturnType<LiveDeps['agents']>
type GPTLiveRealtime = ReturnType<LiveDeps['openai']>['realtime']
type GPTLiveSession = InstanceType<GPTLiveRealtime['GPTLiveSession']>
type VoiceSession = InstanceType<LiveKitAgents['voice']['AgentSession']>

/** Handler configuration shared by every call the worker accepts. */
interface LiveRuntime<S extends StateSchema, T> {
  config: LiveVoiceHandlerConfig<S, T>
  app: AdkApp<S>
  store: SessionStore
  sessionService: SessionService
  deps: LiveDeps
  agents: LiveKitAgents
  realtime: GPTLiveRealtime
  hooks: LiveVoiceHook<S, T>[]
  timeout: number
}

const defaultDeps: LiveDeps = {
  agents: () => require('@livekit/agents'),
  openai: () => require('@livekit/agents-plugin-openai'),
  livekitServer: defaultVoiceDeps.livekitServer,
}

function exitContext<S extends StateSchema>(
  context: LiveVoiceContext<S>,
  usage: LiveCallUsage,
): LiveVoiceExitContext<S> {
  return {
    callId: context.callId,
    voice: context.voice,
    transcript: context.transcript,
    get session() {
      return context.session
    },
    get state() {
      return context.state
    },
    usage,
  }
}

class LivePersistenceError extends Error {
  constructor(cause: unknown) {
    super('Live call persistence failed', { cause })
  }
}

async function persist<V>(operation: () => Promise<V>): Promise<V> {
  try {
    return await operation()
  } catch (error) {
    throw new LivePersistenceError(error)
  }
}

async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** LiveKit passes its job context untyped; check the members the handler uses. */
function isLiveVoiceJob(value: unknown): value is LiveVoiceJob {
  return (
    typeof value === 'object' &&
    value !== null &&
    'room' in value &&
    typeof value.room === 'object' &&
    value.room !== null &&
    'connect' in value &&
    typeof value.connect === 'function' &&
    'waitForParticipant' in value &&
    typeof value.waitForParticipant === 'function' &&
    'addShutdownCallback' in value &&
    typeof value.addShutdownCallback === 'function' &&
    'shutdown' in value &&
    typeof value.shutdown === 'function'
  )
}

function liveInstructions<S extends StateSchema>(
  rendered: Awaited<ReturnType<typeof buildLiveContextAsync<S>>>,
): string {
  if (
    rendered.events.some((event) => event.type !== 'system') ||
    rendered.functionTools.length ||
    rendered.providerTools.length ||
    rendered.outputSchema ||
    rendered.outputMode ||
    rendered.toolChoice ||
    rendered.allowedTools
  )
    throw new Error(
      'Live agent context currently supports system instructions only; conversation history belongs to the backend',
    )
  return rendered.events
    .flatMap((event) => (event.type === 'system' ? [event.text] : []))
    .join('\n')
}

/** Hook context whose session and state follow the call's latest session. */
function liveContext<S extends StateSchema>(
  call: { readonly callId: string; readonly session: Session<S> },
  recorder: GPTLiveTranscript,
  voice: LiveVoiceControls,
): LiveVoiceContext<S> {
  return {
    callId: call.callId,
    transcript: recorder,
    voice,
    get session() {
      return call.session
    },
    get state() {
      return call.session.state
    },
  }
}

/** Subclasses the LiveKit agent class supplied at runtime so its lifecycle reaches the call. */
function createLiveAgent(
  Agent: LiveKitAgents['voice']['Agent'],
  call: { enter(duplexSession: unknown, recorder: GPTLiveTranscript): Promise<void>; stop(): void },
  recorder: GPTLiveTranscript,
  instructions: string,
) {
  return new (class extends Agent {
    override async onEnter() {
      await call.enter(this.duplexSession, recorder)
    }
    override async onExit() {
      call.stop()
    }
  })({ instructions, tools: {} })
}

/**
 * One accepted call. Delegations run one at a time through `queue`, so the call session has a
 * single workflow-state writer. `close()` finalizes the call once.
 */
class LiveCall<S extends StateSchema, T> {
  private readonly voiceSession: VoiceSession
  private stopped = false
  /** Set when close() stops waiting for backend work that ignored cancellation. */
  private abandoned = false
  /** A settled delegation's writes to the call session, which close() lets finish. */
  private transfer: Promise<void> | undefined
  private endRequested = false
  private endReason = 'disconnected'
  private participantIdentity: string | undefined
  private context: LiveVoiceContext<S> | undefined
  private transcript: GPTLiveTranscript | undefined
  private activeRun: { abort(): void } | undefined
  private queue = Promise.resolve()
  private closing: Promise<void> | undefined
  private readonly seen = new Set<string>()
  private callSession: Session<S> | undefined
  private readonly meter: LiveVoiceMeter
  /** Usage of every backend model call; `undefined` marks a call without reported usage. */
  private readonly backendCalls: Array<ModelUsage | undefined> = []

  constructor(
    private readonly runtime: LiveRuntime<S, T>,
    private readonly job: LiveVoiceJob,
  ) {
    const { name: model, kind: _kind, provider: _provider, ...options } = runtime.config.agent.model
    this.voiceSession = new runtime.agents.voice.AgentSession({
      llm: new runtime.realtime.GPTLiveModel({
        ...resolveOpenAIConnection(),
        ...options,
        model,
        delegation: 'client',
      }),
    })
    this.meter = new LiveVoiceMeter(model, runtime.deps.clock)
    this.voiceSession.on(runtime.agents.voice.AgentSessionEventTypes.MetricsCollected, (event) =>
      this.meter.observeMetrics(event.metrics),
    )
  }

  get session(): Session<S> {
    if (!this.callSession) throw new Error('Live call session is not ready')
    return this.callSession
  }

  get callId(): string {
    return this.session.id
  }

  async run(): Promise<void> {
    this.job.addShutdownCallback(() => {
      if (!this.stopped) this.endReason = 'worker-shutdown'
      return this.close()
    })
    this.voiceSession.on(this.runtime.agents.voice.AgentSessionEventTypes.Close, (event) =>
      this.onSessionClose(event.reason, event.error),
    )
    try {
      await this.start()
    } catch (error) {
      this.endRequested = true
      this.endReason = 'error'
      await this.close()
      throw error
    }
  }

  stop(): void {
    this.stopped = true
    this.activeRun?.abort()
  }

  async enter(duplexSession: unknown, recorder: GPTLiveTranscript): Promise<void> {
    try {
      if (!(duplexSession instanceof this.runtime.realtime.GPTLiveSession))
        throw new Error('Expected GPT Live session')
      const live = duplexSession
      recorder.attach(live)
      if (live.sessionId) this.meter.observeConnection(live.sessionId)
      live.on('openai_server_event_received', (event) =>
        this.meter.observeServerEvent(event, live.sessionId),
      )
      const entered = liveContext(this, recorder, this.controls(live))
      this.context = entered
      this.queue = this.queue.then(async () => {
        for (const hook of this.runtime.hooks) await hook.onEnter?.(entered)
        await this.commit(this.session)
      })
      live.on('delegation_created', (event) => this.admit(live, recorder, event.id))
      await this.queue
    } catch (error) {
      this.requestEnd('error')
      throw error
    }
  }

  private async start(): Promise<void> {
    const { app, config, store } = this.runtime
    await this.job.connect()
    const participant = await this.job.waitForParticipant()
    if (this.stopped) return
    this.participantIdentity = participant.identity
    const setup = await config.setup?.(participant)
    if (this.stopped) return
    if (setup?.recordingKey || setup?.noiseCancellation)
      throw new Error('Live setup does not support recordingKey or noiseCancellation yet')
    const callSession = await persist(() =>
      app.sessions.create({ sessionId: setup?.sessionId, scopes: setup?.scopes }),
    )
    seedState(callSession, {
      session: applySchemaDefaults(setup?.state ?? {}, app.schema?.session),
    })
    if (setup?.initialState) seedState(callSession, setup.initialState, app.schema)
    this.callSession = callSession
    await this.commit(callSession)
    if (this.stopped) return
    const recorder = await persist(() =>
      openGPTLiveTranscript({
        callId: callSession.id,
        store,
        checkpointMs: 500,
        onError: (error) => this.onTranscriptError(error),
      }),
    )
    this.transcript = recorder
    if (this.stopped) {
      await recorder.close()
      return
    }
    const rendered = await buildLiveContextAsync(callSession, config.agent, callSession.id)
    if (this.stopped) return
    const agent = createLiveAgent(
      this.runtime.agents.voice.Agent,
      this,
      recorder,
      liveInstructions(rendered),
    )
    this.meter.start()
    await this.voiceSession.start({
      agent,
      room: this.job.room,
      inputOptions: { participantIdentity: this.participantIdentity },
    })
  }

  private controls(
    live: GPTLiveSession,
    delegation?: LiveVoiceDelegation,
    active = () => true,
  ): LiveVoiceControls {
    const usable = () =>
      !this.stopped && active() && (!delegation || live.sessionId === delegation.connectionId)
    return {
      end: () => {
        if (usable()) this.requestEnd()
      },
      appendThinking: (text) => {
        if (usable()) live.appendThinking(text, { delegationId: delegation?.id })
      },
      appendCommentary: (text) => {
        if (usable()) live.appendCommentary(text, { delegationId: delegation?.id })
      },
      appendInstructions: (text) => {
        if (usable()) live.appendInstructions(text, { delegationId: delegation?.id })
      },
    }
  }

  /** Freezes the transcript snapshot synchronously, then queues the delegation. */
  private admit(live: GPTLiveSession, recorder: GPTLiveTranscript, delegationId: string): void {
    const connectionId = live.sessionId
    if (!connectionId || this.stopped) return
    const key = `${connectionId}/${delegationId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const snapshot = recorder.snapshot()
    const delegation: LiveVoiceDelegation = {
      id: delegationId,
      connectionId,
      nativeThrough: snapshot.receivedThrough,
    }
    let active = true
    const voice = this.controls(live, delegation, () => active)
    this.queue = this.queue
      .then(() => this.execute(live, recorder, delegation, snapshot, voice))
      .catch((error) => this.onDelegationError(error, recorder, delegation, voice))
      .finally(() => {
        active = false
      })
  }

  private async execute(
    live: GPTLiveSession,
    recorder: GPTLiveTranscript,
    delegation: LiveVoiceDelegation,
    snapshot: GPTLiveTranscriptSnapshot,
    voice: LiveVoiceControls,
  ): Promise<void> {
    const { app, config, sessionService, timeout, hooks } = this.runtime
    if (this.stopped || live.sessionId !== delegation.connectionId) return
    if (recorder.status === 'ambiguous')
      throw new LivePersistenceError(new Error('Conflicting Live transcript observations'))
    await persist(() => recorder.checkpoint())
    if (this.stopped) return
    const session = await persist(() => app.sessions.create({ scopes: this.session.scopes }))
    await sessionService.appendEvent(session, {
      id: randomUUID(),
      type: 'annotation',
      kind: 'mark',
      label: 'live-delegation',
      createdAt: Date.now(),
      invocationId: session.id,
      agentName: config.agent.name,
      data: { callId: this.callId, delegation, transcriptThrough: snapshot.receivedThrough },
    })
    for (const historyEvent of liveHistory(this.session.events, snapshot, config.backend.name))
      await sessionService.appendEvent(session, structuredClone(historyEvent))
    const stateStart = seedLiveState(this.session, session)
    await this.commit(session)
    if (this.stopped) return
    const workStart = session.events.length
    const run = app.run(config.backend, { session, timeout, voice })
    this.activeRun = run
    let result: Awaited<typeof run>
    try {
      result = await run
    } finally {
      run.abort()
      await run.settled
      this.activeRun = undefined
      // Usage is final once close() abandons this work; it was recorded as unknown then.
      if (!this.abandoned)
        this.backendCalls.push(...backendModelCalls(session.events.slice(workStart)))
      await this.commit(session)
      // A call finalized without this work keeps its ledger closed.
      if (!this.abandoned) {
        this.transfer = this.transferBackendWork(
          recorder,
          delegation,
          snapshot,
          session,
          stateStart,
          workStart,
        )
        try {
          await this.transfer
        } finally {
          this.transfer = undefined
        }
      }
    }
    if (this.stopped || live.sessionId !== delegation.connectionId) return
    if (result.status !== 'completed') throw new Error(`Live backend ended with ${result.status}`)
    if (result.output.value === undefined)
      throw new Error('Live backend completed without an output value')
    try {
      for (const hook of hooks)
        await hook.onResult?.({
          ...liveContext(this, recorder, voice),
          delegation,
          backendSession: session,
          output: result.output.value,
        })
    } finally {
      await this.commit(this.session)
    }
  }

  /** Reloads the call owner, applies the backend's state changes and records its settled work. */
  private async transferBackendWork(
    recorder: GPTLiveTranscript,
    delegation: LiveVoiceDelegation,
    snapshot: GPTLiveTranscriptSnapshot,
    session: Session<S>,
    stateStart: ReturnType<typeof seedLiveState>,
    workStart: number,
  ): Promise<void> {
    const { app, config, sessionService } = this.runtime
    const callId = this.callId
    const callSession = await persist(async () => {
      const saved = await app.sessions.get(callId)
      if (!saved) throw new Error('Live call state is missing')
      return saved
    })
    this.callSession = callSession
    applyLiveState(session, callSession, stateStart)
    const work = completedBackendWork(session.events.slice(workStart))
    const batch = {
      backendSessionId: session.id,
      delegationId: delegation.id,
      transcriptThrough: snapshot.receivedThrough,
      receiptThroughAtCompletion: recorder.receivedThrough,
      unresolved: work.unresolved,
    }
    await sessionService.appendEvent(callSession, {
      id: `${session.id}/backend-work`,
      type: 'annotation',
      kind: 'mark',
      label: 'live-backend-work',
      createdAt: Date.now(),
      invocationId: '',
      agentName: config.backend.name,
      data: batch,
    })
    await sessionService.appendEvent(callSession, {
      id: `${session.id}/backend-work-context`,
      type: 'system',
      text: `Prior backend work for delegation ${delegation.id}, based on transcript receipt ${snapshot.receivedThrough}, settled at receipt ${batch.receiptThroughAtCompletion}. Work may postdate the frozen voice snapshot and does not imply the caller heard it.${work.unresolved.length ? ` Unresolved tool calls with unknown outcome; do not assume failure or retry automatically: ${work.unresolved.map((call) => `${call.name} (${call.callId})`).join(', ')}.` : ''}`,
      createdAt: Date.now(),
      invocationId: '',
      agentName: config.backend.name,
    })
    for (const completed of work.events) await sessionService.appendEvent(callSession, completed)
    await this.commit(callSession)
  }

  private async onDelegationError(
    error: unknown,
    recorder: GPTLiveTranscript,
    delegation: LiveVoiceDelegation,
    voice: LiveVoiceControls,
  ): Promise<void> {
    if (this.abandoned) {
      this.log(
        { callId: this.callId, delegationId: delegation.id },
        'Late Live backend work failed',
      )
      return
    }
    if (this.stopped && !(error instanceof LivePersistenceError)) return
    await this.reportError(error, { ...liveContext(this, recorder, voice), delegation })
  }

  private onTranscriptError(error: Error): void {
    if (this.stopped) return
    this.stop()
    const current = this.context
    if (current)
      this.queue = this.queue.then(() => this.reportError(new LivePersistenceError(error), current))
    this.requestEnd('error')
  }

  private onSessionClose(reason: string, error: unknown): void {
    if (error) {
      this.requestEnd('error')
      return
    }
    if (!this.endRequested) this.endReason = reason
    this.stop()
    this.closeInBackground()
  }

  private async commit(session: Session<S>): Promise<void> {
    await persist(async () => {
      if (!(await this.runtime.app.sessions.commit(session)).ok)
        throw new Error('Live session commit conflict')
    })
  }

  private requestEnd(reason = 'agent-ended'): void {
    if (this.endRequested) return
    this.endRequested = true
    this.endReason = reason
    this.stop()
    this.closeInBackground()
  }

  private closeInBackground(): void {
    void this.close().catch(() =>
      this.log({ callId: this.context?.callId }, 'Live call cleanup failed'),
    )
  }

  private close(): Promise<void> {
    return (this.closing ??= this.finalize())
  }

  private async finalize(): Promise<void> {
    this.stop()
    let backendSettled = await settlesWithin(this.queue, this.runtime.timeout)
    if (!backendSettled) {
      this.abandoned = true
      // The unsettled run's model calls are unknown, so backend cost cannot be complete.
      this.backendCalls.push(undefined)
      // Settled work already being recorded may finish first, within a second bound.
      const transfer = this.transfer
      if (transfer)
        backendSettled =
          (await settlesWithin(transfer, this.runtime.timeout)) &&
          (await transfer.then(
            () => true,
            () => false,
          ))
      if (!backendSettled)
        this.log({ callId: this.context?.callId }, 'Live backend work did not settle before close')
    }
    try {
      await this.closeVoice(backendSettled)
    } finally {
      try {
        await this.exitHooks()
      } finally {
        if (this.endRequested)
          await terminateLiveKitCall({
            config: this.runtime.config.callTermination,
            deps: this.runtime.deps,
            ctx: this.job,
            participantIdentity: this.participantIdentity,
            onVoiceEvent: () =>
              this.log({ callId: this.context?.callId }, 'Live call termination failed'),
          })
      }
    }
  }

  /** Closes voice and transcript capture, then records how the call ended. */
  private async closeVoice(backendSettled: boolean): Promise<void> {
    try {
      await this.voiceSession.close()
    } finally {
      this.meter.stop()
      try {
        await this.transcript?.close()
      } finally {
        const context = this.context
        if (context) {
          await this.runtime.sessionService.appendEvent(context.session, {
            id: randomUUID(),
            type: 'annotation',
            kind: 'mark',
            label: 'live-call-ended',
            createdAt: Date.now(),
            invocationId: context.callId,
            agentName: this.runtime.config.agent.name,
            data: backendSettled
              ? { reason: this.endReason }
              : { reason: this.endReason, backendSettled },
          })
          await this.commit(context.session)
        }
      }
    }
  }

  private async exitHooks(): Promise<void> {
    const context = this.context
    if (!context) return
    try {
      const exit = exitContext(context, this.usage())
      for (const hook of this.runtime.hooks) await hook.onExit?.(exit)
    } finally {
      await this.commit(context.session)
    }
  }

  private usage(): LiveCallUsage {
    const usage = summarizeModelUsage(this.backendCalls)
    const backend = { ...(usage && { usage }), cost: usageCost(usage) }
    const voice = this.meter.usage()
    return { backend, voice, total: sumCosts([backend.cost, voice.cost]) }
  }

  private async reportError(
    error: unknown,
    errorContext: LiveVoiceContext<S> & { delegation?: LiveVoiceDelegation },
  ): Promise<void> {
    const recoverable = !(error instanceof LivePersistenceError) && !this.stopped
    if (!recoverable) this.stop()
    this.log(
      { callId: errorContext.callId, delegationId: errorContext.delegation?.id, recoverable },
      'Live backend or persistence failed',
    )
    try {
      let handled = false
      let terminate = false
      for (const hook of this.runtime.hooks) {
        const decision = await hook.onError?.({ ...errorContext, error, recoverable })
        handled ||= decision === 'continue'
        terminate ||= decision === 'end'
      }
      if (recoverable) await this.commit(errorContext.session)
      if (!recoverable || !handled || terminate) this.requestEnd('error')
    } catch {
      this.log({ callId: errorContext.callId }, 'Live error recovery failed')
      this.requestEnd('error')
    }
  }

  private log(data: Record<string, unknown>, message: string): void {
    this.runtime.agents.log().error(data, message)
  }
}

/** @internal Selected by app.handler.voice for openai.live models. */
export function createLiveVoiceHandler<S extends StateSchema, T>(
  config: LiveVoiceHandlerConfig<S, T>,
  appContext: LiveVoiceAppContext<S>,
  deps: LiveDeps = defaultDeps,
): VoiceHandlerHandle {
  const agents = deps.agents()
  const { realtime } = deps.openai()
  if (!realtime.GPTLiveModel)
    throw new Error('openai.live requires LiveKit agents and OpenAI plugin 1.9 or later')
  const hooks = config.hooks ?? []
  if (!hooks.some((hook) => hook.onResult))
    throw new Error('Live voice requires an onResult hook to handle backend output')
  const timeout = config.backendTimeoutMs ?? 30_000
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('backendTimeoutMs must be positive')
  const runtime: LiveRuntime<S, T> = {
    config,
    ...appContext,
    deps,
    agents,
    realtime,
    hooks,
    timeout,
  }

  const handler: VoiceHandlerHandle = {
    prewarm: config.prewarm,
    start(entryFile) {
      if (process.send) return
      agents.cli.runApp(
        new agents.ServerOptions({
          agent: entryFile,
          agentName: config.name ?? config.agent.name,
          shutdownProcessTimeout: 60_000,
          ...config.worker,
        }),
      )
    },
    async entry(rawCtx) {
      if (!isLiveVoiceJob(rawCtx))
        throw new Error('Live voice entry requires a LiveKit job context')
      await new LiveCall(runtime, rawCtx).run()
    },
  }
  agents.defineAgent(handler)
  return handler
}
