import { randomUUID } from 'node:crypto'

import type { StateChanges } from '../../session/seedState'
import type { ModelUsage } from '../../types/events'
import type { Agent, RealtimeModelConfig } from '../../types/runnables'
import type { UsageSummary } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'
import type { LiveVoiceAppContext, LiveVoiceJob } from '../../voice/live-handler'
import type {
  LiveCallUsage,
  LiveVoiceContext,
  LiveVoiceExitContext,
  LiveVoiceHandlerConfig,
} from '../../voice/live-types'
import type { CaseWriter } from './case-writer'
import type { RecordingHandle } from './recorder'
import type {
  LiveVoiceEvalCase,
  LiveVoiceEvalUsage,
  VoiceEvalOptions,
  VoiceRoomConfig,
  VoiceRunResult,
  VoiceRunStatus,
} from './types'

import { buildContextAsync } from '../../context/build'
import { computeUsageSummary, summarizeModelUsage } from '../../core/runner'
import { getModelName, isRealtimeConfig } from '../../providers/models'
import { sumCosts, usageCost } from '../../providers/pricing'
import { BaseSession } from '../../session'
import { isSystemEvent } from '../../types/events'
import { createLiveVoiceHandler } from '../../voice/live-handler'
import { transcriptMessages } from '../../voice/live-history'
import { isRealtimeMetrics, realtimeTokenUsage } from '../../voice/live-usage'
import { createLiveKitAgent } from '../../voice/livekit-agent'
import { createLiveKitModel } from '../../voice/livekit-model'
import { interceptTools } from '../interceptTools'
import { withTimeout } from '../suite-runner'
import { bindVoiceEvalControl } from './control'
import { requireLiveKit } from './livekit-sdk'
import { recordRooms } from './recorder'
import { createSpeakerTracker } from './speaker-tracker'

interface LiveKitSdk {
  lk: typeof import('@livekit/agents')
  rtc: typeof import('@livekit/rtc-node', { with: { 'resolution-mode': 'import' } })
  serverSdk: typeof import('livekit-server-sdk')
}
type Room = InstanceType<LiveKitSdk['rtc']['Room']>
type CallerSession = InstanceType<LiveKitSdk['lk']['voice']['AgentSession']>
type Participant = Awaited<ReturnType<LiveVoiceJob['waitForParticipant']>>

const agentIdentity = 'voice-eval-agent'
const userIdentity = 'voice-eval-user'

/**
 * Status for a handler exit that arrives before the observation window finishes. Only an
 * agent-requested end counts as completion; any other close is a disconnect.
 */
function liveExitStatus(reason: unknown): VoiceRunStatus {
  if (reason === 'agent-ended') return 'completed'
  if (reason === 'participant_disconnected') return 'participant_left'
  return 'disconnected'
}

function roomToken(
  serverSdk: LiveKitSdk['serverSdk'],
  credentials: { apiKey?: string; apiSecret?: string },
  roomName: string,
  identity: string,
): Promise<string> {
  const token = new serverSdk.AccessToken(credentials.apiKey, credentials.apiSecret, {
    identity,
    ttl: '5m',
  })
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true })
  return token.toJwt()
}

/** Resolves when the simulated caller joins; rejects if the agent room disconnects first. */
function waitForCaller(room: Room, events: LiveKitSdk['rtc']['RoomEvent']): Promise<Participant> {
  const participant = room.remoteParticipants.get(userIdentity)
  if (participant) return Promise.resolve(participant)
  return new Promise((resolve, reject) => {
    const connected = (joined: Participant) => {
      if (joined.identity !== userIdentity) return
      clear()
      resolve(joined)
    }
    const disconnected = () => {
      clear()
      reject(new Error('Voice eval room disconnected before caller joined'))
    }
    const clear = () => {
      room.off(events.ParticipantConnected, connected)
      room.off(events.Disconnected, disconnected)
    }
    room.on(events.ParticipantConnected, connected)
    room.on(events.Disconnected, disconnected)
  })
}

/**
 * Combines the handler's call usage with the simulated caller's usage. Backend events copied into
 * the eval session are the fallback when the handler did not finalize.
 */
export function summarizeLiveEvalUsage(input: {
  backend: UsageSummary | undefined
  call: LiveCallUsage | undefined
  voiceModel: string
  callerCalls: readonly (ModelUsage | undefined)[]
}): LiveVoiceEvalUsage {
  const backend = input.call?.backend ?? {
    ...(input.backend && { usage: input.backend }),
    cost: usageCost(input.backend),
  }
  const voice = input.call?.voice ?? {
    modelName: input.voiceModel,
    cost: { basis: 'unavailable' as const },
  }
  const callerUsage = summarizeModelUsage(input.callerCalls)
  const caller = callerUsage
    ? { usage: callerUsage, cost: usageCost(callerUsage) }
    : { cost: { basis: 'unavailable' as const } }
  return {
    backend,
    voice,
    caller,
    total: sumCosts([backend.cost, voice.cost, caller.cost]),
  }
}

/** Final status of the run, the evidence it gathered and the resources it must release. */
class LiveVoiceCaseRun<S extends StateSchema> {
  readonly startedAtMs = Date.now()
  private readonly callId = randomUUID()
  private readonly roomName = `voice-eval-${randomUUID()}`
  private readonly credentials: { apiKey?: string; apiSecret?: string }
  private readonly service: InstanceType<LiveKitSdk['serverSdk']['RoomServiceClient']>
  private readonly agentRoom: Room
  private readonly userRoom: Room
  private readonly caller: CallerSession
  private readonly tracker = createSpeakerTracker(agentIdentity, userIdentity)
  private readonly shutdown: Array<() => Promise<void>> = []
  private complete: () => void = () => {}
  private readonly done = new Promise<void>((resolve) => {
    this.complete = resolve
  })
  private context: LiveVoiceContext<S> | undefined
  private callUsage: LiveCallUsage | undefined
  /** Usage of each caller response; `undefined` marks a response without reported tokens. */
  private readonly callerCalls: Array<ModelUsage | undefined> = []
  private session: Session<S>
  private recorder: RecordingHandle | undefined
  private recordingPath = ''
  private status: VoiceRunStatus = 'completed'
  private error: VoiceRunResult<S>['error']
  private handlerError: unknown
  private stopping = false
  private unbind: (() => void) | undefined
  private durationTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly evalCase: LiveVoiceEvalCase<S>,
    private readonly options: VoiceEvalOptions<S> & { room: VoiceRoomConfig },
    private readonly appContext: LiveVoiceAppContext<S>,
    private readonly sdk: LiveKitSdk,
    private readonly createHandler: typeof createLiveVoiceHandler,
    private readonly backend: Agent<S, any>,
    private readonly userModel: RealtimeModelConfig,
    private readonly window: { durationMs: number; timeoutMs: number },
    private readonly writer?: CaseWriter,
    private readonly recordingDir?: string,
  ) {
    this.credentials = {
      apiKey: options.room.apiKey ?? process.env.LIVEKIT_API_KEY,
      apiSecret: options.room.apiSecret ?? process.env.LIVEKIT_API_SECRET,
    }
    this.service = new sdk.serverSdk.RoomServiceClient(
      options.room.url,
      this.credentials.apiKey,
      this.credentials.apiSecret,
    )
    this.agentRoom = new sdk.rtc.Room()
    this.userRoom = new sdk.rtc.Room()
    this.caller = new sdk.lk.voice.AgentSession({})
    this.session = new BaseSession('eval', { id: this.callId })
  }

  async execute(): Promise<VoiceRunResult<S>> {
    const deadline = setTimeout(() => this.finish('timeout'), this.window.timeoutMs)
    this.listen()
    const startup = this.start().catch((cause) => this.finish('error', cause))
    try {
      await this.done
    } finally {
      clearTimeout(deadline)
      clearTimeout(this.durationTimer)
      this.unbind?.()
      await this.release(startup)
    }
    return this.collect()
  }

  private finish(next: VoiceRunStatus, cause?: unknown): void {
    if (cause) {
      this.error ??= {
        message: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack : undefined,
      }
      this.status = 'error'
    } else if (!this.stopping) this.status = next
    this.stopping = true
    this.complete()
  }

  private listen(): void {
    const { rtc, lk } = this.sdk
    this.agentRoom.on(rtc.RoomEvent.ActiveSpeakersChanged, (participants) => {
      this.tracker.onActiveSpeakersChanged(participants.map((participant) => participant.identity))
    })
    this.agentRoom.on(rtc.RoomEvent.Disconnected, () => {
      if (!this.stopping) this.finish('disconnected')
    })
    this.userRoom.on(rtc.RoomEvent.Disconnected, () => {
      if (!this.stopping) this.finish('participant_left')
    })
    const callerModel = getModelName(this.userModel)
    this.caller.on(lk.voice.AgentSessionEventTypes.MetricsCollected, (event) => {
      if (isRealtimeMetrics(event.metrics))
        this.callerCalls.push(realtimeTokenUsage(event.metrics, callerModel))
    })
    this.caller.on(lk.voice.AgentSessionEventTypes.Close, (event) => {
      if (!this.stopping) this.finish('disconnected', event.error)
    })
  }

  private async start(): Promise<void> {
    const { evalCase, writer, agentRoom, userRoom } = this
    const url = this.options.room.url
    writer?.appendLine('Starting LiveKit room.')
    await this.service.createRoom({ name: this.roomName, emptyTimeout: 120, departureTimeout: 30 })
    if (this.stopping) {
      await this.service.deleteRoom(this.roomName)
      return
    }
    const [agentToken, userToken] = await Promise.all([
      roomToken(this.sdk.serverSdk, this.credentials, this.roomName, agentIdentity),
      roomToken(this.sdk.serverSdk, this.credentials, this.roomName, userIdentity),
    ])
    if (this.stopping) return
    writer?.appendLine('Connecting voice participants.')
    await Promise.all([
      agentRoom.connect(url, agentToken, { autoSubscribe: true, dynacast: false }),
      userRoom.connect(url, userToken, { autoSubscribe: true, dynacast: false }),
    ])
    if (this.stopping) {
      await Promise.allSettled([agentRoom.disconnect(), userRoom.disconnect()])
      return
    }
    if (this.recordingDir) {
      this.recorder = recordRooms({
        rooms: [agentRoom, userRoom],
        agentIdentity,
        userIdentity,
        recordingDir: this.recordingDir,
        caseName: evalCase.name,
      })
    }
    const userContext = await buildContextAsync(this.session, evalCase.userAgent, randomUUID())
    if (this.stopping) return
    const userAgent = createLiveKitAgent(
      evalCase.userAgent,
      userContext.events
        .filter(isSystemEvent)
        .map((event) => event.text)
        .join('\n'),
      {},
      this.session,
      createLiveKitModel(this.userModel),
    )
    if (!(userAgent instanceof this.sdk.lk.voice.Agent))
      throw new Error('Expected LiveKit caller agent')
    writer?.appendLine('Starting caller and Live handler.')
    const callerStarting = this.caller
      .start({
        agent: userAgent,
        room: userRoom,
        inputOptions: { participantIdentity: agentIdentity },
      })
      .catch((cause) => {
        this.finish('error', cause)
      })
    if (evalCase.evalControl)
      this.unbind = bindVoiceEvalControl(evalCase.evalControl, {
        disconnectUser: async (controlOptions) => {
          if (controlOptions?.mode === 'lifecycle')
            throw new Error('Live voice eval supports physical disconnect only')
          await userRoom.disconnect()
          this.finish('participant_left')
        },
      })
    const handler = this.createHandler<S, any>(this.handlerConfig(), this.appContext)
    await Promise.all([handler.entry(this.job()), callerStarting])
    if (this.stopping) return
    writer?.appendLine('Observing live conversation.')
    this.tracker.setMediaReady()
    this.durationTimer = setTimeout(() => this.finish('completed'), this.window.durationMs)
  }

  /** The production handler configuration, with eval call identity and status hooks around it. */
  private handlerConfig(): LiveVoiceHandlerConfig<S, any> {
    const { evalCase } = this
    return {
      ...evalCase,
      backend: this.backend,
      callTermination: false,
      setup: async (participant) => {
        const setup = await evalCase.setup?.(participant)
        const initialState: StateChanges<S> = { ...setup?.initialState }
        for (const scope of ['session', 'user', 'patient', 'practice', 'org', 'team'] as const) {
          if (evalCase.initialState?.[scope])
            initialState[scope] = { ...initialState[scope], ...evalCase.initialState[scope] }
        }
        // Every repetition gets a fresh call; product setup supplies scopes and state.
        return { ...setup, sessionId: this.callId, initialState }
      },
      hooks: [
        {
          onEnter: (ctx) => {
            this.context = ctx
            this.session = ctx.session
          },
        },
        ...(evalCase.hooks ?? []),
        {
          onError: (ctx) => {
            this.handlerError = ctx.error
          },
          onExit: (ctx) => this.onHandlerExit(ctx),
        },
      ],
    }
  }

  private onHandlerExit(ctx: LiveVoiceExitContext<S>): void {
    this.context = ctx
    this.session = ctx.session
    this.callUsage = ctx.usage
    const ending = ctx.session.events.findLast(
      (event) => event.type === 'annotation' && event.label === 'live-call-ended',
    )
    const data = ending?.type === 'annotation' ? ending.data : undefined
    if (data?.reason === 'error')
      this.finish('error', this.handlerError ?? new Error('Live voice handler failed'))
    else if (data?.backendSettled === false)
      this.finish('error', new Error('Live backend work did not settle before close'))
    else this.finish(liveExitStatus(data?.reason))
  }

  /** The LiveKit job context the eval supplies to the production handler. */
  private job(): LiveVoiceJob {
    return {
      room: this.agentRoom,
      connect: async () => {},
      waitForParticipant: () => waitForCaller(this.agentRoom, this.sdk.rtc.RoomEvent),
      addShutdownCallback: (callback) => {
        this.shutdown.push(callback)
      },
      shutdown: () => this.finish('completed'),
    }
  }

  private async cleanup(
    label: string,
    operation: () => Promise<unknown>,
    budgetMs = 5_000,
  ): Promise<void> {
    try {
      await withTimeout(
        operation(),
        budgetMs,
        () => new Error(`Voice eval cleanup timed out: ${label}`),
      )
    } catch (cause) {
      this.finish('error', cause)
    }
  }

  private async shutdownHandler(): Promise<void> {
    for (const callback of this.shutdown.splice(0))
      await this.cleanup(
        'Live handler shutdown',
        callback,
        Math.max(1, this.window.timeoutMs - (Date.now() - this.startedAtMs)),
      )
  }

  private async release(startup: Promise<void>): Promise<void> {
    await this.shutdownHandler()
    await this.cleanup('caller session', () => this.caller.close())
    const recorder = this.recorder
    if (recorder)
      await this.cleanup('recording', async () => {
        this.recordingPath = await recorder.stop()
      })
    await this.cleanup('room connections', () =>
      Promise.all([this.agentRoom.disconnect(), this.userRoom.disconnect()]),
    )
    await this.cleanup('startup cancellation', () => startup)
    // Startup can register its shutdown callback just before cancellation is observed.
    await this.shutdownHandler()
    await this.cleanup('room deletion', () => this.service.deleteRoom(this.roomName))
  }

  private async collect(): Promise<VoiceRunResult<S>> {
    const { app, sessionService } = this.appContext
    const liveTranscript = this.context?.transcript.snapshot()
    try {
      this.session = this.context?.session ?? (await app.sessions.get(this.callId)) ?? this.session
      if (liveTranscript) {
        for (const event of transcriptMessages(liveTranscript, this.evalCase.backend.name))
          await sessionService.appendEvent(this.session, event)
        for (const event of this.session.events.filter(
          (candidate) => candidate.type === 'annotation' && candidate.label === 'live-backend-work',
        )) {
          if (
            event.type !== 'annotation' ||
            event.label !== 'live-backend-work' ||
            typeof event.data?.backendSessionId !== 'string'
          )
            continue
          const backendSession = await app.sessions.get(event.data.backendSessionId)
          for (const usage of backendSession?.events ?? []) {
            if (usage.type === 'model_end') await sessionService.appendEvent(this.session, usage)
          }
        }
        if (!(await app.sessions.commit(this.session)).ok)
          throw new Error('Voice eval result commit conflict')
      }
    } catch (cause) {
      this.finish('error', cause)
    }
    const transcript = (liveTranscript?.fragments ?? []).map((fragment, turnIndex) => ({
      role: fragment.speaker === 'caller' ? ('user' as const) : ('assistant' as const),
      text: fragment.text,
      startMs: fragment.startMs ?? undefined,
      endMs: fragment.endMs ?? undefined,
      turnIndex,
    }))
    const usage = computeUsageSummary(this.session.events)
    for (const message of transcript)
      this.writer?.appendLine(
        `${((message.startMs ?? 0) / 1000).toFixed(2)}s **${message.role}**: ${message.text}`,
      )
    return {
      status: this.status,
      startedAtMs: this.startedAtMs,
      session: this.session,
      events: this.session.events.toSorted((a, b) => a.createdAt - b.createdAt),
      voiceEvents: [],
      transcript,
      liveTranscript,
      timing: (this.recorder?.tracker ?? this.tracker).finalize(),
      recording: { path: this.recordingPath },
      usage,
      usageScope: 'backend',
      liveUsage: summarizeLiveEvalUsage({
        backend: usage,
        call: this.callUsage,
        voiceModel: getModelName(this.evalCase.agent.model),
        callerCalls: this.callerCalls,
      }),
      error: this.error,
      durationMs: Date.now() - this.startedAtMs,
    }
  }
}

/**
 * Runs one Live voice eval case through the production handler in a fresh LiveKit room.
 *
 * @returns The run status, call session, transcript, timing and backend usage.
 */
export async function runLiveVoiceCase<S extends StateSchema>(
  evalCase: LiveVoiceEvalCase<S>,
  options: VoiceEvalOptions<S> & { room: VoiceRoomConfig },
  appContext: LiveVoiceAppContext<S>,
  writer?: CaseWriter,
  recordingDir?: string,
  deps = { sdk: requireLiveKit, handler: createLiveVoiceHandler },
): Promise<VoiceRunResult<S>> {
  const durationMs = evalCase.durationMs ?? 30_000
  const timeoutMs = evalCase.timeout ?? durationMs + 60_000
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error('Live voice eval durationMs and timeout must be finite and positive')
  if (options.hooks?.length)
    throw new Error(
      'Live voice evals use case.hooks, the same hooks as app.handler.voice; options.hooks is for Realtime',
    )
  if (!isRealtimeConfig(evalCase.userAgent.model))
    throw new Error('Voice eval userAgent requires a Realtime model')
  if (!evalCase.hooks?.some((hook) => hook.onResult))
    throw new Error('Live voice eval requires the production onResult hook')
  const backend = evalCase.toolMocks
    ? interceptTools(evalCase.backend, evalCase.toolMocks)
    : evalCase.backend
  if (backend.kind !== 'agent') throw new Error('Live voice backend must be an ADK agent')
  const sdk: LiveKitSdk = deps.sdk()
  return new LiveVoiceCaseRun(
    evalCase,
    options,
    appContext,
    sdk,
    deps.handler,
    backend,
    evalCase.userAgent.model,
    { durationMs, timeoutMs },
    writer,
    recordingDir,
  ).execute()
}
