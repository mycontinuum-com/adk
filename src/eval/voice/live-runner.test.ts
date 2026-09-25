import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { z } from 'zod'

import type { LiveVoiceResultContext } from '../../voice/live-types'

import { adk } from '../../api'
import { openai, realtime } from '../../providers/models'
import { configurePricing } from '../../providers/pricing'
import { InMemoryStore } from '../../session/memory'
import { sessionService } from '../../session/service'
import { useTestPricing } from '../../test-support/pricing-registry'
import { UsageReportingAdapter } from '../../test-support/usage-adapter'
import { createLiveVoiceHandler } from '../../voice/live-handler'
import { eventSequenceMetric } from '../metrics/events'
import { createVoiceEvalCase } from './control'
import { runLiveVoiceCase } from './live-runner'

vi.mock('../../voice/livekit-model', () => ({ createLiveKitModel: () => ({}) }))
vi.mock('../../voice/livekit-agent', () => ({ createLiveKitAgent: () => new SDKAgent() }))
class LiveSession extends EventEmitter {
  sessionId = 'connection'
  appendThinking() {}
  appendInstructions() {}
  appendCommentary(text: string) {
    this.emit('openai_server_event_received', {
      type: 'session.output_transcript.delta',
      event_id: 'reply',
      delta: text,
      start_ms: 500,
      end_ms: 1000,
    })
  }
}
class SDKAgent {
  constructor(readonly options?: Record<string, unknown>) {}
  duplexSession = new LiveSession()
  async onEnter() {}
  async onExit() {}
}
async function fixture() {
  const store = new InMemoryStore()
  const adapter = new UsageReportingAdapter({
    responses: [{ toolCalls: [{ name: 'lookup', args: {} }] }, { text: 'Open at nine' }],
  })
  adapter.reportUsage = false
  const app = adk({
    name: 'live-eval',
    store,
    adapters: { openai: adapter },
    schema: { session: { count: z.number().default(0) } },
  })
  let reportUsage = false
  const tool = vi.fn<() => { hours: string }>(() => ({ hours: 'nine' }))
  const lookup = app.tool({
    name: 'lookup',
    description: 'Hours',
    schema: z.object({}),
    execute(ctx) {
      ctx.state.update({ count: ctx.state.count + 1 })
      return tool()
    },
  })
  const agent = app.agent({
    name: 'voice',
    model: openai.live('gpt-live-1'),
    context: [app.context.system('Receptionist')],
  })
  const backend = app.agent({
    name: 'backend',
    model: openai('mock'),
    tools: [lookup],
    context: [app.context.history()],
  })
  const userAgent = app.agent({
    name: 'caller',
    model: realtime({ model: openai('gpt-realtime') }),
    context: [app.context.system('Ask hours')],
  })
  const rooms: Room[] = []
  let failTransport = false
  let callerDelegates = false
  let setupDelay: Promise<void> | undefined
  let handlerCloseDelayMs = 0
  let callerCloseDelayMs = 0
  class Room extends EventEmitter {
    name = 'test-room'
    started?: SDKAgent
    remoteParticipants = new Map([['voice-eval-user', { identity: 'voice-eval-user' }]])
    disconnect = vi.fn<() => Promise<void>>(async () => {
      this.emit('disconnected')
    })
    async connect() {
      await setupDelay
    }
    constructor() {
      super()
      rooms.push(this)
    }
  }
  const closeCaller = vi.fn<() => void>()
  const liveSessions: AgentSession[] = []
  const callerSessions: AgentSession[] = []
  const callerAudio: boolean[] = []
  class AgentSession extends EventEmitter {
    agent?: SDKAgent
    room?: Room
    output = {
      setAudioEnabled: (enabled: boolean) => {
        if (this.agent?.constructor === SDKAgent) callerAudio.push(enabled)
      },
    }
    async start({ agent: started, room }: { agent: SDKAgent; room: Room }) {
      this.agent = started
      this.room = room
      await started.onEnter()
      if (room === rooms[1]) {
        room.started = started
        callerSessions.push(this)
        if (reportUsage && started.constructor === SDKAgent)
          this.emit('metrics_collected', {
            metrics: {
              type: 'realtime_model_metrics',
              inputTokens: 0,
              outputTokens: 10_000,
              inputTokenDetails: { audioTokens: 0, textTokens: 0, cachedTokens: 0 },
              outputTokenDetails: { audioTokens: 10_000, textTokens: 0 },
            },
          })
        if (callerDelegates) started.duplexSession.emit('delegation_created', { id: 'caller' })
        for (const [transcript, isFinal] of [
          ['Hi, this is', false],
          ['Hi, this is Andi.', true],
          ['   ', true],
        ] as const)
          this.emit('user_input_transcribed', { transcript, isFinal, createdAt: Date.now() })
        return
      }
      liveSessions.push(this)
      if (failTransport) {
        this.emit('close', { error: new Error('socket failed') })
        return
      }
      room.emit('activeSpeakersChanged', [{ identity: 'voice-eval-agent' }])
      started.duplexSession.emit('openai_server_event_received', {
        type: 'session.input_transcript.delta',
        event_id: 'input',
        delta: 'Hours?',
        start_ms: 0,
        end_ms: 800,
      })
      await new Promise((resolve) => setTimeout(resolve, 2))
      started.duplexSession.emit('delegation_created', { id: 'delegation' })
    }
    async close() {
      if (this.agent && this.room !== rooms[1] && handlerCloseDelayMs)
        await new Promise((resolve) => setTimeout(resolve, handlerCloseDelayMs))
      if (this.room === rooms[1] && callerCloseDelayMs)
        await new Promise((resolve) => setTimeout(resolve, callerCloseDelayMs))
      closeCaller()
      if (reportUsage && this.agent && this.agent.constructor !== SDKAgent) {
        // GPT Live drains its final cumulative usage while closing: 12 s, then 15 s for the
        // handler; a GPT Live caller reports 30 s.
        for (const seconds of this.room === rooms[1] ? [30] : [12, 3])
          this.emit('metrics_collected', {
            metrics: {
              type: 'realtime_model_metrics',
              requestId: 'connection',
              sessionDurationMs: seconds * 1000,
            },
          })
        this.agent.duplexSession.emit('openai_server_event_received', { type: 'session.closed' })
      }
      await this.agent?.onExit()
    }
  }
  class CallerModel {
    constructor(readonly options: Record<string, unknown>) {
      callerModels.push(this)
    }
  }
  const callerModels: CallerModel[] = []
  const deleteRoom = vi.fn<() => Promise<void>>(async () => {})
  const sdk = {
    lk: {
      voice: {
        Agent: SDKAgent,
        AgentSession,
        AgentSessionEventTypes: {
          Close: 'close',
          MetricsCollected: 'metrics_collected',
          UserInputTranscribed: 'user_input_transcribed',
        },
      },
      defineAgent: () => {},
      log: () => ({ error() {} }),
    },
    rtc: {
      Room,
      RoomEvent: {
        ActiveSpeakersChanged: 'activeSpeakersChanged',
        Disconnected: 'disconnected',
        ParticipantConnected: 'participantConnected',
      },
    },
    serverSdk: {
      RoomServiceClient: class {
        createRoom = vi.fn<() => Promise<void>>(async () => {})
        deleteRoom = deleteRoom
      },
      AccessToken: class {
        addGrant() {}
        async toJwt() {
          return 'token'
        }
      },
    },
  }
  const deps = {
    sdk: () => sdk,
    handler: (
      config: Parameters<typeof createLiveVoiceHandler>[0],
      context: Parameters<typeof createLiveVoiceHandler>[1],
    ) =>
      createLiveVoiceHandler(config, context, {
        agents: () => sdk.lk,
        openai: () => ({ realtime: { GPTLiveModel: class {}, GPTLiveSession: LiveSession } }),
        livekitServer: () => sdk.serverSdk,
      } as unknown as Parameters<typeof createLiveVoiceHandler>[2]),
    openai: () => ({
      realtime: {
        GPTLiveModel: CallerModel,
        GPTLiveSession: LiveSession,
      },
    }),
  } as unknown as NonNullable<Parameters<typeof runLiveVoiceCase>[5]>
  const result = vi.fn<(ctx: LiveVoiceResultContext<any, string>) => void>((ctx) => {
    ctx.voice.appendCommentary(ctx.output)
  })
  const run = (extra = {}) =>
    runLiveVoiceCase(
      {
        name: 'native',
        agent,
        backend,
        userAgent,
        hooks: [{ onResult: result }],
        durationMs: 60,
        timeout: 1000,
        ...extra,
      },
      { room: { url: 'wss://test' } },
      { app, store, sessionService: sessionService(store) },
      undefined,
      undefined,
      deps,
    )
  return {
    app,
    agent,
    backend,
    userAgent,
    run,
    tool,
    result,
    rooms,
    deleteRoom,
    closeCaller,
    callerAudio,
    closeLiveSession: (reason: string) => {
      liveSessions.at(-1)!.emit('close', { reason })
    },
    failCaller: (message: string) => {
      callerSessions.at(-1)!.emit('close', { error: new Error(message) })
    },
    callerModels,
    delayCallerClose: (milliseconds: number) => {
      callerCloseDelayMs = milliseconds
    },
    delayHandlerClose: (milliseconds: number) => {
      handlerCloseDelayMs = milliseconds
    },
    failTransport: () => {
      failTransport = true
    },
    reportUsage: () => {
      reportUsage = true
      adapter.reportUsage = true
    },
    callerDelegates: () => {
      callerDelegates = true
    },
    delay: (promise: Promise<void>) => {
      setupDelay = promise
    },
  }
}

beforeEach(useTestPricing)
afterEach(() => configurePricing(false))

test('runs the production handler and persists call state, native fragments and tool pairs', async () => {
  const f = await fixture()
  try {
    const run = await f.run({ initialState: { session: { count: 4 } } })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe('completed')
    expect(run.session.state.count).toBe(5)
    expect(f.result).toHaveBeenCalledOnce()
    const ledgerIds = run.session.events.map((event) => event.id)
    expect(run.events.map((event) => event.id).toSorted()).toEqual(ledgerIds.toSorted())
    const sequence = eventSequenceMetric({
      name: 'conversation',
      sequence: (['user', 'tool_call', 'tool_result', 'assistant'] as const).map((eventType) => ({
        eventType,
      })),
    })
    expect(await sequence.evaluate(run)).toMatchObject({ passed: true })
    expect(await sequence.evaluate({ session: run.session })).toMatchObject({ passed: false })
    expect(run.session.events.map((event) => event.id)).toEqual(ledgerIds)
    expect(run.events.filter((event) => event.type === 'tool_call')).toHaveLength(1)
    expect(run.events.filter((event) => event.type === 'tool_result')).toHaveLength(1)
    expect(run.transcript.map((event) => event.text)).toEqual(['Hours?', 'Open at nine'])
    expect(run.events.find((event) => event.type === 'user')?.transcriptFragment).toMatchObject({
      startMs: 0,
      endMs: 800,
    })
    expect(run.timing.timeToFirstSpeechMs).toBeDefined()
    expect((await f.app.sessions.get(run.session.id))?.state.count).toBe(5)
    expect(f.callerModels).toEqual([])
    expect(f.deleteRoom).toHaveBeenCalledOnce()
    expect(f.rooms.every((room) => room.disconnect.mock.calls.length)).toBe(true)
  } finally {
    await f.app.close()
  }
})
test('reports backend, GPT Live and simulated caller cost separately', async () => {
  const f = await fixture()
  try {
    f.reportUsage()
    const run = await f.run()
    expect(run.error).toBeUndefined()
    expect(run.usage?.modelCalls).toBe(2)
    const usage = run.liveUsage!
    expect(usage.backend.usage?.modelCalls).toBe(2)
    expect(usage.backend.cost).toEqual({ basis: 'reported', totalCost: 0.3, currency: 'USD' })
    expect(usage.voice).toEqual({
      modelName: 'gpt-live-1',
      seconds: 15,
      cost: { basis: 'reported', totalCost: 0.0125, currency: 'USD' },
    })
    expect(usage.caller.cost.basis).toBe('reported')
    expect(usage.caller.cost.basis !== 'unavailable' && usage.caller.cost.totalCost).toBeCloseTo(
      0.64,
      12,
    )
    expect(usage.total.basis).toBe('reported')
    expect(usage.total.basis !== 'unavailable' && usage.total.totalCost).toBeCloseTo(0.9525, 12)
  } finally {
    await f.app.close()
  }
})
test('uses backend toolMocks', async () => {
  const f = await fixture()
  try {
    const run = await f.run({ toolMocks: { lookup: { execute: () => ({ hours: 'mocked' }) } } })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe('completed')
    expect(f.tool).not.toHaveBeenCalled()
    expect(run.events.find((event) => event.type === 'tool_result')?.result).toEqual({
      hours: 'mocked',
    })
  } finally {
    await f.app.close()
  }
})
test('fatal transport failure does not pass', async () => {
  const f = await fixture()
  try {
    f.failTransport()
    expect((await f.run()).status).toBe('error')
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    await f.app.close()
  }
})
test('cleans up rejected product setup', async () => {
  const f = await fixture()
  try {
    const run = await f.run({
      setup: async () => {
        throw new Error('setup failed')
      },
    })
    expect(run.status).toBe('error')
    expect(run.error?.message).toBe('setup failed')
    expect(f.closeCaller).toHaveBeenCalled()
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    await f.app.close()
  }
})
test('wall timeout is distinct from a successful duration', async () => {
  const f = await fixture()
  try {
    f.delay(new Promise((resolve) => setTimeout(resolve, 30)))
    const run = await f.run({ timeout: 5 })
    expect(run.status).toBe('timeout')
    expect(f.result).not.toHaveBeenCalled()
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    await f.app.close()
  }
})

test('lets a GPT Live caller wait out its session close without failing the run', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    f.delayCallerClose(6_000)
    const pending = f.run({ timeout: 20_000 })
    await vi.advanceTimersByTimeAsync(7_000)
    const run = await pending
    expect(run.error).toBeUndefined()
    expect(run.status).toBe('completed')
  } finally {
    vi.useRealTimers()
    await f.app.close()
  }
})

test('bounds cleanup when a network connection never settles', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    f.delay(new Promise(() => {}))
    const pending = f.run({ timeout: 10 })
    await vi.advanceTimersByTimeAsync(5_100)
    const run = await pending
    expect(run.status).toBe('error')
    expect(run.error?.message).toBe('Voice eval cleanup timed out: startup cancellation')
    expect(f.rooms.every((room) => room.disconnect.mock.calls.length)).toBe(true)
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    await f.app.close()
  }
})

test('rejects missing result delivery and invalid observation windows before connecting', async () => {
  const f = await fixture()
  try {
    await expect(f.run({ hooks: [] })).rejects.toThrow('production onResult')
    await expect(f.run({ durationMs: Infinity })).rejects.toThrow('finite and positive')
    expect(f.rooms).toHaveLength(0)
  } finally {
    await f.app.close()
  }
})

test('finalizes a call ended by its production hook and preserves final state', async () => {
  const f = await fixture()
  try {
    const run = await f.run({
      durationMs: 10_000,
      hooks: [
        {
          onResult(ctx) {
            ctx.voice.end()
          },
          onExit(ctx) {
            ctx.state.update({ count: 7 })
          },
        },
      ],
    })
    expect(run.status).toBe('completed')
    expect(run.session.state.count).toBe(7)
    expect((await f.app.sessions.get(run.session.id))?.state.count).toBe(7)
    expect(
      run.events.filter(
        (event) => event.type === 'annotation' && event.label === 'live-call-ended',
      ),
    ).toHaveLength(1)
  } finally {
    await f.app.close()
  }
})

test('a caller error during the hangup grace fails the run', async () => {
  const f = await fixture()
  try {
    const controlled = createVoiceEvalCase((control) => ({
      name: 'disconnect then fail',
      agent: f.agent,
      backend: f.backend,
      userAgent: f.userAgent,
      hooks: [
        {
          async onResult() {
            await control.disconnectUser()
            f.failCaller('caller transport failed')
          },
        },
      ],
    }))
    const run = await f.run({ ...controlled, durationMs: 1_500, timeout: 2_000 })
    expect(run.status).toBe('error')
    expect(run.error?.message).toBe('caller transport failed')
  } finally {
    await f.app.close()
  }
})

test('binds native eval caller disconnect control', async () => {
  const f = await fixture()
  try {
    const controlled = createVoiceEvalCase((control) => ({
      name: 'disconnect',
      agent: f.agent,
      backend: f.backend,
      userAgent: f.userAgent,
      hooks: [
        {
          async onResult() {
            await control.disconnectUser()
            setTimeout(() => f.closeLiveSession('participant_disconnected'), 20)
          },
        },
      ],
    }))
    const run = await f.run({ ...controlled, durationMs: 1_500, timeout: 2_000 })
    expect(run.status).toBe('participant_left')
    expect(
      run.events.filter(
        (event) => event.type === 'annotation' && event.label === 'live-call-ended',
      ),
    ).toEqual([
      {
        id: expect.any(String),
        type: 'annotation',
        kind: 'mark',
        label: 'live-call-ended',
        createdAt: expect.any(Number),
        invocationId: run.session.id,
        agentName: f.agent.name,
        data: { reason: 'participant_disconnected' },
      },
    ])
    expect(run.durationMs).toBeLessThan(1_000)
    expect(f.deleteRoom).toHaveBeenCalledOnce()
    expect(() => controlled.evalControl!.disconnectUser()).toThrow('not bound')
  } finally {
    await f.app.close()
  }
})

test('mutes and restores the simulated caller through the eval control', async () => {
  const f = await fixture()
  try {
    const controlled = createVoiceEvalCase((control) => ({
      name: 'mute',
      agent: f.agent,
      backend: f.backend,
      userAgent: f.userAgent,
      hooks: [
        {
          onResult() {
            control.muteUser(true)
            control.muteUser(false)
          },
        },
      ],
    }))
    const run = await f.run(controlled)
    expect(run.error).toBeUndefined()
    expect(f.callerAudio).toEqual([false, true])
  } finally {
    await f.app.close()
  }
})

test('ends a run the caller left within the grace period when the handler never closes', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    const controlled = createVoiceEvalCase((control) => ({
      name: 'disconnect',
      agent: f.agent,
      backend: f.backend,
      userAgent: f.userAgent,
      hooks: [
        {
          async onResult() {
            await control.disconnectUser()
          },
        },
      ],
    }))
    const pending = f.run({ ...controlled, durationMs: 15_000, timeout: 20_000 })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(f.deleteRoom).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    const run = await pending
    expect(run.status).toBe('participant_left')
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    await f.app.close()
  }
})

test('allows the SDK close fallback to settle within the existing case deadline', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    f.delayHandlerClose(5_001)
    const pending = f.run({ timeout: 10_000 })
    await vi.advanceTimersByTimeAsync(5_100)
    const run = await pending
    expect(run.status).toBe('completed')
    expect(run.error).toBeUndefined()
    expect(run.session.events).toContainEqual(
      expect.objectContaining({ type: 'annotation', label: 'live-call-ended' }),
    )
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    await f.app.close()
  }
})

test('fails handler cleanup at the case deadline when shutdown remains pending', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    f.delayHandlerClose(8_000)
    const startedAt = Date.now()
    const pending = f.run({ timeout: 7_000 })
    await vi.advanceTimersByTimeAsync(7_050)
    const run = await pending
    expect(run.status).toBe('error')
    expect(run.error?.message).toBe('Voice eval cleanup timed out: Live handler shutdown')
    expect(run.durationMs).toBe(7_000)
    expect(Date.now() - startedAt).toBe(7_050)
    expect(f.rooms.every((room) => room.disconnect.mock.calls.length)).toBe(true)
    expect(f.deleteRoom).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_100)
  } finally {
    vi.useRealTimers()
    await f.app.close()
  }
})

test.each([
  ['user_initiated', 'disconnected'],
  ['participant_disconnected', 'participant_left'],
  ['job_shutdown', 'disconnected'],
] as const)(
  'a Live session closed by %s before the window ends is %s, not completed',
  async (reason, expected) => {
    const f = await fixture()
    try {
      const run = await f.run({
        durationMs: 10_000,
        hooks: [
          {
            onResult() {
              f.closeLiveSession(reason)
            },
          },
        ],
      })
      expect(run.error).toBeUndefined()
      expect(run.status).toBe(expected)
      expect(run.durationMs).toBeLessThan(10_000)
      expect(f.deleteRoom).toHaveBeenCalledOnce()
    } finally {
      await f.app.close()
    }
  },
)

test.each([
  [{ inactivity: 30 }, 'inactivity_timeout'],
  [{ expiry: 30 }, 'max_duration'],
] as const)('a Live call its handler ends at %j reports %s', async (timeouts, expected) => {
  const f = await fixture()
  try {
    const run = await f.run({ durationMs: 10_000, timeouts, playoutTimeoutMs: 20 })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(expected)
    expect(run.durationMs).toBeLessThan(10_000)
  } finally {
    await f.app.close()
  }
})

test('reports final caller transcriptions of the agent as what the caller heard', async () => {
  const f = await fixture()
  try {
    const run = await f.run()
    expect(run.callerHeard?.map(({ text }) => text)).toEqual(['Hi, this is Andi.'])
    expect(run.callerHeard?.[0]!.atMs).toBeGreaterThanOrEqual(0)
  } finally {
    await f.app.close()
  }
})

test('an agent-ended call whose backend work never settled is an error, not completed', async () => {
  const f = await fixture()
  try {
    const run = await f.run({
      durationMs: 10_000,
      backendTimeoutMs: 20,
      toolMocks: {
        lookup: {
          execute: (_args, ctx) => {
            if (ctx.voice && 'appendCommentary' in ctx.voice) ctx.voice.end()
            return new Promise(() => {})
          },
        },
      },
    })
    expect(run.status).toBe('error')
    expect(run.error?.message).toBe('Live backend work did not settle before close')
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    await f.app.close()
  }
})

test('simulates the caller on GPT Live from its instructions alone', async () => {
  const f = await fixture()
  try {
    const userAgent = f.app.agent({
      name: 'live caller',
      model: openai.live('gpt-live-1', { voice: 'cedar' }),
      context: [f.app.context.system('Ask for the opening hours.')],
    })
    const run = await f.run({ userAgent })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe('completed')
    expect(f.result).toHaveBeenCalledOnce()
    expect(f.callerModels.map((model) => model.options)).toEqual([
      expect.objectContaining({ model: 'gpt-live-1', voice: 'cedar', delegation: 'client' }),
    ])
    expect(f.rooms[1]!.started!.options).toEqual({
      instructions: 'Ask for the opening hours.',
      tools: {},
      llm: f.callerModels[0],
    })
  } finally {
    await f.app.close()
  }
})

test('fails the run when the GPT Live caller delegates', async () => {
  const f = await fixture()
  try {
    f.callerDelegates()
    const run = await f.run({
      userAgent: f.app.agent({
        name: 'live caller',
        model: openai.live('gpt-live-1'),
        context: [f.app.context.system('Ask for the opening hours.')],
      }),
    })
    expect(run.status).toBe('error')
    expect(run.error?.message).toBe(
      'The GPT Live caller delegated, but a simulated caller has no backend',
    )
    expect(f.deleteRoom).toHaveBeenCalledOnce()
  } finally {
    await f.app.close()
  }
})

test('reports a GPT Live caller cost from its session time', async () => {
  const f = await fixture()
  try {
    f.reportUsage()
    const run = await f.run({
      userAgent: f.app.agent({
        name: 'live caller',
        model: openai.live('gpt-live-1'),
        context: [f.app.context.system('Ask for the opening hours.')],
      }),
    })
    expect(run.error).toBeUndefined()
    expect(run.liveUsage!.caller).toEqual({
      modelName: 'gpt-live-1',
      seconds: 30,
      cost: { basis: 'reported', totalCost: 0.025, currency: 'USD' },
    })
    const total = run.liveUsage!.total
    expect(total.basis !== 'unavailable' && total.totalCost).toBeCloseTo(0.3375, 12)
  } finally {
    await f.app.close()
  }
})
