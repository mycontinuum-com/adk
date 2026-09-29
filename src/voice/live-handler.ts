import { randomUUID } from 'node:crypto'
import { z } from 'zod'

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
import type { NoiseCancellationModule } from './noise-cancellation'
import type { RecordingSession } from './recording'
import type { VoiceHandlerHandle } from './types'

import { summarizeModelUsage } from '../core/runner'
import { safeErrorFields } from '../errors/safe-error'
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
import { loadNoiseCancellation, resolveNoiseCancellation } from './noise-cancellation'
import { startRecordingSession } from './recording'
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
  noiseCancellation?: () => NoiseCancellationModule
  clock?: () => number
  /** Agent quiet that ends a turn; tests shorten it. */
  lineSettleMs?: number
}

type LiveKitAgents = ReturnType<LiveDeps['agents']>
type VoiceSession = InstanceType<LiveKitAgents['voice']['AgentSession']>
type RoomInputOptions = NonNullable<Parameters<VoiceSession['start']>[0]['inputOptions']>
/** What a handler's `setup` gives for one call, if it has one. */
type CallSetup<S extends StateSchema> =
  | Awaited<ReturnType<NonNullable<LiveVoiceHandlerConfig<S>['setup']>>>
  | undefined

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

/**
 * A backend run once it has settled: the output its connection's result hooks get, or the error its
 * error hooks get. `delivery` is `answered` once that reached the connection it was given on, and
 * `interrupted` when that connection was replaced while its result hooks ran.
 */
interface SettledRun<S extends StateSchema, T> {
  readonly connectionId: string
  /** Caller turns when its delegation was admitted. */
  readonly callerTurns: number
  readonly outcome:
    | { readonly output: T; readonly backendSession: Session<S> }
    | { readonly error: Error }
  delivery: 'pending' | 'interrupted' | 'answered'
}

/** Thinking given to a reconnect's repeat of a caller turn whose result hooks were cut off. */
const HANDLED_BEFORE_RECONNECT =
  'The backend worked on this request before the voice connection was replaced, and its reply may not have reached the caller. Its actions are not repeated automatically: tell the caller the connection dropped and ask what they still need.'

/** Longest wait for a line to be spoken before a muted caller is heard again or the call ends. */
const PLAYOUT_TIMEOUT_MS = 30_000

/**
 * GPT Live's moderation stopped a generation. The service closes the connection when it does; the
 * reconnect starts without the conversation so far, whose replay would be stopped again. Given to
 * `onError` hooks, recoverable and with no delegation, once the new connection has started. A line
 * given with `allowInterruptions: false` and not yet said was lost with the connection: it is
 * dropped, and the hook says what the call still needs.
 */
export class LiveContentFilterError extends Error {
  constructor() {
    super('GPT Live stopped a generation for moderation')
  }
}

const contentFilterEvent = z.object({
  type: z.literal('error'),
  error: z.object({ code: z.literal('content_filter') }),
})

/** What the connection after a moderation stop is told in place of the conversation. */
const RESTARTED_AFTER_MODERATION =
  'The connection restarted mid-call and the conversation so far is not shown. Do not greet the caller or start the conversation again: delegate what they say, and say what you are given.'

/**
 * Replaces the conversation the LiveKit plugin replays to its next connection with a note that the
 * call is under way. The conversation is private to the plugin; a plugin that does not keep it as
 * `history.items` replays it unchanged.
 */
function forgetConversation(live: GPTLiveSession): void {
  const history: unknown = Reflect.get(live, 'history')
  if (typeof history === 'object' && history !== null && 'items' in history)
    Reflect.set(history, 'items', [])
  live.appendInstructions(RESTARTED_AFTER_MODERATION, {})
}

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
  /** Call audio (local file or LiveKit egress), when `recording` is configured. */
  private audioRecording: RecordingSession | undefined
  private activeRun: { abort(): void } | undefined
  /** Connections GPT Live's moderation closed; a line pending at one is dropped. */
  private moderationStops = 0
  /** The latest backend run, kept so a reconnect's repeat of its caller turn gets its outcome. */
  private lastRun: SettledRun<S, T> | undefined
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
  /** Resolves when the voice session closes, such as when the caller hangs up. */
  private voiceClosed!: () => void
  private readonly voiceClosing = new Promise<void>((resolve) => {
    this.voiceClosed = resolve
  })
  private readonly silence = createInactivityTimer({
    timeoutMs: () => this.runtime.config.timeouts?.inactivity,
    isActive: () => !this.stopped && this.context !== undefined,
    onTimeout: (inactivityCount, timeoutId) =>
      this.lifecycle('onInactivity', 'inactivity', inactivityCount, timeoutId),
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
    // A line the muted caller is waiting to hear counts too, so no silence prompt fires before it.
    const active =
      this.delegating > 0 ||
      this.uninterrupted !== undefined ||
      this.agentState === 'speaking' ||
      this.agentState === 'thinking'
    if (active === this.agentActive) return
    this.agentActive = active
    if (active) this.silence.agentBecameActive()
    else this.silence.agentWentIdle()
  }

  /**
   * Runs a lifecycle hook after the call's queued work, so the call keeps one state writer. The
   * call ends unless a hook returns `false`; a call that has not entered ends without hooks. A
   * silence the caller broke while the hook waited in the queue no longer calls for it, but it
   * still counts toward `inactivityCount` until the agent replies to the caller.
   */
  private lifecycle(
    name: 'onInactivity' | 'onExpiry',
    reason: string,
    inactivityCount = 0,
    timeoutId = 0,
  ): void {
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
        if (name === 'onInactivity' && this.activity.callerTurns !== turns) {
          this.silence.promptSkipped(timeoutId)
          return
        }
        let keep = false
        try {
          for (const hook of this.runtime.hooks) {
            if (!hook[name]) continue
            try {
              // react-doctor-disable-next-line react-doctor/async-await-in-loop -- lifecycle hooks run in registration order, one at a time
              if ((await hook[name]({ ...context, inactivityCount })) === false) keep = true
            } catch (error) {
              this.log(
                { callId: context.callId, ...safeErrorFields(error) },
                `Live ${name} hook failed`,
              )
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
      if (live.sessionId) this.meter.observeConnection(live.sessionId)
      // Moderation closes the connection; its replacement then starts with nothing to flag, and
      // the error hooks run once it has, so a line they give reaches a connection that can say it.
      let contentFiltered = false
      live.on('openai_server_event_received', (event) => {
        this.meter.observeServerEvent(event, live.sessionId ?? undefined)
        if (!contentFilterEvent.safeParse(event).success) return
        contentFiltered = true
        forgetConversation(live)
      })
      live.on('session_reconnected', () => {
        if (!contentFiltered) return
        contentFiltered = false
        // Lines given to the closed connection were lost with it.
        this.moderationStops++
        this.activity.giveUp()
        const context = liveContext(this, this.controls(live))
        this.queue = this.queue.then(async () => {
          if (!this.stopped) await this.reportError(new LiveContentFilterError(), context)
        })
      })
      const entered = liveContext(this, this.controls(live))
      this.context = entered
      if (!this.agentActive) this.silence.agentWentIdle()
      this.queue = this.queue.then(async () => {
        for (const hook of this.runtime.hooks) {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- onEnter hooks run in registration order, one at a time
          await hook.onEnter?.(entered)
        }
        await this.commitQueued(this.session)
      })
      live.on('delegation_created', (event) => this.admit(live, event.id))
      await this.queue
    } catch (error) {
      this.requestEnd('error')
      throw error
    }
  }

  /** The caller's noise filter: the call setup's profile, else the handler's. */
  private inputFilter(setup: CallSetup<S>): RoomInputOptions['noiseCancellation'] {
    const noiseCancellation =
      setup?.noiseCancellation ?? this.runtime.config.sound?.noiseCancellation
    return noiseCancellation
      ? resolveNoiseCancellation(
          noiseCancellation,
          (this.runtime.deps.noiseCancellation ?? loadNoiseCancellation)(),
        )
      : undefined
  }

  /** Creates, seeds and commits the call session. */
  private async openCallSession(setup: CallSetup<S>): Promise<Session<S>> {
    const { app } = this.runtime
    const callSession = await persist(() =>
      app.sessions.create({ sessionId: setup?.sessionId, scopes: setup?.scopes }),
    )
    seedState(callSession, {
      session: applySchemaDefaults(setup?.state ?? {}, app.schema?.session),
    })
    if (setup?.initialState) seedState(callSession, setup.initialState, app.schema)
    this.callSession = callSession
    await this.commit(callSession)
    return callSession
  }

  /**
   * Starts the configured recording before the voice session, as the Realtime handler does, so
   * early audio is kept. False when the call stopped meanwhile; the recording is then stopped.
   */
  private async startAudioRecording(
    callSession: Session<S>,
    setup: CallSetup<S>,
  ): Promise<boolean> {
    const { recording } = this.runtime.config
    if (!recording) return true
    this.audioRecording = await startRecordingSession(
      this.job.room,
      recording,
      callSession.id,
      setup?.recordingKey,
      this.runtime.deps.livekitServer,
    )
    if (!this.stopped) return true
    await this.audioRecording.stop()
    return false
  }

  private async start(): Promise<void> {
    const { config, store } = this.runtime
    await this.job.connect()
    const participant = await this.job.waitForParticipant()
    if (this.stopped) return
    this.participantIdentity = participant.identity
    const setup = await config.setup?.(participant)
    if (this.stopped) return
    const inputFilter = this.inputFilter(setup)
    const callSession = await this.openCallSession(setup)
    if (this.stopped) return
    if (!(await this.startAudioRecording(callSession, setup))) return
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
      inputOptions: {
        participantIdentity: this.participantIdentity,
        ...(inputFilter !== undefined && { noiseCancellation: inputFilter }),
      },
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
      untilQuiet: () => this.uninterrupted ?? Promise.resolve(),
      appendThinking: (text) => {
        if (usable()) live.appendThinking(text, { delegationId: delegation?.id })
      },
      appendCommentary: (text, options) => {
        if (!usable()) return
        if (options?.allowInterruptions === false) this.sayUninterrupted(live, text, delegation?.id)
        else live.appendCommentary(text, { delegationId: delegation?.id })
      },
      appendInstructions: (text) => {
        if (usable()) live.appendInstructions(text, { delegationId: delegation?.id })
      },
    }
  }

  /**
   * Says a line the caller cannot talk over, from AgentSession states alone. Caller audio is
   * silenced at once, so nothing new can start a turn. The line is given once GPT Live is quiet,
   * and counts as said when GPT Live's next speaking turn has started and ended. Lines go one at a
   * time, so one turn never counts for two. Each wait is bounded by the playout timeout; caller
   * audio returns when the last line has settled.
   */
  private sayUninterrupted(live: GPTLiveSession, text: string, delegationId?: string): void {
    const previous = this.uninterrupted
    if (!previous) live.muteInput()
    // A line GPT Live could not be given is logged and settles, so waits on it and close go on.
    const line = this.giveUninterrupted(live, text, delegationId, previous).catch((error) =>
      this.log({ callId: this.context?.callId, ...safeErrorFields(error) }, 'Live line_failed'),
    )
    this.uninterrupted = line
    this.syncAgentActivity()
    void line.finally(() => {
      if (this.uninterrupted !== line) return
      this.uninterrupted = undefined
      live.unmuteInput()
      this.syncAgentActivity()
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
    const stops = this.moderationStops
    const lost = () => {
      if (this.moderationStops === stops) return false
      this.log({ callId: this.context?.callId }, 'Live line_lost_to_moderation')
      return true
    }
    await previous
    const quiet = await this.activity.whenQuietAnd(() => true, playoutTimeout)
    if (lost()) return
    if (!quiet) this.log({ callId: this.context?.callId }, 'Live line_given_while_busy')
    const turns = this.activity.agentTurns
    live.appendCommentary(text, { delegationId })
    const said = await this.activity.whenQuietAnd(
      () => this.activity.agentTurns > turns,
      playoutTimeout,
    )
    if (lost()) return
    if (!said) this.log({ callId: this.context?.callId }, 'Live line_unconfirmed')
  }

  /** Freezes the transcript snapshot synchronously, then queues the delegation. */
  private admit(live: GPTLiveSession, delegationId: string): void {
    const connectionId = live.sessionId
    if (!connectionId || this.stopped) return
    const key = `${connectionId}/${delegationId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const snapshot = this.transcript.snapshot()
    const callerTurns = this.activity.callerTurns
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
      .then(() => this.execute(live, delegation, snapshot, voice, callerTurns))
      .catch((error) => this.onDelegationError(error, delegation, voice))
      .finally(() => {
        active = false
        this.delegating--
        this.syncAgentActivity()
      })
  }

  /**
   * Runs the backend for a delegation and gives its outcome to the delegation's result or error
   * hooks. A delegation on a new connection with no caller turn since the last run's delegation,
   * whose connection was replaced before that run's outcome reached it, is the provider asking
   * again for the same caller turn: it gets that run's outcome, and the backend does not run
   * again.
   */
  private async execute(
    live: GPTLiveSession,
    delegation: LiveVoiceDelegation,
    snapshot: GPTLiveTranscriptSnapshot,
    voice: LiveVoiceControls,
    callerTurns: number,
  ): Promise<void> {
    const { app, config, sessionService, timeout } = this.runtime
    if (this.stopped || live.sessionId !== delegation.connectionId) return
    const earlier = this.lastRun
    if (
      earlier &&
      earlier.delivery !== 'answered' &&
      earlier.callerTurns === callerTurns &&
      earlier.connectionId !== delegation.connectionId
    ) {
      if (earlier.delivery === 'pending') return this.deliver(live, delegation, voice, earlier)
      // Its result hooks may already have acted, so they are not run again.
      live.appendThinking(HANDLED_BEFORE_RECONNECT, { delegationId: delegation.id })
      return
    }
    this.lastRun = undefined
    await persist(() => this.transcript.checkpoint())
    if (this.stopped) return
    const session = await persist(() => app.sessions.create({ scopes: this.session.scopes }))
    for (const historyEvent of liveHistory(this.session.events, snapshot, config.backend.name)) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- carried history is appended to the backend session in transcript order
      await sessionService.appendEvent(session, structuredClone(historyEvent))
    }
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
    const settled: SettledRun<S, T> = {
      connectionId: delegation.connectionId,
      callerTurns,
      delivery: 'pending',
      outcome:
        result.status !== 'completed'
          ? { error: new Error(`Live backend ended with ${result.status}`) }
          : result.output.value === undefined
            ? { error: new Error('Live backend completed without an output value') }
            : { output: result.output.value, backendSession: session },
    }
    this.lastRun = settled
    await this.deliver(live, delegation, voice, settled)
  }

  /**
   * Gives a settled run's outcome to this delegation's hooks, unless its connection was replaced;
   * the run then stays pending for the provider's next delegation of the same caller turn. Result
   * and error hooks run at most once per run: a connection replaced while they run leaves it
   * `interrupted`.
   */
  private async deliver(
    live: GPTLiveSession,
    delegation: LiveVoiceDelegation,
    voice: LiveVoiceControls,
    run: SettledRun<S, T>,
  ): Promise<void> {
    if (this.stopped || live.sessionId !== delegation.connectionId) return
    const { outcome } = run
    run.delivery = 'interrupted'
    try {
      if ('error' in outcome) throw outcome.error
      try {
        for (const hook of this.runtime.hooks) {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- onResult hooks run in registration order, one at a time
          await hook.onResult?.({
            ...liveContext(this, voice),
            delegation,
            backendSession: outcome.backendSession,
            output: outcome.output,
          })
        }
      } finally {
        await this.commitQueued(this.session)
      }
    } catch (error) {
      // Handled here, so the run counts as answered only once its error hooks have run too.
      await this.onDelegationError(error, delegation, voice)
    } finally {
      if (live.sessionId === delegation.connectionId) run.delivery = 'answered'
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
    for (const completed of work.events) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- settled backend work is appended to the call session in event order
      await sessionService.appendEvent(callSession, completed)
    }
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
        { callId: this.callId, delegationId: delegation.id, ...safeErrorFields(error) },
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
    this.voiceClosed()
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
    void this.close().catch((error) =>
      this.log(
        { callId: this.context?.callId, ...safeErrorFields(error) },
        'Live call cleanup failed',
      ),
    )
  }

  private close(): Promise<void> {
    return (this.closing ??= this.finalize())
  }

  private async finalize(): Promise<void> {
    this.stop()
    // A line nobody is left to hear is not waited for.
    if (this.endRequested && this.endReason !== 'error')
      await Promise.race([this.uninterrupted, this.voiceClosing])
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
    } catch (error) {
      this.log(
        { callId: context.callId, ...safeErrorFields(error) },
        'Live call session could not be reloaded at close',
      )
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
        // Stops egress; a stop that fails is ignored, as the call is already over.
        await this.audioRecording?.stop()
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
      for (const hook of this.runtime.hooks) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- onExit hooks run in registration order, one at a time
        await hook.onExit?.(exit)
      }
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
      {
        callId: errorContext.callId,
        delegationId: errorContext.delegation?.id,
        recoverable,
        ...safeErrorFields(error),
      },
      'Live backend or persistence failed',
    )
    try {
      let handled = false
      let terminate = false
      for (const hook of this.runtime.hooks) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- onError hooks run in registration order and each decision is folded before the next hook
        const decision = await hook.onError?.({ ...errorContext, error, recoverable })
        handled ||= decision === 'continue'
        terminate ||= decision === 'end'
      }
      if (recoverable) await this.commitQueued(errorContext.session)
      if (!recoverable || !handled || terminate) this.requestEnd('error')
    } catch (recoveryError) {
      this.log(
        { callId: errorContext.callId, ...safeErrorFields(recoveryError) },
        'Live error recovery failed',
      )
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
