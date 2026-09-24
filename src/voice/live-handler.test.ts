import { defineAgent, isAgent } from '@livekit/agents'
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { z } from 'zod'

import type { Event } from '../types/events'
import type {
  LiveVoiceContext,
  LiveVoiceErrorContext,
  LiveVoiceResultContext,
  LiveVoiceControls,
} from './live-types'

import { adk } from '../api'
import { openai } from '../providers/models'
import { serializeContext } from '../providers/openai'
import { InMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter } from '../testing/mock/adapter'
import { openGPTLiveTranscript } from './gpt-live-transcript'
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
class LiveSession extends EventEmitter {
  sessionId: string | undefined = 'connection-one'
  sent: Array<{ kind: string; text: string; delegationId?: string }> = []
  appendThinking(text: string, options: { delegationId?: string }) {
    this.sent.push({ kind: 'thinking', text, ...options })
  }
  appendCommentary(text: string, options: { delegationId?: string }) {
    this.sent.push({ kind: 'commentary', text, ...options })
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
  } = {},
) {
  const store = new InMemoryStore()
  const closeStore = vi.spyOn(store, 'close')
  const adapter = new MockAdapter({
    responses: ['first', 'second', 'third'].map((id) => ({
      toolCalls: [{ name: 'lookup', args: { id } }],
    })),
  })
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
  const exited = vi.fn<(ctx: LiveVoiceContext) => void>()
  const entered: LiveVoiceContext[] = []
  const deleteRoom = vi.fn<(room: string) => Promise<void>>(async () => {})
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
        AgentSessionEventTypes: { Close: 'close' },
      },
      log: () => ({ error: vi.fn<(data: unknown, message: string) => void>() }),
    }),
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
            : (ctx) => {
                const { reply } = z.object({ reply: z.string() }).parse(ctx.output)
                previousAnswers.push(ctx.state.answer)
                ctx.state.update({ answer: reply })
                result(ctx)
                if (
                  options.failResult === true ||
                  (options.failResult === 'once' && result.mock.calls.length === 1)
                )
                  throw new Error('Result failed')
                ctx.voice.appendCommentary(reply)
              },
          onError: options.omitError ? undefined : error,
          onExit: exited,
        },
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
    const metadata = saved!.events.find(
      (event) => event.type === 'annotation' && event.label === 'live-delegation',
    )
    expect(metadata).toMatchObject({
      data: {
        callId: f.entered[0]!.callId,
        delegation: { id: 'first-id', connectionId: 'connection-one' },
        transcriptThrough: expect.any(Number),
      },
    })
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
    const work = f.entered[0]!.session.events.find(
      (event) => event.type === 'annotation' && event.label === 'live-backend-work',
    )
    expect(work?.type === 'annotation' && work.data?.receiptThroughAtCompletion).toBeGreaterThan(
      f.result.mock.calls[1]![0].delegation.nativeThrough,
    )
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
  const transcript = await openGPTLiveTranscript({ store: f.store, callId })
  expect(transcript.snapshot().fragments.map((fragment) => fragment.text)).toContain('Goodbye')
  await transcript.close()
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

test('close waits for a backend transfer already in progress before finalizing the ledger', async () => {
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
  // Past the first bound (400 ms) and inside the transfer's second bound (800 ms).
  await new Promise((resolve) => setTimeout(resolve, 600))
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

test('a stalled backend transfer cannot hold call termination past its second bound', async () => {
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
