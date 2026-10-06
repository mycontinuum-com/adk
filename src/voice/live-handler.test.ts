import { defineAgent, isAgent } from '@livekit/agents'
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { z } from 'zod'

import type { Event } from '../types/events'
import type {
  LiveVoiceActivityContext,
  LiveVoiceErrorContext,
  LiveVoiceExitContext,
  LiveVoiceResultContext,
  LiveVoiceControls,
  LiveVoiceContext,
  LiveVoiceHook,
} from './live-types'
import type { NoiseCancellationType, RecordingConfig, SoundConfig } from './types'

import { adk } from '../api'
import { openai } from '../providers/models'
import { serializeContext } from '../providers/openai'
import { configurePricing } from '../providers/pricing'
import { InMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { useTestPricing } from '../test-support/pricing-registry'
import { UsageReportingAdapter } from '../test-support/usage-adapter'
import { createLiveVoiceHandler, LiveContentFilterError } from './live-handler'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function isBackendWork(event: Event): boolean {
  return event.type === 'annotation' && event.label === 'live-backend-work'
}
class LiveSession extends EventEmitter {
  sessionId: string | undefined = 'connection-one'
  sent: Array<{ kind: string; text: string; delegationId?: string }> = []
  input: string[] = []
  /** The agent session that plays what GPT Live says; unset leaves every line unsaid. */
  voice?: EventEmitter
  muteInput() {
    this.input.push('mute')
  }
  unmuteInput() {
    this.input.push('unmute')
  }
  appendThinking(text: string, options: { delegationId?: string }) {
    this.sent.push({ kind: 'thinking', text, ...options })
  }
  appendCommentary(text: string, options: { delegationId?: string }) {
    this.sent.push({ kind: 'commentary', text, ...options })
    const voice = this.voice
    if (voice) setTimeout(() => this.speak(voice), 1)
  }
  /** GPT Live taking one speaking turn. */
  speak(voice: EventEmitter) {
    voice.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
    setTimeout(
      () => voice.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' }),
      5,
    )
  }
  appendInstructions(text: string, options: { delegationId?: string }) {
    this.sent.push({ kind: 'instructions', text, ...options })
  }
  fragment(
    role: 'user' | 'assistant',
    text: string,
    eventId: string,
    startMs?: number,
    endMs?: number,
  ) {
    this.emit('openai_server_event_received', {
      type: role === 'user' ? 'session.input_transcript.delta' : 'session.output_transcript.delta',
      event_id: eventId,
      delta: text,
      start_ms: startMs,
      end_ms: endMs,
    })
  }
  dispatch(id: string, pendingTranscript: string) {
    this.fragment('user', pendingTranscript, `input-${id}`)
    this.emit('openai_server_event_received', {
      type: 'session.delegation.created',
      delegation: { id, target: 'client' },
    })
    this.emit('delegation_created', { id, pendingTranscript })
  }
}
async function fixture(
  options: {
    gates?: Record<string, ReturnType<typeof gate>>
    failResult?: boolean | 'once'
    /** The result hook's error message. */
    failMessage?: string
    /** The error hook waits for this before it decides. */
    errorGate?: ReturnType<typeof gate>
    errorAction?: 'continue' | 'end'
    omitResult?: boolean
    invalidContext?: boolean
    setupId?: string
    toolProgress?: boolean
    toolState?: boolean
    endInsideTool?: boolean
    omitError?: boolean
    detachedEnter?: boolean
    renderGate?: ReturnType<typeof gate>
    failEnter?: boolean
    startPending?: boolean
    enterGate?: ReturnType<typeof gate>
    agentScope?: boolean
    backendTimeoutMs?: number
    backendUsage?: boolean
    resultGate?: ReturnType<typeof gate>
    clock?: () => number
    playoutTimeoutMs?: number
    /** GPT Live says the commentary lines it is given; otherwise a test says them. */
    speakingAgent?: boolean
    timeouts?: { inactivity?: number; expiry?: number }
    lifecycle?: Pick<LiveVoiceHook, 'onInactivity' | 'onExpiry'>
    /** Further hooks after the fixture's own, such as `onVoiceActivity` hooks. */
    extraHooks?: LiveVoiceHook[]
    recording?: RecordingConfig
    sound?: SoundConfig
    /** The background audio player throws when it plays a sound, or when a sound is stopped. */
    soundFails?: 'play' | 'stop'
    /** Per-call recording and noise settings returned by `setup`. */
    callSetup?: { recordingKey?: string; noiseCancellation?: NoiseCancellationType }
    /** The egress client's stopEgress rejects. */
    failEgressStop?: boolean
    /** The egress client's startRoomCompositeEgress rejects with this error. */
    failEgressStart?: Error
  } = {},
) {
  const store = new InMemoryStore()
  const closeStore = vi.spyOn(store, 'close')
  const adapter = new UsageReportingAdapter({
    responses: ['first', 'second', 'third'].map((id) => ({
      toolCalls: [{ name: 'lookup', args: { id } }],
    })),
  })
  adapter.reportUsage = Boolean(options.backendUsage)
  const app = adk({
    name: 'live-test',
    store,
    adapters: { openai: adapter },
    schema: { session: { answer: z.string().default('') } },
  })
  cleanup.push(() => app.close())
  const started: string[] = []
  const finished: string[] = []
  const signals = new Map<string, AbortSignal | undefined>()
  const renderedHistory: Event[][] = []
  const toolVoices = new Map<string, LiveVoiceControls>()
  const previousAnswers: unknown[] = []
  const toolStateBefore: Array<{ id: string; answer: string }> = []
  const backend = app.agent({
    name: 'lookup',
    model: openai('mock'),
    context: [
      app.context.history(options.agentScope ? { scope: 'agent' } : undefined),
      (ctx) => {
        renderedHistory.push(structuredClone([...ctx.session.events]))
        return ctx
      },
    ],
    tools: [
      app.tool({
        name: 'lookup',
        description: 'Synthetic lookup',
        schema: z.object({ id: z.string() }),
        async execute(ctx) {
          started.push(ctx.args.id)
          toolStateBefore.push({ id: ctx.args.id, answer: ctx.state.answer })
          signals.set(ctx.args.id, ctx.signal)
          if (ctx.voice && 'appendCommentary' in ctx.voice) {
            toolVoices.set(ctx.args.id, ctx.voice)
            if (options.toolProgress) ctx.voice.appendCommentary('Working')
          }
          try {
            await options.gates?.[ctx.args.id]?.promise
            if (options.toolState) ctx.state.update({ answer: `tool-${ctx.args.id}` })
            if (options.endInsideTool && ctx.voice && 'appendCommentary' in ctx.voice) {
              ctx.voice.end()
              ctx.voice.end()
            }
            return ctx.output({ reply: ctx.args.id })
          } finally {
            finished.push(ctx.args.id)
          }
        },
      }),
    ],
  })
  class VoiceAgent {
    constructor(readonly frontendConfig: { instructions: string }) {}
    duplexSession = Object.assign(new LiveSession(), {
      sessionId: options.startPending ? undefined : 'connection-one',
    })
    chatCtx = {
      items: [
        { type: 'message', role: 'user', textContent: 'Original question', interrupted: false },
        { type: 'message', role: 'assistant', textContent: 'Which day?', interrupted: true },
      ],
    }
    async onEnter() {}
    async onExit() {}
  }
  const sessions: VoiceSession[] = []
  const startCalls = vi.fn<() => void>()
  const renderStarted = vi.fn<() => void>()
  const entryErrors: unknown[] = []
  const shutdowns: Array<() => Promise<void>> = []
  /** Start of the egress and of the voice session, and egress stops, in order. */
  const order: string[] = []
  const startOptions: Array<{ inputOptions?: Record<string, unknown> }> = []
  const egressStarts: Array<Record<string, unknown>> = []
  const egressStops: string[] = []
  /** Background audio players, sound files read, and every sound played, in order. */
  const backgroundAudio: string[] = []
  const soundFiles: string[] = []
  const plays: Array<{ volume: number; stopped: boolean }> = []
  class BackgroundAudioPlayer {
    async start() {
      backgroundAudio.push('start')
    }
    play(audio: { volume: number }) {
      if (options.soundFails === 'play') throw new Error('Synthetic player failure')
      const play = { volume: audio.volume, stopped: false }
      plays.push(play)
      return {
        done: () => play.stopped,
        stop: () => {
          if (options.soundFails === 'stop') throw new Error('Synthetic player failure')
          play.stopped = true
        },
        waitForPlayout: async () => {},
      }
    }
    async close() {
      backgroundAudio.push('close')
    }
  }
  async function* audioFramesFromFile(source: string) {
    soundFiles.push(source)
    yield { source }
  }
  class VoiceSession extends EventEmitter {
    agent?: VoiceAgent
    closed = false
    constructor() {
      super()
      sessions.push(this)
    }
    async start({
      agent,
      inputOptions,
    }: {
      agent: VoiceAgent
      inputOptions?: Record<string, unknown>
    }) {
      startCalls()
      order.push('voice-start')
      startOptions.push({ inputOptions })
      this.agent = agent
      if (options.speakingAgent) agent.duplexSession.voice = this
      const entered = agent.onEnter()
      if (options.detachedEnter) void entered.catch((error) => entryErrors.push(error))
      else await entered
      agent.duplexSession.fragment('user', 'Original question', 'original', 0, 1000)
      agent.duplexSession.fragment('assistant', 'Which day?', 'question', 800, 1400)
    }
    async close() {
      await this.agent?.onExit()
      this.closed = true
      this.emit('close', { reason: 'test' })
    }
  }
  const error = vi.fn<(ctx: LiveVoiceErrorContext) => Promise<'continue' | 'end' | void>>(
    async (ctx) => {
      await options.errorGate?.promise
      if (options.errorAction === 'continue') ctx.voice.appendCommentary('Recovered')
      return options.errorAction
    },
  )
  const result = vi.fn<(ctx: LiveVoiceResultContext) => void>()
  const exited = vi.fn<(ctx: LiveVoiceExitContext) => void>()
  const entered: LiveVoiceContext[] = []
  const deleteRoom = vi.fn<(room: string) => Promise<void>>(async () => {})
  const logError = vi.fn<(data: unknown, message: string) => void>()
  const setup = vi.fn<() => Promise<{ sessionId: string; state: { answer: string } }>>(
    async () => ({
      sessionId: options.setupId!,
      state: { answer: 'seeded' },
      ...options.callSetup,
    }),
  )
  // Only the external LiveKit transport is replaced; backend execution and persistence are real ADK.
  const deps = {
    agents: () => ({
      defineAgent,
      voice: {
        Agent: VoiceAgent,
        AgentSession: VoiceSession,
        BackgroundAudioPlayer,
        AgentSessionEventTypes: {
          Close: 'close',
          MetricsCollected: 'metrics_collected',
          UserStateChanged: 'user_state_changed',
          AgentStateChanged: 'agent_state_changed',
          SpeechCreated: 'speech_created',
        },
      },
      log: () => ({ error: logError }),
      audioFramesFromFile,
    }),
    clock: options.clock,
    lineSettleMs: 10,
    openai: () => ({ realtime: { GPTLiveModel: class {}, GPTLiveSession: LiveSession } }),
    livekitServer: () => ({
      RoomServiceClient: class {
        deleteRoom = deleteRoom
      },
      EgressClient: class {
        async startRoomCompositeEgress(
          room: string,
          output: { filepath: string; output: { value: { bucket: string; region: string } } },
          opts: { audioOnly: boolean },
        ) {
          order.push('egress-start')
          if (options.failEgressStart) throw options.failEgressStart
          egressStarts.push({
            room,
            filepath: output.filepath,
            bucket: output.output.value.bucket,
            region: output.output.value.region,
            audioOnly: opts.audioOnly,
          })
          return { egressId: `egress-${egressStarts.length}` }
        }
        async stopEgress(id: string) {
          order.push('egress-stop')
          egressStops.push(id)
          if (options.failEgressStop) throw new Error('Egress stop failed')
        }
      },
      EncodedFileOutput: class {
        constructor(opts: Record<string, unknown>) {
          Object.assign(this, opts)
        }
      },
      S3Upload: class {
        constructor(opts: Record<string, unknown>) {
          Object.assign(this, opts)
        }
      },
      EncodedFileType: { OGG: 'ogg' },
    }),
    noiseCancellation: () => ({
      TelephonyBackgroundVoiceCancellation: () => ({ moduleId: 'telephony-filter', options: {} }),
      BackgroundVoiceCancellation: () => ({ moduleId: 'general-filter', options: {} }),
    }),
  } as unknown as NonNullable<Parameters<typeof createLiveVoiceHandler>[2]>
  const handler = createLiveVoiceHandler(
    {
      agent: app.agent({
        name: 'voice',
        model: openai.live('gpt-live-1'),
        context: [
          options.invalidContext
            ? app.context.user('Unsupported frontend message')
            : app.context.system('Synthetic example'),
          async (ctx) => {
            renderStarted()
            await options.renderGate?.promise
            return ctx
          },
        ],
      }),
      backend,
      backendTimeoutMs: options.backendTimeoutMs,
      playoutTimeoutMs: options.playoutTimeoutMs ?? 50,
      timeouts: options.timeouts,
      recording: options.recording,
      sound: options.sound,
      setup: options.setupId || options.callSetup ? setup : undefined,
      callTermination: {
        strategy: 'deleteRoom',
        livekitUrl: 'ws://synthetic.invalid',
        apiKey: 'synthetic',
        apiSecret: 'synthetic',
      },
      hooks: [
        {
          async onEnter(ctx) {
            entered.push(ctx)
            await options.enterGate?.promise
            ctx.voice.appendThinking('Think')
            ctx.voice.appendInstructions('Brief replies')
            ctx.voice.appendCommentary('Hello')
            if (options.failEnter) throw new Error('Enter failed')
          },
          onResult: options.omitResult
            ? undefined
            : async (ctx) => {
                const { reply } = z.object({ reply: z.string() }).parse(ctx.output)
                previousAnswers.push(ctx.state.answer)
                ctx.state.update({ answer: reply })
                result(ctx)
                if (
                  options.failResult === true ||
                  (options.failResult === 'once' && result.mock.calls.length === 1)
                )
                  throw new Error(options.failMessage ?? 'Result failed')
                if (options.resultGate) {
                  await options.resultGate.promise
                  ctx.state.update({ answer: `late-${reply}` })
                }
                ctx.voice.appendCommentary(reply)
              },
          onError: options.omitError ? undefined : error,
          onExit: exited,
        },
        ...(options.lifecycle ? [options.lifecycle] : []),
        ...(options.extraHooks ?? []),
      ],
    },
    { app, store, sessionService: sessionService(store) },
    deps,
  )
  async function call() {
    let shutdown!: () => Promise<void>
    const pending = handler.entry({
      room: { name: `room-${sessions.length + 1}` },
      connect: async () => {},
      waitForParticipant: async () => ({ identity: 'synthetic-caller' }),
      addShutdownCallback(callback: () => Promise<void>) {
        shutdown = callback
        shutdowns.push(callback)
      },
      shutdown() {},
    })
    cleanup.push(() => shutdown())
    for (const value of Object.values(options.gates ?? {})) cleanup.push(value.release)
    if (options.enterGate) cleanup.push(options.enterGate.release)
    if (options.renderGate) cleanup.push(options.renderGate.release)
    await pending
    const session = sessions.at(-1)!
    return {
      session,
      get agent() {
        if (!session.agent) throw new Error('Test voice agent was not started')
        return session.agent
      },
      get live() {
        if (!session.agent) throw new Error('Test voice agent was not started')
        return session.agent.duplexSession
      },
      shutdown,
    }
  }
  return {
    handler,
    logError,
    app,
    store,
    closeStore,
    adapter,
    started,
    finished,
    signals,
    renderedHistory,
    toolVoices,
    previousAnswers,
    toolStateBefore,
    deleteRoom,
    setup,
    entered,
    error,
    result,
    exited,
    sessions,
    startCalls,
    renderStarted,
    entryErrors,
    shutdowns,
    order,
    startOptions,
    egressStarts,
    egressStops,
    backgroundAudio,
    soundFiles,
    plays,
    /** Volumes of the sounds playing now. */
    playing: () => plays.filter((play) => !play.stopped).map((play) => play.volume),
    call,
  }
}

describe('Live voice handler', () => {
  test('exports a worker definition recognized by LiveKit', async () => {
    const { handler } = await fixture()
    expect(isAgent(handler)).toBe(true)
    expect(handler.start).toBeTypeOf('function')
  })
  test('keeps lifecycle controls call-scoped across startup and reconnect until shutdown', async () => {
    const enterGate = gate()
    const f = await fixture({ startPending: true, enterGate })
    const pending = f.call()
    await vi.waitFor(() => expect(f.entered).toHaveLength(1))
    const live = f.sessions[0]!.agent!.duplexSession
    expect(live.sent).toEqual([])
    live.emit('openai_server_event_received', {
      type: 'session.started',
      session: { id: 'first-connection' },
    })
    live.sessionId = 'first-connection'
    enterGate.release()
    const call = await pending
    expect(live.sent.map((item) => item.text)).toEqual(['Think', 'Brief replies', 'Hello'])
    live.emit('openai_server_event_received', {
      type: 'session.started',
      session: { id: 'replacement-connection' },
    })
    live.sessionId = 'replacement-connection'
    f.entered[0]!.voice.appendCommentary('Call-level update')
    expect(live.sent.at(-1)).toEqual({
      kind: 'commentary',
      text: 'Call-level update',
      delegationId: undefined,
    })
    await call.shutdown()
    f.entered[0]!.voice.appendCommentary('After shutdown')
    expect(live.sent).toHaveLength(4)
  })
  test('executes each delegation once despite duplicate delivery during and after its run', async () => {
    const first = gate()
    const f = await fixture({ gates: { first } })
    const call = await f.call()
    call.live.dispatch('same-id', 'First question')
    call.live.dispatch('same-id', 'First question')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.live.dispatch('same-id', 'First question')
    first.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    call.live.dispatch('same-id', 'First question')
    call.live.dispatch('next-id', 'Second question')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
    await call.shutdown()
    expect(f.started).toEqual(['first', 'second'])
    expect(call.live.sent.slice(3)).toEqual([
      { kind: 'commentary', text: 'first', delegationId: 'same-id' },
      { kind: 'commentary', text: 'second', delegationId: 'next-id' },
    ])
  })
  test('freezes context before async work and persists tool results and hook state', async () => {
    const f = await fixture(),
      call = await f.call()
    call.live.dispatch('first-id', 'Opening hours?')
    call.live.fragment('user', 'Late native fragment', 'late-native', 100, 200)
    call.agent.chatCtx.items[0]!.textContent = 'Changed after dispatch'
    call.agent.chatCtx.items.push({
      type: 'message',
      role: 'user',
      textContent: 'Future message',
      interrupted: false,
    })
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await call.shutdown()
    const saved = await f.store.load('live-test', f.result.mock.calls[0]![0].backendSession.id)
    const conversationEvents = (events: readonly Event[]) =>
      events.flatMap((event) =>
        event.type === 'user' || event.type === 'assistant'
          ? [{ role: event.type, text: event.text }]
          : [],
      )
    const expectedHistory = [
      { role: 'user', text: 'Original question' },
      { role: 'assistant', text: 'Which day?' },
      { role: 'user', text: 'Opening hours?' },
    ]
    expect(conversationEvents(saved!.events)).toEqual(expectedHistory)
    expect(
      saved!.events
        .filter(
          (event) =>
            (event.type === 'user' || event.type === 'assistant') && event.source === 'transcript',
        )
        .map((event) => event.type),
    ).toEqual(['user', 'assistant', 'user'])
    expect(conversationEvents(f.renderedHistory[0]!)).toEqual(expectedHistory)
    const serialized = JSON.stringify(serializeContext(f.adapter.stepCalls[0]!.ctx))
    expect(serialized).toContain('Receipt order is not turn order')
    expect(serialized).toContain('0–1000 ms] Original question')
    expect(serialized).toContain('800–1400 ms] Which day?')
    expect(serialized).toContain('?–? ms] Opening hours?')
    expect(serialized).not.toContain('Future message')
    expect(serialized).not.toContain('Late native fragment')
    expect(call.agent.frontendConfig.instructions).toBe('Synthetic example')
    expect(saved!.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_result', name: 'lookup' })]),
    )
    expect((await f.app.sessions.get(f.entered[0]!.session.id))!.state.answer).toBe('first')
    expect(f.result.mock.calls[0]![0].session).toBe(f.entered[0]!.session)
    expect(f.result.mock.calls[0]![0].backendSession.id).not.toBe(f.entered[0]!.session.id)
    expect(call.live.sent).toEqual([
      { kind: 'thinking', text: 'Think', delegationId: undefined },
      { kind: 'instructions', text: 'Brief replies', delegationId: undefined },
      { kind: 'commentary', text: 'Hello', delegationId: undefined },
      { kind: 'commentary', text: 'first', delegationId: 'first-id' },
    ])
  })
  test('serializes overlapping delegations and shares committed call state between results', async () => {
    const first = gate(),
      f = await fixture({ gates: { first }, toolState: true }),
      call = await f.call()
    call.live.dispatch('slow-id', 'First question')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.agent.chatCtx.items[0]!.textContent = 'Second snapshot'
    call.live.dispatch('fast-id', 'Second question')
    call.agent.chatCtx.items[0]!.textContent = 'Later mutation'
    call.live.fragment('user', 'After second snapshot', 'after-second', 150, 200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.started).toEqual(['first'])
    expect(f.result).not.toHaveBeenCalled()
    first.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
    expect(call.live.sent.slice(3)).toEqual([
      { kind: 'commentary', text: 'first', delegationId: 'slow-id' },
      { kind: 'commentary', text: 'second', delegationId: 'fast-id' },
    ])
    expect(f.previousAnswers).toEqual(['tool-first', 'tool-second'])
    expect(f.toolStateBefore).toEqual([
      { id: 'first', answer: '' },
      { id: 'second', answer: 'first' },
    ])
    expect(
      f.renderedHistory[1]!.filter((event) => event.type === 'user').map((event) => event.text),
    ).toEqual(['Original question', 'First question', 'Second question'])
    const second = f.renderedHistory[1]!
    expect(second.filter((event) => event.type === 'tool_call')).toHaveLength(1)
    expect(second.filter((event) => event.type === 'tool_result')).toHaveLength(1)
    expect(second.filter((event) => event.type === 'assistant').map((event) => event.text)).toEqual(
      ['Which day?'],
    )
    const providerInput = serializeContext(f.adapter.stepCalls[1]!.ctx)
    expect(providerInput.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Second question'),
    })
    const serialized = JSON.stringify(serializeContext(f.adapter.stepCalls[1]!.ctx))
    expect(serialized).toContain('Work may postdate the frozen voice snapshot')
    expect(serialized).toContain('function_call_output')
    expect(serialized).not.toContain('After second snapshot')
    call.live.dispatch('third-id', 'Third question')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(3))
    const thirdInput = serializeContext(f.adapter.stepCalls[2]!.ctx)
    expect(thirdInput.slice(0, providerInput.length)).toEqual(providerInput)
    expect(JSON.stringify(thirdInput)).toContain('After second snapshot')
  })
  test('preserves provider prefixes for queued equal boundaries and a reconnected delegation', async () => {
    const first = gate()
    const f = await fixture({ gates: { first } })
    const call = await f.call()
    call.live.dispatch('first-id', 'Same snapshot')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.live.emit('delegation_created', { id: 'second-id' })
    call.live.fragment('user', 'While waiting', 'waiting')
    first.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
    expect(f.result.mock.calls[0]![0].delegation.nativeThrough).toBe(
      f.result.mock.calls[1]![0].delegation.nativeThrough,
    )
    call.live.emit('openai_server_event_received', {
      type: 'session.started',
      session: { id: 'connection-two' },
    })
    call.live.sessionId = 'connection-two'
    call.live.dispatch('third-id', 'After reconnect')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(3))
    const inputs = f.adapter.stepCalls.map(({ ctx }) => serializeContext(ctx))
    expect(inputs[1]!.slice(0, inputs[0]!.length)).toEqual(inputs[0])
    expect(inputs[2]!.slice(0, inputs[1]!.length)).toEqual(inputs[1])
    expect(JSON.stringify(inputs[1])).not.toContain('While waiting')
    expect(JSON.stringify(inputs[2])).toContain('While waiting')
    expect(JSON.stringify(inputs[2])).toContain('connection 2; ?–? ms] After reconnect')
    expect(f.started).toEqual(['first', 'second', 'third'])
  })
  test('retains three delegations of tool work exactly once without mutating the call ledger', async () => {
    const f = await fixture()
    f.adapter.setResponses(
      ['first', 'second', 'third'].map((id) => ({
        text: `Backend guidance for ${id}`,
        toolCalls: [{ name: 'lookup', args: { id } }],
      })),
    )
    const call = await f.call()
    const originalNotes: Event[] = []
    let previousInput: ReturnType<typeof serializeContext> = []
    for (const [index, id] of ['first', 'second', 'third'].entries()) {
      call.live.dispatch(id, `${id} question`)
      await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(index + 1))
      const input = serializeContext(f.adapter.stepCalls[index]!.ctx)
      expect(input.slice(0, previousInput.length)).toEqual(previousInput)
      expect(JSON.stringify(input)).toContain(`${id} question`)
      previousInput = structuredClone(input)
      const backend = f.result.mock.calls[index]![0].backendSession
      const calls = backend.events.filter((event) => event.type === 'tool_call')
      const results = backend.events.filter((event) => event.type === 'tool_result')
      expect(calls.map((event) => event.args.id)).toEqual(
        ['first', 'second', 'third'].slice(0, index + 1),
      )
      expect(results.map((event) => event.callId)).toEqual(calls.map((event) => event.callId))
      expect(new Set(calls.map((event) => event.id)).size).toBe(index + 1)
      expect(new Set(results.map((event) => event.id)).size).toBe(index + 1)
      expect(
        backend.events.filter((event) => event.type === 'assistant').map((event) => event.text),
      ).toEqual(['Which day?', `Backend guidance for ${id}`])
      const notes = f.entered[0]!.session.events.filter((event) => event.type === 'system')
      expect(notes).toHaveLength(index + 1)
      originalNotes.push(notes[index]!)
      expect(originalNotes.map((event) => event.invocationId)).toEqual(Array(index + 1).fill(''))
    }
    await call.shutdown()
    const saved = await f.app.sessions.get(f.entered[0]!.callId)
    expect(saved!.events.filter((event) => event.type === 'assistant')).toEqual([])
    expect(saved!.events.filter((event) => event.type === 'tool_call')).toHaveLength(3)
    expect(saved!.events.filter((event) => event.type === 'tool_result')).toHaveLength(3)
    expect(
      saved!.events.filter((event) => event.type === 'system').map((event) => event.invocationId),
    ).toEqual(['', '', ''])
    expect(originalNotes.map((event) => event.invocationId)).toEqual(['', '', ''])
  })
  test('uses ordinary agent-scoped history for overlapping fragments across reconnects', async () => {
    const f = await fixture({ agentScope: true })
    const call = await f.call()
    call.live.fragment(
      'assistant',
      'Is that your address, and may I send',
      'question-two',
      2000,
      5000,
    )
    call.live.fragment('user', 'Yes', 'yes', 2500, 2800)
    call.live.emit('openai_server_event_received', {
      type: 'session.started',
      session: { id: 'connection-two' },
    })
    call.live.sessionId = 'connection-two'
    call.live.fragment('user', 'Actually no', 'yes', 0, 500)
    // GPT Live's caller deltas carry their own spacing; the caller's run is one message.
    call.live.dispatch('overlap', ', wait')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    const backend = f.result.mock.calls[0]![0].backendSession
    const messages = backend.events.filter(
      (event) => event.type === 'user' || event.type === 'assistant',
    )
    expect(messages.map((event) => event.text)).toEqual([
      'Original question',
      'Which day?',
      'Is that your address, and may I send',
      'Yes',
      'Actually no, wait',
    ])
    expect(messages[2]).toMatchObject({
      agentName: 'lookup',
      transcriptFragment: { startMs: 2000, endMs: 5000 },
    })
    expect(messages[3]).toMatchObject({
      transcriptFragment: { connection: { index: 1 }, startMs: 2500, endMs: 2800 },
    })
    expect(messages[4]).toMatchObject({
      transcriptFragment: { connection: { index: 2 }, startMs: 0, endMs: 500 },
    })
    const serialized = JSON.stringify(serializeContext(f.adapter.stepCalls[0]!.ctx))
    expect(serialized).toContain('2000–5000 ms] Is that your address, and may I send')
    expect(serialized).toContain('2500–2800 ms] Yes')
    expect(serialized).toContain('connection 2; 0–500 ms] Actually no, wait')
    expect(serialized).toContain('not proof the caller heard it')
    const reloaded = await f.app.sessions.get(backend.id)
    const transcriptFacts = (events: readonly Event[]) =>
      events.flatMap((event) =>
        event.type === 'user' || event.type === 'assistant'
          ? [
              {
                id: event.id,
                text: event.text,
                createdAt: event.createdAt,
                fragment: event.transcriptFragment,
              },
            ]
          : [],
      )
    expect(transcriptFacts(reloaded!.events)).toEqual(transcriptFacts(backend.events))
    await call.shutdown()
  })
  test('persists stale-connection work without sending its result to a new connection', async () => {
    const first = gate(),
      f = await fixture({ gates: { first } }),
      call = await f.call()
    call.live.dispatch('old-id', 'Question')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.live.sessionId = 'connection-two'
    first.release()
    await vi.waitFor(() => expect(f.finished).toEqual(['first']))
    await call.shutdown()
    expect(f.result).not.toHaveBeenCalled()
    expect(call.live.sent).toHaveLength(3)
    const saved = await Promise.all(
      (await f.store.list('live-test')).map((row) => f.store.load('live-test', row.id)),
    )
    expect(saved.some((row) => row!.events.some((event) => event.type === 'tool_result'))).toBe(
      true,
    )
  })
  test('a reconnect asking again for an in-flight caller turn gets that run, not a second one', async () => {
    const first = gate(),
      f = await fixture({ gates: { first } }),
      call = await f.call()
    call.live.dispatch('old-id', 'Book the appointment')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.live.emit('openai_server_event_received', {
      type: 'session.started',
      session: { id: 'connection-two' },
    })
    call.live.sessionId = 'connection-two'
    // The new connection delegates the same caller turn while the first run is still going.
    call.live.emit('delegation_created', { id: 'new-id' })
    first.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await call.shutdown()
    expect(f.started).toEqual(['first'])
    expect(f.adapter.stepCalls).toHaveLength(1)
    expect(f.result.mock.calls[0]![0]).toMatchObject({
      delegation: { id: 'new-id', connectionId: 'connection-two' },
      output: { reply: 'first' },
    })
    expect(call.live.sent.at(-1)).toEqual({
      kind: 'commentary',
      text: 'first',
      delegationId: 'new-id',
    })
    const saved = await f.app.sessions.get(f.entered[0]!.callId)
    expect(saved!.events.filter((event) => event.type === 'tool_result')).toHaveLength(1)
  })
  test('after a reconnect, a delegation the caller spoke for again runs its own backend', async () => {
    const first = gate(),
      f = await fixture({ gates: { first } }),
      call = await f.call()
    call.live.dispatch('old-id', 'Book the appointment')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.live.sessionId = 'connection-two'
    call.session.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
    call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
    call.live.dispatch('new-id', 'Actually, cancel it')
    first.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await call.shutdown()
    expect(f.started).toEqual(['first', 'second'])
    expect(f.result.mock.calls[0]![0]).toMatchObject({
      delegation: { id: 'new-id', connectionId: 'connection-two' },
      output: { reply: 'second' },
    })
  })
  test('result hooks cut off by a reconnect are not run again for its repeat of the caller turn', async () => {
    const resultGate = gate(),
      f = await fixture({ resultGate }),
      call = await f.call()
    cleanup.push(resultGate.release)
    call.live.dispatch('old-id', 'Book the appointment')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    call.live.sessionId = 'connection-two'
    call.live.emit('delegation_created', { id: 'new-id' })
    resultGate.release()
    await vi.waitFor(() =>
      expect(call.live.sent).toContainEqual({
        kind: 'thinking',
        text: expect.stringContaining('not repeated'),
        delegationId: 'new-id',
      }),
    )
    await call.shutdown()
    expect(f.result).toHaveBeenCalledTimes(1)
    expect(f.started).toEqual(['first'])
  })
  test('error hooks cut off by a reconnect do not let its repeat run the backend again', async () => {
    const errorGate = gate(),
      f = await fixture({ failResult: true, errorAction: 'continue', errorGate }),
      call = await f.call()
    cleanup.push(errorGate.release)
    call.live.dispatch('old-id', 'Book the appointment')
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1))
    call.live.sessionId = 'connection-two'
    call.live.emit('delegation_created', { id: 'new-id' })
    errorGate.release()
    await vi.waitFor(() =>
      expect(call.live.sent).toContainEqual({
        kind: 'thinking',
        text: expect.stringContaining('not repeated'),
        delegationId: 'new-id',
      }),
    )
    await call.shutdown()
    expect(f.started).toEqual(['first'])
    expect(f.result).toHaveBeenCalledTimes(1)
    expect(f.error).toHaveBeenCalledTimes(1)
  })
  test('a delegation answered on its own connection is not given again after a reconnect', async () => {
    const f = await fixture(),
      call = await f.call()
    call.live.dispatch('old-id', 'Book the appointment')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    call.live.sessionId = 'connection-two'
    call.live.emit('delegation_created', { id: 'new-id' })
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
    await call.shutdown()
    expect(f.started).toEqual(['first', 'second'])
  })
  test('a moderation stop reconnects without the conversation, then goes to the error hooks', async () => {
    const f = await fixture({ errorAction: 'continue' }),
      call = await f.call()
    const history = { items: ['Original question', 'Which day?'] }
    Object.assign(call.live, { history })
    // A reconnect for any other reason is not a moderation stop.
    call.live.emit('session_reconnected', {})
    call.live.emit('openai_server_event_received', {
      type: 'error',
      error: {
        type: 'content_filter',
        code: 'content_filter',
        message: 'Stopped: Patient Okafor said',
      },
    })
    expect(f.logError).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'content_filter', errorCode: 'content_filter' }),
      'Live provider error',
    )
    expect(JSON.stringify(f.logError.mock.calls)).not.toContain('Okafor')
    expect(history.items).toEqual([])
    expect(call.live.sent.at(-1)).toEqual({
      kind: 'instructions',
      text: expect.stringContaining('Do not greet the caller'),
    })
    expect(f.error).not.toHaveBeenCalled()
    call.live.sessionId = 'connection-two'
    call.live.emit('session_reconnected', {})
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1))
    const [ctx] = f.error.mock.calls[0]!
    expect(ctx.error).toBeInstanceOf(LiveContentFilterError)
    expect(ctx.recoverable).toBe(true)
    expect(ctx.delegation).toBeUndefined()
    await vi.waitFor(() =>
      expect(call.live.sent).toContainEqual({ kind: 'commentary', text: 'Recovered' }),
    )
    expect(f.sessions[0]!.closed).toBe(false)
    await call.shutdown()
    expect(f.error).toHaveBeenCalledTimes(1)
  })
  test('a line the caller cannot talk over, lost to a moderation stop, settles at the reconnect', async () => {
    const f = await fixture({ errorAction: 'continue', playoutTimeoutMs: 10_000 }),
      call = await f.call()
    const voice = f.entered[0]!.voice
    voice.appendCommentary('Handoff notice', { allowInterruptions: false })
    const quiet = voice.untilQuiet()
    await vi.waitFor(() =>
      expect(call.live.sent).toContainEqual({ kind: 'commentary', text: 'Handoff notice' }),
    )
    call.live.emit('openai_server_event_received', {
      type: 'error',
      error: { type: 'content_filter', code: 'content_filter' },
    })
    call.live.sessionId = 'connection-two'
    call.live.emit('session_reconnected', {})
    const settled = await Promise.race([
      quiet.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])
    expect(settled).toBe(true)
    expect(f.logError).toHaveBeenCalledWith(expect.anything(), 'Live line_lost_to_moderation')
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1))
    await call.shutdown()
  })
  test('logs a failed hook by its class, never its message', async () => {
    const f = await fixture({ failResult: true, failMessage: 'Patient Okafor not found' }),
      call = await f.call()
    call.live.dispatch('failed-id', 'Question')
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1))
    await call.shutdown()
    expect(f.logError).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: 'failed-id', errorName: 'Error' }),
      'Live backend or persistence failed',
    )
    expect(JSON.stringify(f.logError.mock.calls)).not.toContain('Okafor')
  })
  test('drains tools before transcript close and isolates calls sharing a store', async () => {
    const first = gate(),
      f = await fixture({ gates: { first } }),
      one = await f.call(),
      two = await f.call()
    const transcriptClose = vi.spyOn(f.entered[0]!.transcript, 'close')
    one.live.dispatch('one-id', 'Question one')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    let closed = false
    const shuttingDown = one.shutdown().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closed).toBe(false)
    expect(f.signals.get('first')?.aborted).toBe(true)
    expect(transcriptClose).not.toHaveBeenCalled()
    first.release()
    await shuttingDown
    expect(f.finished).toEqual(['first'])
    expect(transcriptClose).toHaveBeenCalledTimes(1)
    expect(f.closeStore).not.toHaveBeenCalled()
    two.live.dispatch('two-id', 'Question two')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    expect(two.live.sent.at(-1)).toMatchObject({ text: 'second', delegationId: 'two-id' })
    expect(f.entered[0]!.callId).not.toBe(f.entered[1]!.callId)
    expect(one.live.sent).toHaveLength(3)
  })
  test('commits hook state on result failure and reports the originating delegation', async () => {
    const f = await fixture({ failResult: true }),
      call = await f.call()
    call.live.dispatch('failed-id', 'Question')
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1))
    await call.shutdown()
    expect(f.error.mock.calls[0]![0]).toMatchObject({
      delegation: { id: 'failed-id' },
      error: new Error('Result failed'),
    })
    expect((await f.app.sessions.get(f.entered[0]!.session.id))!.state.answer).toBe('first')
    expect(f.exited).toHaveBeenCalledTimes(1)
    expect(call.live.sent).toHaveLength(3)
    expect(f.deleteRoom).toHaveBeenCalledTimes(1)
  })
  test('cleans up once when entry fails without closing the app store', async () => {
    const f = await fixture({ failEnter: true })
    await expect(f.call()).rejects.toThrow('Enter failed')
    expect(f.sessions[0]!.closed).toBe(true)
    expect(f.exited).toHaveBeenCalledTimes(1)
    expect(f.closeStore).not.toHaveBeenCalled()
  })
})

test('setup receives the caller, initializes call state, and rejects reuse of an existing call ID', async () => {
  const f = await fixture({ setupId: 'selected-call' })
  const call = await f.call()
  expect(f.setup).toHaveBeenCalledWith({ identity: 'synthetic-caller' })
  expect(f.entered[0]!.session.id).toBe('session_selected-call')
  expect(f.entered[0]!.state.answer).toBe('seeded')
  call.live.dispatch('lookup', 'Question')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  await call.shutdown()
  await expect(f.call()).rejects.toMatchObject({
    cause: expect.objectContaining({ name: 'ConflictError', sessionId: 'session_selected-call' }),
  })
  expect((await f.app.sessions.get('selected-call'))!.state.answer).toBe('first')
})

test('rejects missing result handling and unsupported frontend conversation context', async () => {
  await expect(fixture({ omitResult: true })).rejects.toThrow(/onResult/)
  const f = await fixture({ invalidContext: true })
  await expect(f.call()).rejects.toThrow(/system instructions only/)
  expect(f.sessions[0]!.closed).toBe(true)
  expect(f.deleteRoom).toHaveBeenCalledTimes(1)
})

test('backend tool controls send progress with the delegation ID and expire after completion', async () => {
  const f = await fixture({ toolProgress: true })
  const call = await f.call()
  call.live.dispatch('progress-id', 'Question')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  expect(call.live.sent.slice(3)).toEqual([
    { kind: 'commentary', text: 'Working', delegationId: 'progress-id' },
    { kind: 'commentary', text: 'first', delegationId: 'progress-id' },
  ])
  const stale = f.toolVoices.get('first')!
  stale.appendCommentary('Late detached progress')
  stale.end()
  expect(call.live.sent).toHaveLength(5)
  expect(f.deleteRoom).not.toHaveBeenCalled()
  f.entered[0]!.voice.appendCommentary('Call still active')
  expect(call.live.sent.at(-1)!.text).toBe('Call still active')
})

test('explicit continuation recovers a result failure and admits the next delegation', async () => {
  const f = await fixture({ failResult: 'once', errorAction: 'continue' })
  const call = await f.call()
  call.live.dispatch('failed-id', 'First question')
  await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1))
  expect(f.error.mock.calls[0]![0].recoverable).toBe(true)
  expect(call.live.sent.at(-1)).toMatchObject({ text: 'Recovered', delegationId: 'failed-id' })
  call.live.dispatch('next-id', 'Next question')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
  expect(call.live.sent.at(-1)).toMatchObject({ text: 'second', delegationId: 'next-id' })
  expect(f.deleteRoom).not.toHaveBeenCalled()
})

test('an unhandled backend failure ends the room and prevents future tool execution', async () => {
  const f = await fixture({ failResult: true, omitError: true })
  const call = await f.call()
  call.live.dispatch('failed-id', 'Question')
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  call.live.dispatch('future-id', 'Future question')
  await call.shutdown()
  expect(f.started).toEqual(['first'])
  expect(f.exited).toHaveBeenCalledTimes(1)
})

test('persistence failure is terminal even when the error hook requests continuation', async () => {
  const f = await fixture({ errorAction: 'continue' })
  const call = await f.call()
  vi.spyOn(f.store, 'commit').mockRejectedValueOnce(new Error('Store unavailable'))
  call.live.dispatch('failed-id', 'Question')
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  expect(f.error.mock.calls[0]![0].recoverable).toBe(false)
  call.live.dispatch('future-id', 'Future question')
  await call.shutdown()
  expect(f.started).toEqual([])
  expect(call.live.sent).toHaveLength(3)
})

test('explicit end is idempotent while natural session close drains without deleting the room', async () => {
  const f = await fixture()
  const call = await f.call()
  f.entered[0]!.voice.end()
  f.entered[0]!.voice.end()
  await call.shutdown()
  expect(f.deleteRoom).toHaveBeenCalledTimes(1)
  expect(f.deleteRoom).toHaveBeenCalledWith('room-1')
  expect(f.exited).toHaveBeenCalledTimes(1)

  const first = gate()
  const natural = await fixture({ gates: { first } })
  const other = await natural.call()
  other.live.dispatch('pending-id', 'Question')
  await vi.waitFor(() => expect(natural.started).toEqual(['first']))
  const transcriptClose = vi.spyOn(natural.entered[0]!.transcript, 'close')
  other.session.emit('close', { reason: 'user-disconnected' })
  expect(natural.signals.get('first')!.aborted).toBe(true)
  expect(transcriptClose).not.toHaveBeenCalled()
  first.release()
  await other.shutdown()
  expect(transcriptClose).toHaveBeenCalledTimes(1)
  expect(natural.exited).toHaveBeenCalledTimes(1)
  expect(natural.deleteRoom).not.toHaveBeenCalled()
})

/** The commentary lines GPT Live has been given with `text`. */
function given(live: LiveSession, text: string) {
  return live.sent.filter((entry) => entry.kind === 'commentary' && entry.text === text)
}

const speaking = (session: EventEmitter) =>
  session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
const listening = (session: EventEmitter) =>
  session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('an uninterrupted line mutes the caller at once and is given once GPT Live is quiet', async () => {
  const f = await fixture({ playoutTimeoutMs: 1_000 })
  const call = await f.call()
  speaking(call.session)
  f.entered[0]!.voice.appendCommentary('Explain the time limit.', { allowInterruptions: false })
  expect(call.live.input).toEqual(['mute'])
  await sleep(50)
  expect(given(call.live, 'Explain the time limit.')).toEqual([])
  listening(call.session)
  await vi.waitFor(() => expect(given(call.live, 'Explain the time limit.')).toHaveLength(1))
  await sleep(50)
  expect(call.live.input).toEqual(['mute'])
  call.live.speak(call.session)
  await vi.waitFor(() => expect(call.live.input).toEqual(['mute', 'unmute']))
  await call.shutdown()
})

test('a line a delegation gives does not wait for its own delegation, and untilQuiet waits for it', async () => {
  const work = gate()
  const f = await fixture({ gates: { first: work }, playoutTimeoutMs: 1_000 })
  const call = await f.call()
  call.live.voice = call.session
  call.live.speak(call.session) // the greeting
  call.live.dispatch('first-id', 'Put me through')
  await vi.waitFor(() => expect(f.started).toEqual(['first']))
  const voice = f.toolVoices.get('first')!
  const givenAt = Date.now()
  voice.appendCommentary('Putting you through.', { allowInterruptions: false })
  await voice.untilQuiet()
  // Well inside the 1 s playout bound, which a line held by its own delegation would reach.
  expect(Date.now() - givenAt).toBeLessThan(800)
  expect(given(call.live, 'Putting you through.')).toHaveLength(1)
  expect(call.live.input).toEqual(['mute', 'unmute'])
  work.release()
  await call.shutdown()
})

test('a muted caller waiting for a line is not prompted for silence', async () => {
  const prompted = vi.fn<() => boolean>(() => false)
  const f = await fixture({
    playoutTimeoutMs: 1_000,
    timeouts: { inactivity: 40 },
    lifecycle: { onInactivity: prompted },
  })
  const call = await f.call()
  speaking(call.session) // GPT Live is busy, so the line waits
  f.entered[0]!.voice.appendCommentary('Putting you through.', { allowInterruptions: false })
  listening(call.session)
  await sleep(200)
  expect(prompted).not.toHaveBeenCalled()
  await call.shutdown()
})

test('a line GPT Live cannot be given is logged, and the caller is heard again', async () => {
  const f = await fixture({ playoutTimeoutMs: 1_000 })
  const call = await f.call()
  call.live.appendCommentary = () => {
    throw new Error('Session closed')
  }
  const voice = f.entered[0]!.voice
  voice.appendCommentary('Putting you through.', { allowInterruptions: false })
  await voice.untilQuiet()
  expect(call.live.input).toEqual(['mute', 'unmute'])
  expect(f.logError).toHaveBeenCalledWith(
    { callId: f.entered[0]!.callId, errorName: 'Error' },
    'Live line_failed',
  )
  await call.shutdown()
})

test('untilQuiet resolves at once when no uninterrupted line is waiting', async () => {
  const f = await fixture()
  const call = await f.call()
  f.entered[0]!.voice.appendCommentary('How can I help?')
  await f.entered[0]!.voice.untilQuiet()
  await call.shutdown()
})

test('untilQuiet resolves at the playout bound when GPT Live never says the line', async () => {
  const f = await fixture({ playoutTimeoutMs: 100 })
  const call = await f.call()
  const voice = f.entered[0]!.voice
  voice.appendCommentary('Putting you through.', { allowInterruptions: false })
  const givenAt = Date.now()
  await voice.untilQuiet()
  expect(Date.now() - givenAt).toBeGreaterThanOrEqual(90)
  expect(call.live.input).toEqual(['mute', 'unmute'])
  await call.shutdown()
})

test('gives the line at the bound when GPT Live stays busy, and logs it', async () => {
  const f = await fixture({ playoutTimeoutMs: 60 })
  const call = await f.call()
  speaking(call.session)
  f.entered[0]!.voice.appendCommentary('Explain the time limit.', { allowInterruptions: false })
  await vi.waitFor(() => expect(given(call.live, 'Explain the time limit.')).toHaveLength(1))
  expect(f.logError).toHaveBeenCalledWith(
    { callId: f.entered[0]!.callId },
    'Live line_given_while_busy',
  )
  await call.shutdown()
})

test('uninterrupted lines are given one at a time, each after the one before is said', async () => {
  const f = await fixture({ playoutTimeoutMs: 1_000 })
  const call = await f.call()
  call.live.speak(call.session) // the greeting
  const voice = f.entered[0]!.voice
  voice.appendCommentary('Explain the time limit.', { allowInterruptions: false })
  voice.appendCommentary('Say goodbye.', { allowInterruptions: false })
  expect(call.live.input).toEqual(['mute'])
  await vi.waitFor(() => expect(given(call.live, 'Explain the time limit.')).toHaveLength(1))
  await sleep(50)
  expect(given(call.live, 'Say goodbye.')).toEqual([])
  call.live.speak(call.session)
  await vi.waitFor(() => expect(given(call.live, 'Say goodbye.')).toHaveLength(1))
  await sleep(50)
  expect(call.live.input).toEqual(['mute'])
  call.live.speak(call.session)
  await vi.waitFor(() => expect(call.live.input).toEqual(['mute', 'unmute']))
  await call.shutdown()
})

test('end lets an uninterrupted goodbye be said before closing the call', async () => {
  const f = await fixture({ playoutTimeoutMs: 1_000 })
  const call = await f.call()
  call.live.speak(call.session) // the greeting
  const voice = f.entered[0]!.voice
  voice.appendCommentary('Say goodbye.', { allowInterruptions: false })
  voice.end()
  await vi.waitFor(() => expect(given(call.live, 'Say goodbye.')).toHaveLength(1))
  await sleep(50)
  expect(f.deleteRoom).not.toHaveBeenCalled()
  call.live.speak(call.session)
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  expect(f.logError).not.toHaveBeenCalledWith(expect.anything(), 'Live line_unconfirmed')
})

test('end closes at the playout bound when GPT Live never says the line, and logs it', async () => {
  const f = await fixture({ playoutTimeoutMs: 100 })
  await f.call()
  const voice = f.entered[0]!.voice
  voice.appendCommentary('Say goodbye.', { allowInterruptions: false })
  const endedAt = Date.now()
  voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  expect(Date.now() - endedAt).toBeGreaterThanOrEqual(90)
  expect(f.logError).toHaveBeenCalledWith({ callId: f.entered[0]!.callId }, 'Live line_unconfirmed')
})

test('a caller who hangs up before the goodbye is said ends the call without waiting for it', async () => {
  const f = await fixture({ playoutTimeoutMs: 5_000 })
  const call = await f.call()
  const voice = f.entered[0]!.voice
  speaking(call.session) // GPT Live is still talking, so the goodbye waits
  voice.appendCommentary('Say goodbye.', { allowInterruptions: false })
  voice.end()
  const hungUpAt = Date.now()
  call.session.emit('close', { reason: 'participant_disconnected' })
  await vi.waitFor(() => expect(f.exited).toHaveBeenCalledTimes(1), { timeout: 1_000 })
  expect(Date.now() - hungUpAt).toBeLessThan(1_000)
})

test('an error ends the call without waiting for an uninterrupted line', async () => {
  const f = await fixture({ playoutTimeoutMs: 1_000 })
  const call = await f.call()
  f.entered[0]!.voice.appendCommentary('Say goodbye.', { allowInterruptions: false })
  call.session.emit('close', { reason: 'error', error: new Error('Transport failed') })
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
})

test('an ordinary line is given at once and leaves the caller heard', async () => {
  const f = await fixture()
  const call = await f.call()
  speaking(call.session)
  f.entered[0]!.voice.appendCommentary('How can I help?')
  expect(given(call.live, 'How can I help?')).toHaveLength(1)
  await sleep(50)
  expect(call.live.input).toEqual([])
  await call.shutdown()
})

test('counts caller speech turns', async () => {
  const f = await fixture()
  const call = await f.call()
  const talk = () => {
    call.session.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
    call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
  }
  talk()
  talk()
  expect(f.entered[0]!.voice.turnCount).toBe(2)
  await call.shutdown()
})

async function endReason(f: Awaited<ReturnType<typeof fixture>>) {
  const saved = await f.app.sessions.get(f.entered[0]!.callId)
  return saved!.events.find(
    (event) => event.type === 'annotation' && event.label === 'live-call-ended',
  )
}

test('asks on each silence, keeps the count through caller speech it does not answer, and ends when no hook keeps the call', async () => {
  const counts: number[] = []
  const f = await fixture({
    timeouts: { inactivity: 40 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return ctx.inactivityCount < 3 ? false : undefined
      },
    },
  })
  const call = await f.call()
  await vi.waitFor(() => expect(counts).toEqual([0, 1]), { interval: 5 })
  call.session.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
  call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  expect(counts).toEqual([0, 1, 2, 3])
  expect(await endReason(f)).toMatchObject({ data: { reason: 'inactivity' } })
  expect(f.exited).toHaveBeenCalledTimes(1)
})

test('runs the backend on caller speech GPT Live neither delegated nor answered, in place of a silence prompt', async () => {
  const counts: number[] = []
  const f = await fixture({
    timeouts: { inactivity: 40 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return false
      },
    },
  })
  const call = await f.call()
  call.live.fragment('user', 'No, that is everything', 'input-missed')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  expect(f.started).toEqual(['first'])
  expect(f.logError).toHaveBeenCalledWith(expect.anything(), 'Live caller speech not delegated')
  expect(f.result.mock.calls[0]![0].delegation.startedBy).toBe('handler')
  // Its line answers no delegation of GPT Live's, so it carries no delegation ID.
  await vi.waitFor(() =>
    expect(call.live.sent.at(-1)).toMatchObject({ kind: 'commentary', text: 'first' }),
  )
  expect(call.live.sent.at(-1)?.delegationId).toBeUndefined()
  // The same speech is not run on again, and that timeout was not a silence.
  await vi.waitFor(() => expect(counts).toEqual([0]), { interval: 5 })
  expect(f.started).toEqual(['first'])
  await call.shutdown()
})

test('prompts a silence after caller speech GPT Live answered itself', async () => {
  const counts: number[] = []
  const f = await fixture({
    timeouts: { inactivity: 40 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return false
      },
    },
  })
  const call = await f.call()
  call.live.fragment('user', 'Hello?', 'input-answered')
  call.live.fragment('assistant', 'Yes, I am here.', 'output-answered')
  await vi.waitFor(() => expect(counts).toEqual([0]), { interval: 5 })
  expect(f.started).toEqual([])
  await call.shutdown()
})

test('resets the silence count when the agent replies to the caller', async () => {
  const counts: number[] = []
  const f = await fixture({
    timeouts: { inactivity: 40 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return false
      },
    },
  })
  const call = await f.call()
  await vi.waitFor(() => expect(counts).toEqual([0, 1]), { interval: 5 })
  // The second silence prompt, then the caller speaks and the agent replies.
  call.session.emit('speech_created', {})
  call.session.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
  call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
  call.session.emit('speech_created', {})
  await vi.waitFor(() => expect(counts).toEqual([0, 1, 0]))
  await call.shutdown()
})

test('skips a silence hook when the caller spoke while it waited to run, and still counts that silence', async () => {
  const enterGate = gate()
  const counts: number[] = []
  const f = await fixture({
    enterGate,
    timeouts: { inactivity: 100 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return false
      },
    },
  })
  const pending = f.call()
  await vi.waitFor(() => expect(f.entered).toHaveLength(1), { interval: 5 })
  await new Promise((resolve) => setTimeout(resolve, 150))
  f.sessions[0]!.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
  enterGate.release()
  const call = await pending
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(counts).toEqual([])
  call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
  await vi.waitFor(() => expect(counts).toEqual([1]), { interval: 5 })
  await call.shutdown()
})

test('resets the count when the agent answers a caller whose speech skipped a silence hook', async () => {
  const enterGate = gate()
  const counts: number[] = []
  const f = await fixture({
    enterGate,
    timeouts: { inactivity: 100 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return false
      },
    },
  })
  const pending = f.call()
  await vi.waitFor(() => expect(f.entered).toHaveLength(1), { interval: 5 })
  await new Promise((resolve) => setTimeout(resolve, 150))
  f.sessions[0]!.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
  enterGate.release()
  const call = await pending
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The skipped hook made no prompt, so this reply answers the caller.
  call.session.emit('speech_created', {})
  call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
  await vi.waitFor(() => expect(counts).toEqual([0]), { interval: 5 })
  await call.shutdown()
})

test('does not count silence while the agent speaks or backend work runs', async () => {
  const work = gate()
  const counts: number[] = []
  const f = await fixture({
    gates: { first: work },
    timeouts: { inactivity: 80 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return false
      },
    },
  })
  const call = await f.call()
  call.live.dispatch('slow', 'Question')
  await vi.waitFor(() => expect(f.started).toEqual(['first']))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(counts).toEqual([])
  call.session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
  work.release()
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(counts).toEqual([])
  call.session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
  await vi.waitFor(() => expect(counts).toEqual([0]))
  await call.shutdown()
})

test('lets a muted expiry notice be said before ending the call', async () => {
  const f = await fixture({
    speakingAgent: true,
    playoutTimeoutMs: 1_000,
    timeouts: { expiry: 60 },
    lifecycle: {
      onExpiry(ctx) {
        ctx.voice.appendCommentary('Explain the time limit.', { allowInterruptions: false })
      },
    },
  })
  const call = await f.call()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  expect(call.live.sent.at(-1)).toEqual({ kind: 'commentary', text: 'Explain the time limit.' })
  expect(call.live.input).toEqual(['mute', 'unmute'])
  expect(await endReason(f)).toMatchObject({ data: { reason: 'expiry' } })
})

test('an expiry hook returning false keeps the call', async () => {
  const expired = vi.fn<() => boolean>(() => false)
  const f = await fixture({ timeouts: { expiry: 30 }, lifecycle: { onExpiry: expired } })
  const call = await f.call()
  await vi.waitFor(() => expect(expired).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(f.deleteRoom).not.toHaveBeenCalled()
  expect(expired).toHaveBeenCalledTimes(1)
  await call.shutdown()
})

test('ends the call at expiry when no hook handles it', async () => {
  const f = await fixture({ timeouts: { expiry: 30 } })
  await f.call()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  expect(await endReason(f)).toMatchObject({ data: { reason: 'expiry' } })
})

test('ends and cleans up a detached onEnter failure without waiting for another delegation', async () => {
  const f = await fixture({ failEnter: true, detachedEnter: true })
  const call = await f.call()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  await call.shutdown()
  expect(f.entryErrors).toHaveLength(1)
  expect(call.session.closed).toBe(true)
  expect(f.exited).toHaveBeenCalledTimes(1)
  expect(f.started).toEqual([])
})

test('shutdown during frontend rendering prevents the voice session from starting', async () => {
  const renderGate = gate()
  const f = await fixture({ renderGate })
  const pending = f.call()
  await vi.waitFor(() => expect(f.renderStarted).toHaveBeenCalledTimes(1))
  await f.shutdowns[0]!()
  renderGate.release()
  await pending
  expect(f.startCalls).not.toHaveBeenCalled()
  expect(f.sessions[0]!.closed).toBe(true)
  expect(f.deleteRoom).not.toHaveBeenCalled()
})

test('end requested inside an active tool drains its state and skips queued delegations', async () => {
  const first = gate()
  const f = await fixture({ gates: { first }, toolState: true, endInsideTool: true })
  const call = await f.call()
  call.live.dispatch('ending-id', 'Finish this call')
  await vi.waitFor(() => expect(f.started).toEqual(['first']))
  call.live.dispatch('queued-id', 'Queued follow-up')
  first.release()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  await call.shutdown()
  expect(f.finished).toEqual(['first'])
  expect(f.started).toEqual(['first'])
  expect(f.signals.get('first')!.aborted).toBe(true)
  expect((await f.app.sessions.get(f.entered[0]!.session.id))!.state.answer).toBe('tool-first')
  expect(f.exited.mock.calls[0]![0].state.answer).toBe('tool-first')
  expect(f.exited).toHaveBeenCalledTimes(1)
  expect(f.deleteRoom).toHaveBeenCalledTimes(1)
  expect(f.result).not.toHaveBeenCalled()
  expect(call.session.closed).toBe(true)
})

test('terminal transport failure ends the room and records its reason', async () => {
  const f = await fixture()
  const call = await f.call()
  call.session.emit('close', { reason: 'error', error: new Error('Transport failed') })
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  await call.shutdown()
  const saved = await f.app.sessions.get(f.entered[0]!.callId)
  expect(saved!.events).toContainEqual(
    expect.objectContaining({
      type: 'annotation',
      label: 'live-call-ended',
      data: { reason: 'error' },
    }),
  )
  expect(f.exited).toHaveBeenCalledTimes(1)
})

test('ends the call within the backend timeout when a tool ignores cancellation', async () => {
  const stuck = gate()
  const f = await fixture({ gates: { first: stuck }, backendTimeoutMs: 50 })
  const call = await f.call()
  call.live.dispatch('stuck-id', 'Question')
  await vi.waitFor(() => expect(f.started).toEqual(['first']))
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  expect(f.signals.get('first')!.aborted).toBe(true)
  expect(call.session.closed).toBe(true)
  expect(f.exited).toHaveBeenCalledTimes(1)
  const ended = await f.app.sessions.get(f.entered[0]!.callId)
  expect(ended!.events).toContainEqual(
    expect.objectContaining({
      type: 'annotation',
      label: 'live-call-ended',
      data: { reason: 'agent-ended', backendSettled: false },
    }),
  )

  stuck.release()
  await vi.waitFor(() => expect(f.finished).toEqual(['first']))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const saved = await f.app.sessions.get(f.entered[0]!.callId)
  expect(saved!.events.map((event) => event.id)).toEqual(ended!.events.map((event) => event.id))
  const backendRecords = await Promise.all(
    (await f.store.list('live-test')).map((row) => f.store.load('live-test', row.id)),
  )
  expect(
    backendRecords.some((row) => row!.events.some((event) => event.type === 'tool_result')),
  ).toBe(true)
  expect(f.error).not.toHaveBeenCalled()
})

test('keeps speech after the last delegation in the transcript session, not the call ledger', async () => {
  const f = await fixture()
  const call = await f.call()
  call.live.dispatch('first-id', 'Question')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  call.live.fragment('assistant', 'Goodbye', 'final-goodbye', 5000, 5600)
  await call.shutdown()
  const callId = f.entered[0]!.callId
  const transcript = await sessionService(f.store).getSession('adk-gpt-live-transcript', callId)
  expect(transcript!.events).toContainEqual(
    expect.objectContaining({
      data: {
        observation: expect.objectContaining({
          payload: expect.objectContaining({
            event: expect.objectContaining({ delta: 'Goodbye' }),
          }),
        }),
      },
    }),
  )
  const saved = await f.app.sessions.get(callId)
  expect(
    saved!.events.filter((event) => event.type === 'user' || event.type === 'assistant'),
  ).toEqual([])
})

test('rejects an entry context that is not a LiveKit job before opening a call', async () => {
  const f = await fixture()
  await expect(f.handler.entry({ room: { name: 'room' } })).rejects.toThrow(
    'Live voice entry requires a LiveKit job context',
  )
  expect(f.sessions).toEqual([])
  expect(await f.store.list('live-test')).toEqual([])
})

test('close waits up to the backend timeout for work being recorded and finalizes the ledger with it', async () => {
  const hold = gate()
  const f = await fixture({ backendTimeoutMs: 400 })
  const call = await f.call()
  const callId = f.entered[0]!.callId
  const load = f.app.sessions.get.bind(f.app.sessions)
  let transferring = false
  vi.spyOn(f.app.sessions, 'get').mockImplementation(async (id) => {
    if (id === callId && !transferring) {
      transferring = true
      await hold.promise
    }
    return load(id)
  })
  call.live.dispatch('transfer-id', 'Question')
  await vi.waitFor(() => expect(transferring).toBe(true))
  f.entered[0]!.voice.end()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(f.deleteRoom).not.toHaveBeenCalled()
  hold.release()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  const saved = await load(callId)
  const marks = saved!.events.flatMap((event) =>
    event.type === 'annotation' ? [{ label: event.label, data: event.data }] : [],
  )
  expect(marks.map((mark) => mark.label)).toEqual(['live-backend-work', 'live-call-ended'])
  expect(marks.at(-1)!.data).toEqual({ reason: 'agent-ended' })
  expect(f.error).not.toHaveBeenCalled()
  expect(f.exited).toHaveBeenCalledTimes(1)
})

test('a stalled backend transfer cannot hold call termination past the backend timeout', async () => {
  const stalled = gate()
  const f = await fixture({ backendTimeoutMs: 50 })
  const call = await f.call()
  const callId = f.entered[0]!.callId
  const load = f.app.sessions.get.bind(f.app.sessions)
  let transferring = false
  vi.spyOn(f.app.sessions, 'get').mockImplementation(async (id) => {
    if (id === callId && !transferring) {
      transferring = true
      await stalled.promise
    }
    return load(id)
  })
  call.live.dispatch('stalled-id', 'Question')
  await vi.waitFor(() => expect(transferring).toBe(true))
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  expect(call.session.closed).toBe(true)
  expect(f.exited).toHaveBeenCalledTimes(1)
  const saved = await load(callId)
  expect(saved!.events).toContainEqual(
    expect.objectContaining({
      label: 'live-call-ended',
      data: { reason: 'agent-ended', backendSettled: false },
    }),
  )
  expect(f.error).not.toHaveBeenCalled()
})

test('a backend transfer released after the backend timeout does not write the finalized call', async () => {
  const stalled = gate()
  const f = await fixture({ backendTimeoutMs: 50, toolState: true })
  const call = await f.call()
  const callId = f.entered[0]!.callId
  const load = f.app.sessions.get.bind(f.app.sessions)
  let transferring = false
  vi.spyOn(f.app.sessions, 'get').mockImplementation(async (id) => {
    if (id === callId && !transferring) {
      transferring = true
      await stalled.promise
    }
    return load(id)
  })
  call.live.dispatch('stalled-id', 'Question')
  await vi.waitFor(() => expect(transferring).toBe(true))
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  const finalized = await load(callId)
  expect(finalized!.events.at(-1)).toMatchObject({ type: 'annotation', label: 'live-call-ended' })
  expect(finalized!.state.answer).toBe('')
  stalled.release()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const latest = await load(callId)
  expect({ events: latest!.events, state: latest!.state }).toEqual({
    events: finalized!.events,
    state: finalized!.state,
  })
  expect(f.error).not.toHaveBeenCalled()
})

test('a result hook that resumes while close records the call does not reach the ledger', async () => {
  const stuck = gate()
  const f = await fixture({ resultGate: stuck, backendTimeoutMs: 50 })
  const call = await f.call()
  const callId = f.entered[0]!.callId
  const close = call.session.close.bind(call.session)
  call.session.close = async () => {
    stuck.release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await close()
  }
  call.live.dispatch('first-id', 'Question')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  const saved = await f.app.sessions.get(callId)
  expect(saved!.state.answer).toBe('')
  expect(f.exited.mock.calls[0]![0].state.answer).toBe('')
  expect(saved!.events.filter(isBackendWork)).toHaveLength(1)
  expect(saved!.events.at(-1)).toMatchObject({ type: 'annotation', label: 'live-call-ended' })
})

test('an expiry hook that resumes while close records the call does not reach the ledger', async () => {
  const stuck = gate()
  const f = await fixture({
    backendTimeoutMs: 50,
    timeouts: { expiry: 20 },
    lifecycle: {
      async onExpiry(ctx) {
        await stuck.promise
        ctx.state.answer = 'late'
      },
    },
  })
  const call = await f.call()
  const callId = f.entered[0]!.callId
  const close = call.session.close.bind(call.session)
  call.session.close = async () => {
    stuck.release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await close()
  }
  await new Promise((resolve) => setTimeout(resolve, 40))
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const saved = await f.app.sessions.get(callId)
  expect(saved!.state.answer).toBe('')
  expect(saved!.events.at(-1)).toMatchObject({ type: 'annotation', label: 'live-call-ended' })
})

test('close still records the end and runs onExit when it cannot reload the call session', async () => {
  const stuck = gate()
  const f = await fixture({ resultGate: stuck, backendTimeoutMs: 50 })
  const call = await f.call()
  const callId = f.entered[0]!.callId
  call.live.dispatch('first-id', 'Question')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  const load = f.app.sessions.get.bind(f.app.sessions)
  const read = vi.spyOn(f.app.sessions, 'get').mockRejectedValue(new Error('store unavailable'))
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  expect(read).toHaveBeenCalledWith(callId)
  expect(f.exited).toHaveBeenCalledTimes(1)
  read.mockRestore()
  const saved = await load(callId)
  expect(saved!.events.at(-1)).toMatchObject({
    type: 'annotation',
    label: 'live-call-ended',
    data: { reason: 'agent-ended', backendSettled: false },
  })
  stuck.release()
})

/**
 * Commits a competing write to the call just before close commits its records: before each first
 * attempt, or before every attempt including the retry.
 */
function raceCloseCommits(
  f: Awaited<ReturnType<typeof fixture>>,
  callId: string,
  attempts: 'first' | 'every',
  answer?: string,
) {
  const commit = f.app.sessions.commit.bind(f.app.sessions)
  const load = f.app.sessions.get.bind(f.app.sessions)
  let raced = 0
  vi.spyOn(f.app.sessions, 'commit').mockImplementation(async (session, expectedVersion) => {
    const closing = session.events.some(
      (event) => event.type === 'annotation' && event.label === 'live-call-ended',
    )
    if (
      session.id === callId &&
      closing &&
      (attempts === 'every' || expectedVersion === undefined)
    ) {
      raced++
      const other = (await load(callId))!
      await sessionService(f.store).appendEvent(other, {
        id: `late-write-${raced}`,
        type: 'annotation',
        kind: 'mark',
        label: 'late-write',
        createdAt: Date.now(),
        invocationId: '',
        agentName: 'backend',
      })
      if (answer !== undefined) other.state.update({ answer: `${answer}-${raced}` })
      expect((await commit(other)).ok).toBe(true)
    }
    return commit(session, expectedVersion)
  })
}

test('close commits its end mark and onExit state again after a write lands during close', async () => {
  const f = await fixture()
  f.exited.mockImplementation((ctx) => ctx.state.update({ answer: 'exit' }))
  await f.call()
  const callId = f.entered[0]!.callId
  raceCloseCommits(f, callId, 'first', 'backend')
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  const saved = await f.app.sessions.get(callId)
  const labels = saved!.events.flatMap((event) =>
    event.type === 'annotation' ? [event.label] : [],
  )
  expect(labels.filter((label) => label === 'late-write' || label === 'live-call-ended')).toEqual([
    'late-write',
    'live-call-ended',
    'late-write',
  ])
  expect(saved!.state.answer).toBe('exit')
  expect(f.exited).toHaveBeenCalledTimes(1)
  const logged = f.logError.mock.calls.map(([, message]) => message)
  expect(logged).not.toContain('Live call close records conflicted twice')
  expect(logged).not.toContain('Live call cleanup failed')
})

test('a close retry keeps a late write to state that close did not change', async () => {
  const f = await fixture()
  await f.call()
  const callId = f.entered[0]!.callId
  const created = await f.app.sessions.get(callId)
  raceCloseCommits(f, callId, 'first', 'backend')
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  const saved = await f.app.sessions.get(callId)
  expect(saved!.state.answer).toBe('backend-2')
  expect(saved!.scopes).toEqual(created!.scopes)
  expect(saved!.events).toContainEqual(
    expect.objectContaining({ type: 'annotation', label: 'live-call-ended' }),
  )
})

test('close logs a second conflict and still ends the call', async () => {
  const f = await fixture()
  await f.call()
  const callId = f.entered[0]!.callId
  raceCloseCommits(f, callId, 'every')
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  expect(f.exited).toHaveBeenCalledTimes(1)
  expect(f.logError).toHaveBeenCalledWith({ callId }, 'Live call close records conflicted twice')
})

test('a result hook that resumes after close does not write the finalized call', async () => {
  const stuck = gate()
  const f = await fixture({ resultGate: stuck, backendTimeoutMs: 50 })
  const call = await f.call()
  const callId = f.entered[0]!.callId
  call.live.dispatch('first-id', 'Question')
  await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
  f.entered[0]!.voice.end()
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1), { timeout: 500 })
  const finalized = await f.app.sessions.get(callId)
  expect(finalized!.events.at(-1)).toMatchObject({ type: 'annotation', label: 'live-call-ended' })
  // The hook's uncommitted change belongs to work that close() stopped waiting for.
  expect(finalized!.state.answer).toBe('')
  stuck.release()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const latest = await f.app.sessions.get(callId)
  expect({ events: latest!.events, state: latest!.state }).toEqual({
    events: finalized!.events,
    state: finalized!.state,
  })
})

/** The `activity` field of each logged `onVoiceActivity` hook failure. */
function activityHookFailures(logError: { mock: { calls: Array<[unknown, string]> } }): unknown[] {
  return logError.mock.calls.flatMap(([fields, message]) =>
    message === 'Live onVoiceActivity hook failed' &&
    typeof fields === 'object' &&
    fields !== null &&
    'activity' in fields
      ? [fields.activity]
      : [],
  )
}

describe('voice activity hooks', () => {
  /** A fixture whose one `onVoiceActivity` hook records each event and keeps the latest context. */
  async function watched(options: Parameters<typeof fixture>[0] = {}) {
    const seen: Array<{ type: string; sinceRun: string[] }> = []
    let latest: LiveVoiceActivityContext | undefined
    const f = await fixture({
      ...options,
      extraHooks: [
        ...(options.extraHooks ?? []),
        {
          onVoiceActivity(ctx) {
            latest = ctx
            seen.push({ type: ctx.activity.type, sinceRun: ctx.sinceRun.map(({ type }) => type) })
          },
        },
      ],
    })
    const settled = () => vi.waitFor(() => expect(seen.at(-1)?.type).toBe('run_settled'))
    return { f, seen, settled, latest: () => latest! }
  }

  test('reports voice events in order, each with the events since the latest run', async () => {
    const { f, seen, settled } = await watched()
    const call = await f.call()
    call.session.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
    call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
    speaking(call.session)
    listening(call.session)
    call.live.dispatch('d1', 'Tuesday')
    await settled()
    // The fixture's opening transcript arrives once the call has entered.
    const types = seen.map(({ type }) => type)
    expect(types).toEqual([
      'caller_transcript',
      'agent_transcript',
      'caller_started_speaking',
      'caller_stopped_speaking',
      'agent_started_speaking',
      'agent_stopped_speaking',
      'caller_transcript',
      'run_started',
      'run_settled',
    ])
    expect(seen[6]!.sinceRun).toEqual(types.slice(0, 7))
    expect(seen[7]!.sinceRun).toEqual(['run_started'])
    expect(seen[8]!.sinceRun).toEqual(['run_started', 'run_settled'])
    await call.shutdown()
  })

  test('events since the latest run, read after later events, still end at their own event', async () => {
    const contexts: LiveVoiceActivityContext[] = []
    const { f, settled } = await watched({
      extraHooks: [{ onVoiceActivity: (ctx) => void contexts.push(ctx) }],
    })
    const call = await f.call()
    speaking(call.session)
    listening(call.session)
    call.live.dispatch('d1', 'Tuesday')
    await settled()
    expect(contexts.map((ctx) => ctx.sinceRun.map(({ type }) => type))).toEqual([
      ['caller_transcript'],
      ['caller_transcript', 'agent_transcript'],
      ['caller_transcript', 'agent_transcript', 'agent_started_speaking'],
      ['caller_transcript', 'agent_transcript', 'agent_started_speaking', 'agent_stopped_speaking'],
      [
        'caller_transcript',
        'agent_transcript',
        'agent_started_speaking',
        'agent_stopped_speaking',
        'caller_transcript',
      ],
      ['run_started'],
      ['run_started', 'run_settled'],
    ])
    await call.shutdown()
  })

  test('a trigger runs the backend on caller speech no run has had, answering no delegation', async () => {
    const { f, latest, settled } = await watched()
    const call = await f.call()
    expect(latest().runBackend()).toBe(true)
    await vi.waitFor(() => expect(given(call.live, 'first')).toHaveLength(1))
    expect(f.started).toEqual(['first'])
    expect(given(call.live, 'first')[0]!.delegationId).toBeUndefined()
    await settled()
    await call.shutdown()
  })

  test('a run says what started it, to its result hook and in its run events', async () => {
    const started: string[] = []
    const { f, latest, settled } = await watched({
      extraHooks: [
        {
          onVoiceActivity(ctx) {
            if (ctx.activity.type === 'run_started') started.push(ctx.activity.delegation.startedBy)
          },
        },
      ],
    })
    const call = await f.call()
    expect(latest().runBackend()).toBe(true)
    await settled()
    call.live.dispatch('d1', 'Tuesday')
    await settled()
    expect(started).toEqual(['app', 'voice'])
    expect(f.result.mock.calls.map(([ctx]) => ctx.delegation.startedBy)).toEqual(['app', 'voice'])
    await call.shutdown()
  })

  test('a trigger never runs speech a run has had', async () => {
    const { f, latest, settled } = await watched()
    const call = await f.call()
    expect(latest().runBackend()).toBe(true)
    await settled()
    expect(latest().runBackend()).toBe(false)
    // Nor speech GPT Live delegated.
    call.live.dispatch('d1', 'Tuesday')
    await settled()
    expect(latest().runBackend()).toBe(false)
    expect(f.started).toEqual(['first', 'second'])
    await call.shutdown()
  })

  test('a trigger while a run is in flight runs nothing; once it settles, the later speech runs', async () => {
    const work = gate()
    const { f, latest, settled } = await watched({ gates: { first: work } })
    const call = await f.call()
    call.live.dispatch('d1', 'Book it')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.live.fragment('user', ' and Friday', 'input-late')
    expect(latest().runBackend()).toBe(false)
    work.release()
    await settled()
    expect(latest().runBackend()).toBe(true)
    await vi.waitFor(() => expect(f.started).toEqual(['first', 'second']))
    await call.shutdown()
  })

  test('a trigger runs nothing once the call has stopped', async () => {
    const { f, latest } = await watched()
    const call = await f.call()
    const ctx = latest()
    await call.shutdown()
    expect(ctx.runBackend()).toBe(false)
    expect(f.started).toEqual([])
  })

  test('an event a hook causes reaches every hook after the one it was handling', async () => {
    const { f, seen } = await watched({
      extraHooks: [
        {
          onVoiceActivity(ctx) {
            if (ctx.activity.type === 'caller_transcript') ctx.runBackend()
          },
        },
      ],
    })
    const call = await f.call()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    expect(seen.slice(0, 3)).toEqual([
      { type: 'caller_transcript', sinceRun: ['caller_transcript'] },
      { type: 'run_started', sinceRun: ['run_started'] },
      { type: 'agent_transcript', sinceRun: ['run_started', 'agent_transcript'] },
    ])
    await call.shutdown()
  })

  test('a trigger at a silence timeout replaces its silence prompt and is not counted', async () => {
    let silences = 0
    const prompts: Array<{ inactivityCount: number; silences: number }> = []
    const f = await fixture({
      timeouts: { inactivity: 40 },
      lifecycle: {
        onInactivity({ inactivityCount }) {
          prompts.push({ inactivityCount, silences })
          return false
        },
      },
      extraHooks: [
        {
          onVoiceActivity(ctx) {
            if (ctx.activity.type !== 'silence_timeout') return
            silences++
            ctx.runBackend()
          },
        },
      ],
    })
    const call = await f.call()
    // GPT Live answered the opening itself, so the silence rule would prompt: the hook runs it.
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { interval: 5 })
    // The next silence has nothing new to run, so it is the first prompted, and counted, silence.
    expect(prompts).toEqual([{ inactivityCount: 0, silences: 2 }])
    expect(f.started).toEqual(['first'])
    await call.shutdown()
  })

  test('a silence waits for an async activity hook, so its later trigger still runs the backend', async () => {
    let triggered = false
    const runsAtPrompts: number[] = []
    const f = await fixture({
      timeouts: { inactivity: 40 },
      lifecycle: {
        onInactivity() {
          runsAtPrompts.push(f.started.length)
          return false
        },
      },
      extraHooks: [
        {
          async onVoiceActivity(ctx) {
            if (ctx.activity.type !== 'silence_timeout' || triggered) return
            triggered = true
            await new Promise((resolve) => setTimeout(resolve, 20))
            ctx.runBackend()
          },
        },
      ],
    })
    const call = await f.call()
    // GPT Live answered the opening itself, so the silence rule alone would prompt without a run.
    await vi.waitFor(() => expect(runsAtPrompts).toHaveLength(1), { interval: 5 })
    expect(f.started).toEqual(['first'])
    expect(runsAtPrompts).toEqual([1])
    await call.shutdown()
  })

  test('a GPT Live delegation while silence hooks wait answers that silence', async () => {
    const hookWait = gate()
    const work = gate()
    let silences = 0
    const prompts: number[] = []
    const f = await fixture({
      gates: { first: work },
      timeouts: { inactivity: 40 },
      lifecycle: {
        onInactivity() {
          prompts.push(silences)
          return false
        },
      },
      extraHooks: [
        {
          async onVoiceActivity(ctx) {
            if (ctx.activity.type !== 'silence_timeout') return
            silences++
            if (silences === 1) await hookWait.promise
          },
        },
      ],
    })
    const call = await f.call()
    await vi.waitFor(() => expect(silences).toBe(1), { interval: 5 })
    call.live.dispatch('d1', 'Tuesday')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    // The silence is decided while the delegation's run is in flight.
    hookWait.release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    work.release()
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { interval: 5 })
    // The silence the delegation answered is not prompted; the next one is.
    expect(prompts).toEqual([2])
    await call.shutdown()
  })

  test('no silence fires while an earlier one waits for its hooks', async () => {
    let silences = 0
    const prompts: Array<{ inactivityCount: number; runs: number }> = []
    const f = await fixture({
      timeouts: { inactivity: 40 },
      lifecycle: {
        onInactivity({ inactivityCount }) {
          prompts.push({ inactivityCount, runs: f.started.length })
          return false
        },
      },
      extraHooks: [
        {
          async onVoiceActivity(ctx) {
            if (ctx.activity.type !== 'silence_timeout' || ++silences > 1) return
            // Longer than a silence, then run the backend.
            await new Promise((resolve) => setTimeout(resolve, 120))
            ctx.runBackend()
          },
        },
      ],
    })
    const call = await f.call()
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { interval: 5 })
    // The first silence was answered by the run and not counted.
    expect(prompts).toEqual([{ inactivityCount: 0, runs: 1 }])
    await call.shutdown()
  })

  test('a failing activity hook is logged without its message and changes nothing', async () => {
    const { f, seen, settled } = await watched({
      extraHooks: [
        {
          onVoiceActivity() {
            throw new Error('Synthetic caller words')
          },
        },
        {
          async onVoiceActivity() {
            throw new Error('Synthetic caller words')
          },
        },
      ],
    })
    const call = await f.call()
    call.live.dispatch('d1', 'Tuesday')
    await settled()
    expect(f.result).toHaveBeenCalledTimes(1)
    // Each event's throw and rejection are both logged, with the event.
    await vi.waitFor(() => expect(activityHookFailures(f.logError)).toHaveLength(seen.length * 2))
    expect(activityHookFailures(f.logError).sort()).toEqual(
      seen.flatMap(({ type }) => [type, type]).sort(),
    )
    expect(JSON.stringify(f.logError.mock.calls)).not.toContain('Synthetic caller words')
    await call.shutdown()
  })
})

describe('Live call usage', () => {
  beforeEach(useTestPricing)
  afterEach(() => configurePricing(false))

  function usageMetric(connection: string, seconds: number) {
    return {
      metrics: {
        type: 'realtime_model_metrics',
        requestId: connection,
        sessionDurationMs: seconds * 1000,
        inputTokens: 0,
        outputTokens: 0,
      },
    }
  }

  test('onExit reports provider voice seconds and backend cost separately', async () => {
    const f = await fixture({ backendUsage: true })
    const call = await f.call()
    call.live.dispatch('first-id', 'Opening hours?')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    // The plugin reports each cumulative usage.seconds update as a delta: 12 s, then 15 s.
    call.session.emit('metrics_collected', usageMetric('connection-one', 12))
    call.session.emit('metrics_collected', usageMetric('connection-one', 3))
    call.live.emit('openai_server_event_received', { type: 'session.closed' })
    await call.shutdown()
    const usage = f.exited.mock.calls[0]![0].usage
    expect(usage.voice).toEqual({
      modelName: 'gpt-live-1',
      seconds: 15,
      cost: { basis: 'reported', totalCost: 0.0125, currency: 'USD' },
    })
    // One backend model call at 1M gpt-4o-mini input tokens.
    expect(usage.backend.usage?.modelCalls).toBe(1)
    expect(usage.backend.cost).toEqual({ basis: 'reported', totalCost: 0.15, currency: 'USD' })
    expect(usage.total).toEqual({ basis: 'reported', totalCost: 0.1625, currency: 'USD' })
  })

  test.each([
    ['both connections closed', true, { basis: 'reported', totalCost: 0.025, currency: 'USD' }],
    [
      'the first connection dropped',
      false,
      { basis: 'estimated', totalCost: 0.025, currency: 'USD' },
    ],
  ] as const)('sums usage across a reconnect when %s', async (_, firstClosed, cost) => {
    const f = await fixture({ clock: () => 0 })
    const call = await f.call()
    call.session.emit('metrics_collected', usageMetric('connection-one', 20))
    if (firstClosed) call.live.emit('openai_server_event_received', { type: 'session.closed' })
    call.live.emit('openai_server_event_received', {
      type: 'session.started',
      session: { id: 'connection-two' },
    })
    call.live.sessionId = 'connection-two'
    call.session.emit('metrics_collected', usageMetric('connection-two', 10))
    call.live.emit('openai_server_event_received', { type: 'session.closed' })
    await call.shutdown()
    expect(f.exited.mock.calls[0]![0].usage.voice).toEqual({
      modelName: 'gpt-live-1',
      seconds: 30,
      cost,
    })
  })

  test('falls back to connection time when the provider reports no usage', async () => {
    let clock = 1_000
    const f = await fixture({ clock: () => clock })
    const call = await f.call()
    clock += 90_000
    const close = call.session.close.bind(call.session)
    call.session.close = async () => {
      clock += 30_000
      await close()
    }
    await call.shutdown()
    const usage = f.exited.mock.calls[0]![0].usage
    expect(usage.voice).toEqual({
      modelName: 'gpt-live-1',
      seconds: 120,
      cost: { basis: 'estimated', totalCost: 0.1, currency: 'USD' },
    })
    expect(usage.backend).toEqual({ cost: { basis: 'reported', totalCost: 0, currency: 'USD' } })
    expect(usage.total).toEqual({ basis: 'estimated', totalCost: 0.1, currency: 'USD' })
  })

  test('backend work abandoned at close makes backend cost unavailable, not complete', async () => {
    const stuck = gate()
    const f = await fixture({ gates: { second: stuck }, backendTimeoutMs: 50, backendUsage: true })
    const call = await f.call()
    call.live.dispatch('first-id', 'Question')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    call.live.dispatch('second-id', 'Follow-up')
    await vi.waitFor(() => expect(f.started).toEqual(['first', 'second']))
    f.entered[0]!.voice.end()
    await vi.waitFor(() => expect(f.exited).toHaveBeenCalledTimes(1), { timeout: 500 })
    const usage = f.exited.mock.calls[0]![0].usage
    expect(usage.backend.cost).toEqual({ basis: 'unavailable' })
    expect(usage.total).toEqual({ basis: 'unavailable' })
    stuck.release()
    await vi.waitFor(() => expect(f.finished).toEqual(['first', 'second']))
  })

  test('a result hook still running at close keeps the settled backend cost', async () => {
    const stuck = gate()
    const f = await fixture({ resultGate: stuck, backendTimeoutMs: 50, backendUsage: true })
    const call = await f.call()
    call.live.dispatch('first-id', 'Question')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    f.entered[0]!.voice.end()
    await vi.waitFor(() => expect(f.exited).toHaveBeenCalledTimes(1), { timeout: 500 })
    const usage = f.exited.mock.calls[0]![0].usage
    expect(usage.backend.usage?.modelCalls).toBe(1)
    expect(usage.backend.cost).toEqual({ basis: 'reported', totalCost: 0.15, currency: 'USD' })
    stuck.release()
  })

  test('backend calls without reported token usage make backend and total cost unavailable', async () => {
    const f = await fixture()
    const call = await f.call()
    call.live.dispatch('first-id', 'Opening hours?')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await call.shutdown()
    const usage = f.exited.mock.calls[0]![0].usage
    expect(usage.backend.cost).toEqual({ basis: 'unavailable' })
    expect(usage.total).toEqual({ basis: 'unavailable' })
  })
})

describe('call recording and noise cancellation', () => {
  const egress = {
    bucket: 'synthetic-calls',
    prefix: 'recordings/',
    region: 'eu-west-2',
    accessKeyId: 'synthetic',
    secretAccessKey: 'synthetic',
    livekitUrl: 'ws://synthetic.invalid',
    apiKey: 'synthetic',
    apiSecret: 'synthetic',
  }

  test('starts egress at the setup key before the voice session, and stops it at close', async () => {
    const f = await fixture({
      recording: { egress },
      callSetup: { recordingKey: 'org-1/call-1.ogg' },
    })
    const call = await f.call()
    expect(f.egressStarts).toEqual([
      {
        room: 'room-1',
        filepath: 'org-1/call-1.ogg',
        bucket: 'synthetic-calls',
        region: 'eu-west-2',
        audioOnly: true,
      },
    ])
    expect(f.egressStops).toEqual([])
    await call.shutdown()
    expect(f.egressStops).toEqual(['egress-1'])
    expect(f.order).toEqual(['egress-start', 'voice-start', 'egress-stop'])
  })

  test('names the recording after the call session without a setup key', async () => {
    const f = await fixture({ recording: { egress }, setupId: 'call-7' })
    const call = await f.call()
    expect(f.egressStarts.map(({ filepath }) => filepath)).toEqual([
      'recordings/session_call-7.ogg',
    ])
    await call.shutdown()
    expect(f.egressStops).toEqual(['egress-1'])
  })

  test('stops egress once when the call ends itself', async () => {
    const f = await fixture({ recording: { egress } })
    const call = await f.call()
    call.session.emit('close', { reason: 'user-disconnected' })
    await vi.waitFor(() => expect(f.exited).toHaveBeenCalledTimes(1))
    await call.shutdown()
    expect(f.egressStops).toEqual(['egress-1'])
  })

  test('a failed egress stop still closes the call and runs onExit', async () => {
    const f = await fixture({ recording: { egress }, failEgressStop: true })
    const call = await f.call()
    await call.shutdown()
    expect(f.egressStops).toEqual(['egress-1'])
    expect(f.exited).toHaveBeenCalledTimes(1)
    expect(f.sessions[0]!.closed).toBe(true)
  })

  test('a failed egress start logs no patient data and the call goes on unrecorded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const f = await fixture({
        recording: { egress },
        callSetup: { recordingKey: 'org-1/2026-09-27_+447700900123.ogg' },
        failEgressStart: new Error('Egress refused org-1/2026-09-27_+447700900123.ogg'),
      })
      const call = await f.call()
      expect(logged.mock.calls).toEqual([
        ['[adk/voice] Failed to start egress recording:', { errorName: 'Error' }],
      ])
      expect(f.order).toEqual(['egress-start', 'voice-start'])
      await call.shutdown()
      expect(f.egressStops).toEqual([])
    } finally {
      logged.mockRestore()
    }
  })

  test('records nothing without a recording config, even with a setup key', async () => {
    const f = await fixture({ callSetup: { recordingKey: 'org-1/call-1.ogg' } })
    const call = await f.call()
    await call.shutdown()
    expect(f.egressStarts).toEqual([])
    expect(f.order).toEqual(['voice-start'])
  })

  test('filters caller audio with the handler noise cancellation profile', async () => {
    const f = await fixture({ sound: { noiseCancellation: 'telephony' } })
    const call = await f.call()
    expect(f.startOptions).toEqual([
      {
        inputOptions: {
          participantIdentity: 'synthetic-caller',
          noiseCancellation: { moduleId: 'telephony-filter', options: {} },
        },
      },
    ])
    await call.shutdown()
  })

  test('a call setup profile overrides the handler profile', async () => {
    const f = await fixture({
      sound: { noiseCancellation: 'telephony' },
      callSetup: { noiseCancellation: 'general' },
    })
    const call = await f.call()
    expect(f.startOptions[0]!.inputOptions!.noiseCancellation).toEqual({
      moduleId: 'general-filter',
      options: {},
    })
    await call.shutdown()
  })

  test('starts without a noise filter when none is configured', async () => {
    const f = await fixture()
    const call = await f.call()
    expect(f.startOptions).toEqual([{ inputOptions: { participantIdentity: 'synthetic-caller' } }])
    await call.shutdown()
  })
})

describe('thinking sound', () => {
  const sound = { backgroundAudio: { thinking: { source: 'thinking.ogg', volume: 0.4 } } }

  test('plays while a backend run is in progress and stops when it ends', async () => {
    const work = gate()
    const f = await fixture({ sound, gates: { first: work } })
    const call = await f.call()
    expect(f.soundFiles).toEqual(['thinking.ogg'])
    expect(f.backgroundAudio).toEqual(['start'])
    expect(f.playing()).toEqual([])
    call.live.dispatch('slow', 'Question')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    expect(f.playing()).toEqual([0.4])
    work.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.playing()).toEqual([]))
    expect(f.plays).toHaveLength(1)
    await call.shutdown()
    expect(f.backgroundAudio).toEqual(['start', 'close'])
  })

  test('plays on under GPT Live speech during a run, and stops when the answer starts', async () => {
    const work = gate()
    const answer = gate()
    const f = await fixture({ sound, gates: { first: work }, resultGate: answer })
    const call = await f.call()
    call.live.dispatch('slow', 'Question')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
    expect(f.playing()).toEqual([0.4])
    call.session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
    expect(f.playing()).toEqual([0.4])
    expect(f.plays).toHaveLength(1)
    work.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    expect(f.playing()).toEqual([0.4])
    call.session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
    call.session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
    expect(f.playing()).toEqual([])
    answer.release()
    await call.shutdown()
    expect(f.plays).toHaveLength(1)
  })

  test('pauses while GPT Live speaks the answer to a run that has ended, under a later run', async () => {
    const first = gate()
    const second = gate()
    const f = await fixture({ sound, gates: { first, second } })
    const call = await f.call()
    call.live.dispatch('slow', 'First question')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    call.live.dispatch('fast', 'Second question')
    first.release()
    await vi.waitFor(() => expect(f.started).toEqual(['first', 'second']))
    expect(f.result).toHaveBeenCalledTimes(1)
    expect(f.playing()).toEqual([0.4])
    call.session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
    expect(f.playing()).toEqual([])
    call.session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
    expect(f.playing()).toEqual([0.4])
    call.session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
    expect(f.playing()).toEqual([0.4])
    call.session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
    second.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(f.playing()).toEqual([]))
    await call.shutdown()
    expect(f.plays).toHaveLength(2)
  })

  test('a delegation admitted while GPT Live speaks the last answer waits for the answer to end', async () => {
    const second = gate()
    const f = await fixture({ sound, gates: { second } })
    const call = await f.call()
    call.live.dispatch('first-id', 'First question')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.playing()).toEqual([]))
    call.session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
    call.live.dispatch('second-id', 'Second question')
    await vi.waitFor(() => expect(f.started).toEqual(['first', 'second']))
    expect(f.playing()).toEqual([])
    call.session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
    expect(f.playing()).toEqual([0.4])
    second.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
    await call.shutdown()
    expect(f.plays).toHaveLength(2)
  })

  test('plays on under a filler word when GPT Live did not speak after the last run', async () => {
    const second = gate()
    const f = await fixture({ sound, gates: { second } })
    const call = await f.call()
    call.live.dispatch('first-id', 'First question')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.playing()).toEqual([]))
    call.live.dispatch('second-id', 'Second question')
    await vi.waitFor(() => expect(f.started).toEqual(['first', 'second']))
    call.session.emit('agent_state_changed', { oldState: 'listening', newState: 'speaking' })
    expect(f.playing()).toEqual([0.4])
    call.session.emit('agent_state_changed', { oldState: 'speaking', newState: 'listening' })
    second.release()
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
    await call.shutdown()
    expect(f.plays).toHaveLength(2)
  })

  test.each(['play', 'stop'] as const)(
    'a player that fails to %s mid-call is dropped, and the call goes on',
    async (soundFails) => {
      const f = await fixture({ sound, soundFails })
      const call = await f.call()
      call.live.dispatch('first-id', 'First question')
      await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
      call.live.dispatch('second-id', 'Second question')
      await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(2))
      await call.shutdown()
      expect(call.live.sent.slice(3)).toEqual([
        { kind: 'commentary', text: 'first', delegationId: 'first-id' },
        { kind: 'commentary', text: 'second', delegationId: 'second-id' },
      ])
      expect(f.error).not.toHaveBeenCalled()
      expect(f.exited).toHaveBeenCalledTimes(1)
      expect(f.logError.mock.calls).toEqual([
        [{ callId: f.entered[0]!.callId, errorName: 'Error' }, 'Live thinking sound unavailable'],
      ])
    },
  )

  test('a sound that fails to stop as the call closes does not hold up the close', async () => {
    const work = gate()
    const f = await fixture({ sound, soundFails: 'stop', gates: { first: work } })
    const call = await f.call()
    call.live.dispatch('slow', 'Question')
    await vi.waitFor(() => expect(f.started).toEqual(['first']))
    expect(f.playing()).toEqual([0.4])
    const closing = call.shutdown()
    work.release()
    await closing
    expect(f.exited).toHaveBeenCalledTimes(1)
    expect(f.backgroundAudio).toEqual(['start', 'close'])
    expect(f.logError.mock.calls).toEqual([
      [{ callId: f.entered[0]!.callId, errorName: 'Error' }, 'Live thinking sound unavailable'],
    ])
  })

  test('plays nothing without a thinking sound configured', async () => {
    const f = await fixture()
    const call = await f.call()
    call.live.dispatch('first', 'Question')
    await vi.waitFor(() => expect(f.result).toHaveBeenCalledTimes(1))
    await call.shutdown()
    expect(f.soundFiles).toEqual([])
    expect(f.backgroundAudio).toEqual([])
    expect(f.plays).toEqual([])
  })
})
