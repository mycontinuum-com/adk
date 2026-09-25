import { randomUUID } from 'node:crypto'

import type { AdkApp } from '../api/app'
import type { ModelUsage } from '../types/events'
import type { StateSchema } from '../types/schema'
import type { Session, SessionService, SessionStore } from '../types/session'
import type { GPTLiveTranscript, GPTLiveTranscriptSnapshot } from './gpt-live-transcript'
import type { GPTLiveRealtime, GPTLiveSession } from './live-model'
import type {
  LiveCallUsage,
  LiveVoiceContext,
  LiveVoiceControls,
  LiveVoiceDelegation,
  LiveVoiceHandlerConfig,
  LiveVoiceHook,
} from './live-types'
import type { VoiceDeps } from './livekit-types'
import type { VoiceHandlerHandle } from './types'

import { summarizeModelUsage } from '../core/runner'
import {
  loadPricing,
  RESULT_PRICING_WAIT_MS,
  sumCosts,
  usageCost,
  type PricingCatalog,
} from '../providers/pricing'
import { seedState } from '../session/seedState'
import { applySchemaDefaults } from '../types/schema'
import { createGPTLiveTranscript } from './gpt-live-transcript'
import { createInactivityTimer } from './inactivity'
import { LiveActivity } from './live-activity'
import { liveHistory, completedBackendWork } from './live-history'
import { createGPTLiveModel, renderLiveInstructions, requireGPTLive } from './live-model'
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
  openai(): { realtime: GPTLiveRealtime }
  livekitServer: VoiceDeps['livekitServer']
  clock?: () => number
  /** Agent quiet that ends a turn; tests shorten it. */
  lineSettleMs?: number
  /** How long earlier commentary counts as still to be said; tests shorten it. */
  commentaryStartMs?: number
}

type LiveKitAgents = ReturnType<LiveDeps['agents']>
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
  playoutTimeout: number
}

/** Longest wait for a line to be spoken before a muted caller is heard again or the call ends. */
const PLAYOUT_TIMEOUT_MS = 30_000

/**
 * How long ordinary commentary counts as still to be said. Across 587 stored commentary lines given
 * while GPT Live was quiet, speech started within 750 ms at p90 and 10.4 s at most, and 3 lines
 * were never spoken. Past this bound a line is not waited for, so an unspoken one delays the next
 * uninterruptible line by at most this long.
 */
const COMMENTARY_START_MS = 12_000

const defaultDeps: LiveDeps = {
  agents: () => require('@livekit/agents'),
  openai: () => require('@livekit/agents-plugin-openai'),
  livekitServer: defaultVoiceDeps.livekitServer,
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

/** Hook context whose session and state follow the call's latest session. */
function liveContext<S extends StateSchema>(
  call: {
    readonly callId: string
    readonly session: Session<S>
    readonly transcript: GPTLiveTranscript
  },
  voice: LiveVoiceControls,
): LiveVoiceContext<S> {
  return {
    callId: call.callId,
    transcript: call.transcript,
    voice,
    get session() {
      return call.session
    },
    get state() {
      return call.session.state
    },
  }
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
  /** Set when close() stops waiting for queued work; that work then no longer writes the call. */
  private ledgerClosed = false
  private endRequested = false
  private endReason = 'disconnected'
  private participantIdentity: string | undefined
  private context: LiveVoiceContext<S> | undefined
  private recorder: GPTLiveTranscript | undefined
  private activeRun: { abort(): void } | undefined
  private queue = Promise.resolve()
  private closing: Promise<void> | undefined
  private readonly seen = new Set<string>()
  private callSession: Session<S> | undefined
  private readonly meter: LiveVoiceMeter
  /** Usage of every backend model call; `undefined` marks a call without reported usage. */
  private readonly backendCalls: Array<ModelUsage | undefined> = []
  private readonly activity: LiveActivity
  /**
   * Lines the caller cannot interrupt, in order, each given after the one before it is said. An
   * agent-requested end lets the last finish.
   */
  private uninterrupted: Promise<void> | undefined
  /**
   * The agent turn count and time when ordinary commentary was last given, until GPT Live starts a
   * turn after it. That line is speech still to come, so an uninterruptible line waits for it, for
   * at most `COMMENTARY_START_MS`.
   */
  private commentaryPending: { turns: number; at: number } | undefined
  private readonly silence = createInactivityTimer({
    timeoutMs: () => this.runtime.config.timeouts?.inactivity,
    isActive: () => !this.stopped && this.context !== undefined,
    onTimeout: (inactivityCount) => this.lifecycle('onInactivity', 'inactivity', inactivityCount),
    emit: () => {},
  })
  private expiry: ReturnType<typeof setTimeout> | undefined
  private agentState = 'initializing'
  /** Admitted delegations not yet settled. The caller is waiting on them, not silent. */
  private delegating = 0
  private agentActive = false

  constructor(
    private readonly runtime: LiveRuntime<S, T>,
    private readonly job: LiveVoiceJob,
  ) {
    this.voiceSession = new runtime.agents.voice.AgentSession({
      llm: createGPTLiveModel(runtime.realtime, runtime.config.agent.model),
    })
    this.meter = new LiveVoiceMeter(runtime.config.agent.model.name, runtime.deps.clock)
    this.activity = new LiveActivity(runtime.deps.lineSettleMs)
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

  get transcript(): GPTLiveTranscript {
    if (!this.recorder) throw new Error('Live call transcript is not ready')
    return this.recorder
  }

  async run(): Promise<void> {
    this.job.addShutdownCallback(() => {
      if (!this.stopped) this.endReason = 'worker-shutdown'
      return this.close()
    })
    const events = this.runtime.agents.voice.AgentSessionEventTypes
    this.voiceSession.on(events.Close, (event) => this.onSessionClose(event.reason, event.error))
    this.voiceSession.on(events.UserStateChanged, (event) => {
      this.activity.userState(event.newState)
      if (event.newState === 'speaking') this.silence.callerStartedSpeaking()
      else if (event.oldState === 'speaking') this.silence.callerStoppedSpeaking()
    })
    this.voiceSession.on(events.AgentStateChanged, (event) => {
      this.activity.agentState(event.newState)
      this.agentState = event.newState
      this.syncAgentActivity()
    })
    this.voiceSession.on(events.SpeechCreated, () => this.silence.agentReplyCreated())
    const expiryMs = this.runtime.config.timeouts?.expiry
    if (expiryMs) this.expiry = setTimeout(() => this.lifecycle('onExpiry', 'expiry'), expiryMs)
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
    this.silence.stop()
    clearTimeout(this.expiry)
  }

  private syncAgentActivity(): void {
    const active =
      this.delegating > 0 || this.agentState === 'speaking' || this.agentState === 'thinking'
    if (active === this.agentActive) return
    this.agentActive = active
    if (active) this.silence.agentBecameActive()
    else this.silence.agentWentIdle()
  }

  /**
   * Runs a lifecycle hook after the call's queued work, so the call keeps one state writer. The
   * call ends unless a hook returns `false`; a call that has not entered ends without hooks. A
   * silence the caller broke while the hook waited in the queue no longer calls for it.
   */
  private lifecycle(name: 'onInactivity' | 'onExpiry', reason: string, inactivityCount = 0): void {
    const context = this.context
    if (this.stopped) return
    if (!context) {
      this.requestEnd(reason)
      return
    }
    const turns = this.activity.callerTurns
    this.queue = this.queue
      .then(async () => {
        if (this.stopped) return
        if (name === 'onInactivity' && this.activity.callerTurns !== turns) return
        let keep = false
        try {
          for (const hook of this.runtime.hooks) {
            if (!hook[name]) continue
            try {
              if ((await hook[name]({ ...context, inactivityCount })) === false) keep = true
            } catch {
              this.log({ callId: context.callId }, `Live ${name} hook failed`)
            }
          }
        } finally {
          await this.commitQueued(this.session)
        }
        if (!keep) this.requestEnd(reason)
      })
      .catch((error) => this.reportError(error, context))
  }

  async enter(duplexSession: unknown): Promise<void> {
    try {
      if (!(duplexSession instanceof this.runtime.realtime.GPTLiveSession))
        throw new Error('Expected GPT Live session')
      const live = duplexSession
      this.transcript.attach(live)
      if (live.sessionId) this.meter.observeConnection(live.sessionId ?? undefined)
      live.on('openai_server_event_received', (event) =>
        this.meter.observeServerEvent(event, live.sessionId ?? undefined),
      )
      const entered = liveContext(this, this.controls(live))
      this.context = entered
      if (!this.agentActive) this.silence.agentWentIdle()
      this.queue = this.queue.then(async () => {
        for (const hook of this.runtime.hooks) await hook.onEnter?.(entered)
        await this.commitQueued(this.session)
      })
      live.on('delegation_created', (event) => this.admit(live, event.id))
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
      createGPTLiveTranscript(store, callSession.id, (error) => this.onTranscriptError(error)),
    )
    this.recorder = recorder
    if (this.stopped) {
      await recorder.close()
      return
    }
    const instructions = await renderLiveInstructions(callSession, config.agent, callSession.id)
    if (this.stopped) return
    const enter = (duplexSession: unknown) => this.enter(duplexSession)
    const stop = () => this.stop()
    const agent = new (class extends this.runtime.agents.voice.Agent {
      override async onEnter() {
        await enter(Reflect.get(this, 'duplexSession'))
      }
      override async onExit() {
        stop()
      }
    })({ instructions, tools: {} })
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
    const activity = this.activity
    return {
      get turnCount() {
        return activity.callerTurns
      },
      end: () => {
        if (usable()) this.requestEnd()
      },
      appendThinking: (text) => {
        if (usable()) live.appendThinking(text, { delegationId: delegation?.id })
      },
      appendCommentary: (text, options) => {
        if (!usable()) return
        if (options?.allowInterruptions === false) this.sayUninterrupted(live, text, delegation?.id)
        else {
          this.commentaryPending = { turns: this.activity.agentTurns, at: Date.now() }
          live.appendCommentary(text, { delegationId: delegation?.id })
        }
      },
      appendInstructions: (text) => {
        if (usable()) live.appendInstructions(text, { delegationId: delegation?.id })
      },
    }
  }

  /**
   * Says a line the caller cannot talk over, from AgentSession states alone. Caller audio is
   * silenced at once, so nothing new can start a turn. The line is given once GPT Live is quiet, no
   * delegation is in flight and any ordinary commentary given before it has started a turn, so an
   * earlier line's turn is not taken for this one. It counts as said when GPT Live's next speaking
   * turn has started and ended. Lines go one at a time, so one turn never counts for two. Each wait
   * is bounded by the playout timeout; caller audio returns when the last line has settled.
   */
  private sayUninterrupted(live: GPTLiveSession, text: string, delegationId?: string): void {
    const previous = this.uninterrupted
    if (!previous) live.muteInput()
    const line = this.giveUninterrupted(live, text, delegationId, previous)
    this.uninterrupted = line
    void line.finally(() => {
      if (this.uninterrupted !== line) return
      this.uninterrupted = undefined
      live.unmuteInput()
    })
  }

  /** Gives one uninterruptible line after `previous`, once quiet, and waits for it to be said. */
  private async giveUninterrupted(
    live: GPTLiveSession,
    text: string,
    delegationId: string | undefined,
    previous: Promise<void> | undefined,
  ): Promise<void> {
    const { playoutTimeout } = this.runtime
    await previous
    const quiet = await this.activity.whenQuietAnd(
      () => this.delegating === 0 && !this.commentaryStillToCome(),
      playoutTimeout,
    )
    if (!quiet) this.log({ callId: this.context?.callId }, 'Live line_given_while_busy')
    const turns = this.activity.agentTurns
    live.appendCommentary(text, { delegationId })
    const said = await this.activity.whenQuietAnd(
      () => this.activity.agentTurns > turns,
      playoutTimeout,
    )
    if (!said) this.log({ callId: this.context?.callId }, 'Live line_unconfirmed')
  }

  /**
   * True while ordinary commentary given earlier has not yet started an agent turn, for at most
   * `COMMENTARY_START_MS`: a line GPT Live never speaks does not hold the next one.
   */
  private commentaryStillToCome(): boolean {
    const pending = this.commentaryPending
    if (pending === undefined) return false
    if (
      this.activity.agentTurns <= pending.turns &&
      Date.now() - pending.at < (this.runtime.deps.commentaryStartMs ?? COMMENTARY_START_MS)
    )
      return true
    this.commentaryPending = undefined
    return false
  }

  /** Freezes the transcript snapshot synchronously, then queues the delegation. */
  private admit(live: GPTLiveSession, delegationId: string): void {
    const connectionId = live.sessionId
    if (!connectionId || this.stopped) return
    const key = `${connectionId}/${delegationId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const snapshot = this.transcript.snapshot()
    const delegation: LiveVoiceDelegation = {
      id: delegationId,
      connectionId,
      nativeThrough: snapshot.receivedThrough,
    }
    let active = true
    const voice = this.controls(live, delegation, () => active)
    this.delegating++
    this.syncAgentActivity()
    this.queue = this.queue
      .then(() => this.execute(live, delegation, snapshot, voice))
      .catch((error) => this.onDelegationError(error, delegation, voice))
      .finally(() => {
        active = false
        this.delegating--
        this.syncAgentActivity()
      })
  }

  private async execute(
    live: GPTLiveSession,
    delegation: LiveVoiceDelegation,
    snapshot: GPTLiveTranscriptSnapshot,
    voice: LiveVoiceControls,
  ): Promise<void> {
    const { app, config, sessionService, timeout, hooks } = this.runtime
    if (this.stopped || live.sessionId !== delegation.connectionId) return
    await persist(() => this.transcript.checkpoint())
    if (this.stopped) return
    const session = await persist(() => app.sessions.create({ scopes: this.session.scopes }))
    for (const historyEvent of liveHistory(this.session.events, snapshot, config.backend.name))
      await sessionService.appendEvent(session, structuredClone(historyEvent))
    seedLiveState(this.session, session)
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
      if (!this.abandoned) await this.transferBackendWork(delegation, snapshot, session, workStart)
    }
    if (this.stopped || live.sessionId !== delegation.connectionId) return
    if (result.status !== 'completed') throw new Error(`Live backend ended with ${result.status}`)
    if (result.output.value === undefined)
      throw new Error('Live backend completed without an output value')
    try {
      for (const hook of hooks)
        await hook.onResult?.({
          ...liveContext(this, voice),
          delegation,
          backendSession: session,
          output: result.output.value,
        })
    } finally {
      await this.commitQueued(this.session)
    }
  }

  /** Reloads the call owner, applies the backend's state changes and records its settled work. */
  private async transferBackendWork(
    delegation: LiveVoiceDelegation,
    snapshot: GPTLiveTranscriptSnapshot,
    session: Session<S>,
    workStart: number,
  ): Promise<void> {
    const { config, sessionService } = this.runtime
    const callId = this.callId
    const callSession = await this.reloadCall()
    applyLiveState(session, callSession, workStart)
    const work = completedBackendWork(session.events.slice(workStart))
    await sessionService.appendEvent(callSession, {
      id: `${session.id}/backend-work`,
      type: 'annotation',
      kind: 'mark',
      label: 'live-backend-work',
      createdAt: Date.now(),
      invocationId: '',
      agentName: config.backend.name,
      data: { backendSessionId: session.id, transcriptThrough: snapshot.receivedThrough },
    })
    await sessionService.appendEvent(callSession, {
      id: `${session.id}/backend-work-context`,
      type: 'system',
      text: `Prior backend work for delegation ${delegation.id}, based on transcript receipt ${snapshot.receivedThrough}, settled at receipt ${this.transcript.receivedThrough}. Work may postdate the frozen voice snapshot and does not imply the caller heard it.${work.unresolved.length ? ` Unresolved tool calls with unknown outcome; do not assume failure or retry automatically: ${work.unresolved.map((call) => `${call.name} (${call.callId})`).join(', ')}.` : ''}`,
      createdAt: Date.now(),
      invocationId: '',
      agentName: config.backend.name,
    })
    for (const completed of work.events) await sessionService.appendEvent(callSession, completed)
    if (this.ledgerClosed) {
      this.log({ callId, delegationId: delegation.id }, 'Late Live backend work was not recorded')
      return
    }
    this.callSession = callSession
    await this.commit(callSession)
  }

  /** Loads the call session as last committed. */
  private reloadCall(): Promise<Session<S>> {
    const callId = this.callId
    return persist(async () => {
      const saved = await this.runtime.app.sessions.get(callId)
      if (!saved) throw new Error('Live call state is missing')
      return saved
    })
  }

  private async onDelegationError(
    error: unknown,
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
    await this.reportError(error, { ...liveContext(this, voice), delegation })
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

  private commit(session: Session<S>): Promise<void> {
    return persist(async () => {
      if (!(await this.runtime.app.sessions.commit(session)).ok)
        throw new Error('Live session commit conflict')
    })
  }

  /**
   * Commits close's records: the end mark and `onExit` state. Work that close stopped waiting for
   * can commit to the call first, so on a conflict the same records are committed once more at the
   * reloaded version; a second conflict is logged and close carries on to end the call.
   */
  private async commitAtClose(ledger: Session<S>): Promise<void> {
    const { sessions } = this.runtime.app
    if ((await persist(() => sessions.commit(ledger))).ok) return
    const latest = await this.reloadCall()
    if ((await persist(() => sessions.commit(ledger, latest.version))).ok) return
    this.log({ callId: this.context?.callId }, 'Live call close records conflicted twice')
  }

  /** Commits the call from queued work, unless close() has stopped waiting for that work. */
  private async commitQueued(session: Session<S>): Promise<void> {
    if (!this.ledgerClosed) await this.commit(session)
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
    if (this.endRequested && this.endReason !== 'error') await this.uninterrupted
    const backendSettled = await settlesWithin(this.queue, this.runtime.timeout)
    if (!backendSettled) {
      this.abandoned = true
      // A run still in flight has unknown model calls. A settled run's calls are already recorded,
      // even when its transfer or result hook is what keeps the queue open.
      if (this.activeRun) this.backendCalls.push(undefined)
      this.log({ callId: this.context?.callId }, 'Live backend work did not settle before close')
    }
    this.ledgerClosed = true
    const ledger = await this.finalLedger(backendSettled)
    try {
      await this.closeVoice(backendSettled, ledger)
    } finally {
      try {
        await this.exitHooks(ledger)
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

  /**
   * The call session that close() finalizes. Queued work that close() stopped waiting for keeps the
   * session object it holds, so the call is finalized on a fresh copy of what was last committed.
   * If the copy cannot be read, the call is finalized on the session it has, so the end record and
   * `onExit` still happen.
   */
  private async finalLedger(backendSettled: boolean): Promise<Session<S> | undefined> {
    const context = this.context
    if (!context) return undefined
    if (backendSettled) return this.session
    try {
      return await this.reloadCall()
    } catch {
      this.log({ callId: context.callId }, 'Live call session could not be reloaded at close')
      return this.session
    }
  }

  /** Closes voice and transcript capture, then records how the call ended. */
  private async closeVoice(backendSettled: boolean, ledger: Session<S> | undefined): Promise<void> {
    try {
      await this.voiceSession.close()
    } finally {
      this.meter.stop()
      try {
        await this.recorder?.close()
      } finally {
        if (ledger) {
          await this.runtime.sessionService.appendEvent(ledger, {
            id: randomUUID(),
            type: 'annotation',
            kind: 'mark',
            label: 'live-call-ended',
            createdAt: Date.now(),
            invocationId: ledger.id,
            agentName: this.runtime.config.agent.name,
            data: backendSettled
              ? { reason: this.endReason }
              : { reason: this.endReason, backendSettled },
          })
          await this.commitAtClose(ledger)
        }
      }
    }
  }

  private async exitHooks(ledger: Session<S> | undefined): Promise<void> {
    const context = this.context
    if (!context || !ledger) return
    try {
      const exit = Object.assign(liveContext({ ...context, session: ledger }, context.voice), {
        usage: this.usage(await loadPricing({ maxWaitMs: RESULT_PRICING_WAIT_MS })),
      })
      for (const hook of this.runtime.hooks) await hook.onExit?.(exit)
    } finally {
      await this.commitAtClose(ledger)
    }
  }

  private usage(pricing: PricingCatalog | undefined): LiveCallUsage {
    const usage = summarizeModelUsage(this.backendCalls, pricing)
    const backend = { ...(usage && { usage }), cost: usageCost(usage) }
    const voice = this.meter.usage(pricing)
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
      if (recoverable) await this.commitQueued(errorContext.session)
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
  const realtime = requireGPTLive(deps.openai())
  const hooks = config.hooks ?? []
  if (!hooks.some((hook) => hook.onResult))
    throw new Error('Live voice requires an onResult hook to handle backend output')
  const timeout = config.backendTimeoutMs ?? 30_000
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('backendTimeoutMs must be positive')
  const playoutTimeout = config.playoutTimeoutMs ?? PLAYOUT_TIMEOUT_MS
  if (!Number.isFinite(playoutTimeout) || playoutTimeout <= 0)
    throw new Error('playoutTimeoutMs must be positive')
  const runtime: LiveRuntime<S, T> = {
    config,
    ...appContext,
    deps,
    agents,
    realtime,
    hooks,
    timeout,
    playoutTimeout,
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
