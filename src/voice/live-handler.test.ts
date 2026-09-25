import { defineAgent, isAgent } from '@livekit/agents'
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { z } from 'zod'

import type { Event } from '../types/events'
import type {
  LiveVoiceErrorContext,
  LiveVoiceExitContext,
  LiveVoiceResultContext,
  LiveVoiceControls,
  LiveVoiceContext,
  LiveVoiceHook,
} from './live-types'

import { adk } from '../api'
import { openai } from '../providers/models'
import { serializeContext } from '../providers/openai'
import { configurePricing } from '../providers/pricing'
import { InMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { useTestPricing } from '../test-support/pricing-registry'
import { UsageReportingAdapter } from '../test-support/usage-adapter'
import { createLiveVoiceHandler } from './live-handler'

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
  class VoiceSession extends EventEmitter {
    agent?: VoiceAgent
    closed = false
    constructor() {
      super()
      sessions.push(this)
    }
    async start({ agent }: { agent: VoiceAgent }) {
      startCalls()
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
  const error = vi.fn<(ctx: LiveVoiceErrorContext) => 'continue' | 'end' | void>((ctx) => {
    if (options.errorAction === 'continue') ctx.voice.appendCommentary('Recovered')
    return options.errorAction
  })
  const result = vi.fn<(ctx: LiveVoiceResultContext) => void>()
  const exited = vi.fn<(ctx: LiveVoiceExitContext) => void>()
  const entered: LiveVoiceContext[] = []
  const deleteRoom = vi.fn<(room: string) => Promise<void>>(async () => {})
  const logError = vi.fn<(data: unknown, message: string) => void>()
  const setup = vi.fn<() => Promise<{ sessionId: string; state: { answer: string } }>>(
    async () => ({ sessionId: options.setupId!, state: { answer: 'seeded' } }),
  )
  // Only the external LiveKit transport is replaced; backend execution and persistence are real ADK.
  const deps = {
    agents: () => ({
      defineAgent,
      voice: {
        Agent: VoiceAgent,
        AgentSession: VoiceSession,
        AgentSessionEventTypes: {
          Close: 'close',
          MetricsCollected: 'metrics_collected',
          UserStateChanged: 'user_state_changed',
          AgentStateChanged: 'agent_state_changed',
          SpeechCreated: 'speech_created',
        },
      },
      log: () => ({ error: logError }),
    }),
    clock: options.clock,
    lineSettleMs: 10,
    commentaryStartMs: 100,
    openai: () => ({ realtime: { GPTLiveModel: class {}, GPTLiveSession: LiveSession } }),
    livekitServer: () => ({
      RoomServiceClient: class {
        deleteRoom = deleteRoom
      },
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
      setup: options.setupId ? setup : undefined,
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
                  throw new Error('Result failed')
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
    call.live.dispatch('overlap', 'Wait')
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
      'Actually no',
      'Wait',
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
    expect(messages[5]).toMatchObject({ transcriptFragment: { startMs: null, endMs: null } })
    const serialized = JSON.stringify(serializeContext(f.adapter.stepCalls[0]!.ctx))
    expect(serialized).toContain('2000–5000 ms] Is that your address, and may I send')
    expect(serialized).toContain('2500–2800 ms] Yes')
    expect(serialized).toContain('connection 2; 0–500 ms] Actually no')
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

test('an uninterrupted line waits for a delegation in flight', async () => {
  const stuck = gate()
  const f = await fixture({ gates: { first: stuck }, playoutTimeoutMs: 1_000 })
  const call = await f.call()
  call.live.speak(call.session) // the greeting
  call.live.dispatch('first-id', 'Question')
  await vi.waitFor(() => expect(f.started).toEqual(['first']))
  f.entered[0]!.voice.appendCommentary('Explain the time limit.', { allowInterruptions: false })
  await sleep(50)
  expect(given(call.live, 'Explain the time limit.')).toEqual([])
  stuck.release()
  await vi.waitFor(() => expect(given(call.live, 'Explain the time limit.')).toHaveLength(1))
  await call.shutdown()
})

test('an uninterrupted line waits for an earlier ordinary line to start its turn', async () => {
  const f = await fixture({ playoutTimeoutMs: 1_000 })
  const call = await f.call()
  const voice = f.entered[0]!.voice
  voice.appendCommentary('Your request has been sent.')
  voice.appendCommentary('Say goodbye.', { allowInterruptions: false })
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

test('an earlier ordinary line GPT Live never speaks holds an uninterrupted line only briefly', async () => {
  const f = await fixture({ playoutTimeoutMs: 5_000 })
  const call = await f.call()
  call.live.speak(call.session) // the greeting
  const voice = f.entered[0]!.voice
  voice.appendCommentary('Your request has been sent.')
  const givenAt = Date.now()
  voice.appendCommentary('Say goodbye.', { allowInterruptions: false })
  await vi.waitFor(() => expect(given(call.live, 'Say goodbye.')).toHaveLength(1), {
    timeout: 1_000,
  })
  expect(Date.now() - givenAt).toBeGreaterThanOrEqual(90)
  expect(f.logError).not.toHaveBeenCalledWith(expect.anything(), 'Live line_given_while_busy')
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

test('asks on each silence with a count caller speech resets, and ends when no hook keeps the call', async () => {
  const counts: number[] = []
  const f = await fixture({
    timeouts: { inactivity: 40 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return ctx.inactivityCount < 2 ? false : undefined
      },
    },
  })
  const call = await f.call()
  await vi.waitFor(() => expect(counts).toEqual([0]))
  call.session.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
  call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
  await vi.waitFor(() => expect(f.deleteRoom).toHaveBeenCalledTimes(1))
  expect(counts).toEqual([0, 0, 1, 2])
  expect(await endReason(f)).toMatchObject({ data: { reason: 'inactivity' } })
  expect(f.exited).toHaveBeenCalledTimes(1)
})

test('skips a silence hook when the caller spoke while it waited to run', async () => {
  const enterGate = gate()
  const counts: number[] = []
  const f = await fixture({
    enterGate,
    timeouts: { inactivity: 30 },
    lifecycle: {
      onInactivity(ctx) {
        counts.push(ctx.inactivityCount)
        return false
      },
    },
  })
  const pending = f.call()
  await vi.waitFor(() => expect(f.entered).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 45))
  f.sessions[0]!.emit('user_state_changed', { oldState: 'listening', newState: 'speaking' })
  enterGate.release()
  const call = await pending
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(counts).toEqual([])
  call.session.emit('user_state_changed', { oldState: 'speaking', newState: 'listening' })
  await vi.waitFor(() => expect(counts).toEqual([0]))
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
