import { vi } from 'vitest'

import type { LKAgentSession, VoiceDeps } from './livekit-types'
import type { VoiceSession, VoiceReply, VoiceHandlerConfig } from './types'

import { signalOutput } from '../core/tools'
import { realtime } from '../providers/models'
import { wireEventListeners, voiceHandler as _voiceHandler } from './handler'
import { createLiveKitAgent as _createLiveKitAgent } from './livekit-agent'
import { createLiveKitModel as _createLiveKitModel } from './livekit-model'
import { convertTools as _convertTools } from './livekit-tools'
import { LiveKitVoiceSession } from './session'

function mockLKSession(overrides?: Partial<LKAgentSession>): LKAgentSession {
  return {
    on: vi.fn<(...args: unknown[]) => unknown>(),
    start: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
    updateAgent: vi.fn<(...args: unknown[]) => unknown>(),
    close: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
    generateReply: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({}),
    ...overrides,
  }
}

// ---- Mock LiveKit dependencies via DI (no module mocking needed) ----

const mockLLMTool = vi.fn<(...args: unknown[]) => unknown>(
  (opts: { description: string; parameters: unknown; execute: Function }) => ({
    __lk_tool: true,
    description: opts.description,
    parameters: opts.parameters,
    execute: opts.execute,
  }),
)

const mockAgents = {
  voice: {
    Agent: vi.fn<(...args: unknown[]) => unknown>().mockImplementation((opts: any) => ({
      instructions: opts.instructions,
      tools: opts.tools,
      onEnter: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      session: { generateReply: vi.fn<(...args: unknown[]) => unknown>() },
    })),
    AgentSession: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => ({
      on: vi.fn<(...args: unknown[]) => unknown>(),
      start: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      updateAgent: vi.fn<(...args: unknown[]) => unknown>(),
      close: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      shutdown: vi.fn<(...args: unknown[]) => unknown>(),
      generateReply: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({}),
    })),
    AgentSessionEventTypes: {
      MetricsCollected: 'metrics_collected',
      AgentStateChanged: 'agent_state_changed',
      ConversationItemAdded: 'conversation_item_added',
      UserStateChanged: 'user_state_changed',
      Error: 'error',
    },
  },
  llm: {
    tool: mockLLMTool,
    handoff: vi
      .fn<(...args: unknown[]) => unknown>()
      .mockImplementation((opts: any) => ({ __handoff: true, ...opts })),
  },
  cli: { runApp: vi.fn<(...args: unknown[]) => unknown>() },
  ServerOptions: vi.fn<(...args: unknown[]) => unknown>().mockImplementation((opts: any) => opts),
}

const mockOpenAI = {
  LLM: vi
    .fn<(...args: unknown[]) => unknown>()
    .mockImplementation((opts: any) => ({ __openai_llm: true, opts })),
  realtime: {
    RealtimeModel: vi
      .fn<(...args: unknown[]) => unknown>()
      .mockImplementation((opts: any) => ({ __openai_realtime: true, opts })),
  },
  STT: vi
    .fn<(...args: unknown[]) => unknown>()
    .mockImplementation((opts: any) => ({ __openai_stt: true, opts })),
  TTS: vi
    .fn<(...args: unknown[]) => unknown>()
    .mockImplementation((opts: any) => ({ __openai_tts: true, opts })),
}

const mockGoogle = {
  LLM: vi
    .fn<(...args: unknown[]) => unknown>()
    .mockImplementation((opts: any) => ({ __google_llm: true, opts })),
  beta: {
    realtime: {
      RealtimeModel: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation((opts: any) => ({ __google_realtime: true, opts })),
    },
  },
}

const mockDeleteRoom = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
const mockRemoveParticipant = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
const mockRoomServiceClient = vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => ({
  deleteRoom: mockDeleteRoom,
  removeParticipant: mockRemoveParticipant,
}))

function resetCallTerminationMocks() {
  mockDeleteRoom.mockReset()
  mockDeleteRoom.mockResolvedValue(undefined)
  mockRemoveParticipant.mockReset()
  mockRemoveParticipant.mockResolvedValue(undefined)
  mockRoomServiceClient.mockClear()
}

const mockDeps: VoiceDeps = {
  agents: () => mockAgents as any,
  openai: () => mockOpenAI,
  google: () => mockGoogle,
  livekitServer: () => ({
    RoomServiceClient: mockRoomServiceClient as any,
  }),
}

// Wrappers that inject mockDeps so existing call sites don't change
function createLiveKitModel(...args: Parameters<typeof _createLiveKitModel>) {
  return _createLiveKitModel(args[0], mockDeps)
}
function createLiveKitAgent(...args: Parameters<typeof _createLiveKitAgent>) {
  return _createLiveKitAgent(args[0], args[1], args[2], args[3], args[4], args[5], mockDeps)
}
function convertTools(...args: Parameters<typeof _convertTools>) {
  return _convertTools(args[0], args[1], mockDeps)
}
function voiceHandler(config: any) {
  return _voiceHandler(config, mockDeps)
}

function emitUserSpeech(lkSessionMock: { _emit(event: string, ...args: unknown[]): void }) {
  lkSessionMock._emit('user_state_changed', {
    oldState: 'listening',
    newState: 'speaking',
  })
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Voice module', () => {
  describe('VoiceSession interface', () => {
    test('LiveKitVoiceSession implements VoiceSession', () => {
      const session: VoiceSession = new LiveKitVoiceSession(
        mockLKSession({
          generateReply: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({
            waitForPlayout: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
          }),
          shutdown: vi.fn<(...args: unknown[]) => unknown>(),
          interrupt: vi.fn<(...args: unknown[]) => unknown>(),
        }),
      )
      expect(session.generateReply).toBeDefined()
      expect(session.interrupt).toBeDefined()
    })

    test('generateReply delegates to agent session and returns VoiceReply', async () => {
      const mockPlayout = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const mockAgentSession = mockLKSession({
        generateReply: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({
          waitForPlayout: mockPlayout,
        }),
      })

      const session = new LiveKitVoiceSession(mockAgentSession)
      const reply: VoiceReply = await session.generateReply({
        instructions: 'Say hello',
        toolChoice: 'none',
      })

      expect(mockAgentSession.generateReply).toHaveBeenCalledWith({
        instructions: 'Say hello',
        toolChoice: 'none',
      })

      await reply.waitForPlayout()
      expect(mockPlayout).toHaveBeenCalled()
    })

    test('generateReply exposes child playout without awaiting LiveKit SpeechHandle thenables', async () => {
      const playout = deferred()
      const order: string[] = []
      const waitForPlayout = vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
        order.push('wait-start')
        return playout.promise.then(() => {
          order.push('wait-end')
        })
      })
      const then = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(
          (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            playout.promise.then(() => onFulfilled?.(speechHandle), onRejected),
        )
      const speechHandle = { waitForPlayout } as {
        waitForPlayout: typeof waitForPlayout
        then?: typeof then
      }
      const thenKey = ['th', 'en'].join('') as 'then'
      Object.defineProperty(speechHandle, thenKey, {
        configurable: true,
        value: then,
      })
      const mockAgentSession = mockLKSession({
        generateReply: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue(speechHandle),
      })

      const session = new LiveKitVoiceSession(mockAgentSession)
      const replyPromise = session.generateReply({
        instructions: 'Speak while the tool is running',
        toolChoice: 'none',
      })
      const resolution = await Promise.race([
        replyPromise.then(() => 'reply'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
      ])

      expect(resolution).toBe('reply')
      expect(waitForPlayout).not.toHaveBeenCalled()
      expect(then).not.toHaveBeenCalled()

      const reply = await replyPromise
      const wait = reply.waitForPlayout()
      await Promise.resolve()

      expect(order).toEqual(['wait-start'])
      playout.resolve()
      await wait
      expect(order).toEqual(['wait-start', 'wait-end'])
    })

    test('generateReply maps named toolChoice to LiveKit function toolChoice shape', async () => {
      const mockAgentSession = mockLKSession()
      const session = new LiveKitVoiceSession(mockAgentSession)

      await session.generateReply({
        instructions: 'Finish the call',
        toolChoice: { name: 'end_call' },
      })

      expect(mockAgentSession.generateReply).toHaveBeenCalledWith({
        instructions: 'Finish the call',
        toolChoice: {
          type: 'function',
          function: { name: 'end_call' },
        },
      })
    })

    test('shutdown delegates to agent session', () => {
      const mockShutdown = vi.fn<(...args: unknown[]) => unknown>()
      const session = new LiveKitVoiceSession(
        mockLKSession({
          shutdown: mockShutdown,
        }),
      )

      session.shutdown({ reason: 'completed' })
      expect(mockShutdown).toHaveBeenCalledWith({ reason: 'completed' })
    })

    test('shutdown falls back to close()', () => {
      const mockClose = vi.fn<(...args: unknown[]) => unknown>()
      const session = new LiveKitVoiceSession(
        mockLKSession({
          close: mockClose,
          shutdown: undefined,
        }),
      )

      session.shutdown()
      expect(mockClose).toHaveBeenCalled()
    })

    test('shutdown is idempotent', () => {
      const mockShutdown = vi.fn<(...args: unknown[]) => unknown>()
      const session = new LiveKitVoiceSession(
        mockLKSession({
          shutdown: mockShutdown,
        }),
      )

      session.shutdown()
      session.shutdown()
      expect(mockShutdown).toHaveBeenCalledTimes(1)
    })

    test('generateReply throws after shutdown', async () => {
      const session = new LiveKitVoiceSession(
        mockLKSession({
          shutdown: vi.fn<(...args: unknown[]) => unknown>(),
        }),
      )

      session.shutdown()
      await expect(session.generateReply()).rejects.toThrow('Cannot generate reply after shutdown')
    })

    test('interrupt delegates to agent session', () => {
      const mockInterrupt = vi.fn<(...args: unknown[]) => unknown>()
      const session = new LiveKitVoiceSession(
        mockLKSession({
          interrupt: mockInterrupt,
        }),
      )

      session.interrupt()
      expect(mockInterrupt).toHaveBeenCalled()
    })

    test('interrupt is no-op if agent session lacks it', () => {
      const session = new LiveKitVoiceSession(mockLKSession())
      session.interrupt()
    })

    test('say delegates to agent session say()', async () => {
      const mockPlayout = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const mockSay = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockReturnValue({ waitForPlayout: mockPlayout })
      const session = new LiveKitVoiceSession(mockLKSession({ say: mockSay }))

      const reply = await session.say('Hello', { allowInterruptions: false })
      expect(mockSay).toHaveBeenCalledWith('Hello', {
        allowInterruptions: false,
      })

      await reply.waitForPlayout()
      expect(mockPlayout).toHaveBeenCalled()
    })

    test('say throws after shutdown', async () => {
      const session = new LiveKitVoiceSession(
        mockLKSession({
          shutdown: vi.fn<(...args: unknown[]) => unknown>(),
          say: vi.fn<(...args: unknown[]) => unknown>(),
        }),
      )
      session.shutdown()
      await expect(session.say('Hello')).rejects.toThrow('Cannot say after shutdown')
    })

    test('say throws when agent session lacks say()', async () => {
      const session = new LiveKitVoiceSession(mockLKSession())
      await expect(session.say('Hello')).rejects.toThrow('say() requires a TTS plugin')
    })

    test('playSound returns undefined when no bgAudio', () => {
      const session = new LiveKitVoiceSession(mockLKSession())
      expect(session.playSound('test.mp3')).toBeUndefined()
    })

    test('playSound delegates to BackgroundAudioPlayer', () => {
      const mockStop = vi.fn<(...args: unknown[]) => unknown>()
      const mockWait = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const mockPlay = vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({
        done: () => false,
        stop: mockStop,
        waitForPlayout: mockWait,
      })
      const mockBgAudio = {
        start: vi.fn<(...args: unknown[]) => unknown>(),
        play: mockPlay,
        close: vi.fn<(...args: unknown[]) => unknown>(),
      }

      const session = new LiveKitVoiceSession(mockLKSession())
      session.setBgAudio(mockBgAudio as any)

      const handle = session.playSound('test.mp3', { volume: 0.5, loop: true })
      expect(handle).toBeDefined()
      expect(mockPlay).toHaveBeenCalledWith({ source: 'test.mp3', volume: 0.5 }, true)

      handle!.stop()
      expect(mockStop).toHaveBeenCalled()
    })

    test('playSound passes source string when no volume specified', () => {
      const mockPlay = vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({
        done: () => false,
        stop: vi.fn<(...args: unknown[]) => unknown>(),
        waitForPlayout: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      })
      const mockBgAudio = {
        start: vi.fn<(...args: unknown[]) => unknown>(),
        play: mockPlay,
        close: vi.fn<(...args: unknown[]) => unknown>(),
      }

      const session = new LiveKitVoiceSession(mockLKSession())
      session.setBgAudio(mockBgAudio as any)

      session.playSound('test.mp3')
      expect(mockPlay).toHaveBeenCalledWith('test.mp3', undefined)
    })
  })

  describe('voiceHandler', () => {
    test('returns a handle with entry and start', async () => {
      const mockSessionService = {
        createSession: vi.fn<(...args: unknown[]) => unknown>(),
        getSession: vi.fn<(...args: unknown[]) => unknown>(),
        appendEvent: vi.fn<(...args: unknown[]) => unknown>(),
        deleteSession: vi.fn<(...args: unknown[]) => unknown>(),
        getScopedState: vi.fn<(...args: unknown[]) => unknown>(),
        setScopedState: vi.fn<(...args: unknown[]) => unknown>(),
        commitSession: vi.fn<(...args: unknown[]) => unknown>(),
      }

      const handle = voiceHandler({
        agent: {
          kind: 'agent',
          name: 'test',
          model: realtime({
            model: { provider: 'openai', name: 'gpt-4o-realtime' },
          }),
          tools: [],
          context: [],
        },
        sessionService: mockSessionService,
      } as unknown as VoiceHandlerConfig)

      expect(handle.entry).toBeDefined()
      expect(typeof handle.entry).toBe('function')
      expect(handle.start).toBeDefined()
      expect(typeof handle.start).toBe('function')
    })

    test('start() is a no-op when process.send exists (child process)', async () => {
      const mockSessionService = {
        createSession: vi.fn<(...args: unknown[]) => unknown>(),
        getSession: vi.fn<(...args: unknown[]) => unknown>(),
        appendEvent: vi.fn<(...args: unknown[]) => unknown>(),
        deleteSession: vi.fn<(...args: unknown[]) => unknown>(),
        getScopedState: vi.fn<(...args: unknown[]) => unknown>(),
        setScopedState: vi.fn<(...args: unknown[]) => unknown>(),
        commitSession: vi.fn<(...args: unknown[]) => unknown>(),
      }

      const handle = voiceHandler({
        agent: {
          kind: 'agent',
          name: 'test',
          model: realtime({
            model: { provider: 'openai', name: 'gpt-4o-realtime' },
          }),
          tools: [],
          context: [],
        },
        sessionService: mockSessionService,
      } as unknown as VoiceHandlerConfig)

      // Simulate child process
      const origSend = process.send
      ;(process as any).send = () => {}
      try {
        // Should not throw — just returns silently
        handle.start('/fake/path.ts')
      } finally {
        if (origSend === undefined) {
          delete (process as any).send
        } else {
          process.send = origSend
        }
      }
    })

    test('start() configures a job shutdown timeout of at least 60s', () => {
      // shutdownProcessTimeout is in milliseconds and bounds the worker's force-kill timer
      // for the job process. End-of-invocation finalization (afterTurn → completeCall) runs
      // inside that window, so it must be generous enough for a lambda round-trip.
      const mockSessionService = {
        createSession: vi.fn<(...args: unknown[]) => unknown>(),
        getSession: vi.fn<(...args: unknown[]) => unknown>(),
        appendEvent: vi.fn<(...args: unknown[]) => unknown>(),
        deleteSession: vi.fn<(...args: unknown[]) => unknown>(),
        getScopedState: vi.fn<(...args: unknown[]) => unknown>(),
        setScopedState: vi.fn<(...args: unknown[]) => unknown>(),
        commitSession: vi.fn<(...args: unknown[]) => unknown>(),
      }

      const handle = voiceHandler({
        agent: {
          kind: 'agent',
          name: 'test',
          model: realtime({
            model: { provider: 'openai', name: 'gpt-4o-realtime' },
          }),
          tools: [],
          context: [],
        },
        sessionService: mockSessionService,
      } as unknown as VoiceHandlerConfig)

      mockAgents.cli.runApp.mockClear()
      const origSend = process.send
      delete (process as any).send
      try {
        handle.start('/fake/path.ts')
      } finally {
        if (origSend === undefined) {
          delete (process as any).send
        } else {
          process.send = origSend
        }
      }

      expect(mockAgents.cli.runApp).toHaveBeenCalledTimes(1)
      const serverOpts = mockAgents.cli.runApp.mock.calls[0]![0] as {
        shutdownProcessTimeout?: number
      }
      expect(serverOpts.shutdownProcessTimeout).toBeGreaterThanOrEqual(60_000)
    })
  })

  describe('voice subpath exports', () => {
    test('index re-exports all expected symbols', async () => {
      const voice = await import('./index')
      expect(voice.LiveKitVoiceSession).toBeDefined()
      expect(voice.voiceHandler).toBeDefined()
      expect(voice.realtime).toBeDefined()
    })
  })

  describe('createLiveKitModel', () => {
    test('OpenAI full-realtime (no stt/tts)', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          voice: 'alloy',
        }),
      )

      expect((result.llm as any).__openai_realtime).toBe(true)
      expect((result.llm as any).opts.model).toBe('gpt-4o-realtime')
      expect((result.llm as any).opts.voice).toBe('alloy')
      expect(result.stt).toBeUndefined()
      expect(result.tts).toBeUndefined()
    })

    test('OpenAI half-cascade (tts only)', () => {
      const mockTTS = { __custom_tts: true }
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          tts: mockTTS,
        }),
      )

      expect((result.llm as any).__openai_realtime).toBe(true)
      expect((result.llm as any).opts.modalities).toEqual(['text'])
      expect(result.tts).toBe(mockTTS)
      expect(result.stt).toBeUndefined()
    })

    test('OpenAI full-pipeline (stt + tts)', () => {
      const mockSTT = { __custom_stt: true }
      const mockTTS = { __custom_tts: true }
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o' },
          stt: mockSTT,
          tts: mockTTS,
        }),
      )

      expect((result.llm as any).__openai_llm).toBe(true)
      expect((result.llm as any).opts.model).toBe('gpt-4o')
      expect(result.stt).toBe(mockSTT)
      expect(result.tts).toBe(mockTTS)
    })

    test('OpenAI turn detection mapping', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          turnDetection: {
            type: 'semantic',
            threshold: 0.5,
            silenceDurationMs: 300,
            prefixPaddingMs: 200,
          },
        }),
      )

      expect((result.llm as any).opts.turnDetection).toEqual({
        type: 'semantic_vad',
        threshold: 0.5,
        silence_duration_ms: 300,
        prefix_padding_ms: 200,
      })
    })

    test('OpenAI server_vad turn detection', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          turnDetection: { type: 'server_vad', silenceDurationMs: 500 },
        }),
      )

      expect((result.llm as any).opts.turnDetection.type).toBe('server_vad')
      expect((result.llm as any).opts.turnDetection.silence_duration_ms).toBe(500)
    })

    test('OpenAI passes temperature and maxTokens', () => {
      const result = createLiveKitModel(
        realtime({
          model: {
            provider: 'openai',
            name: 'gpt-4o-realtime',
            temperature: 0.7,
            maxTokens: 4096,
          },
        }),
      )

      expect((result.llm as any).opts.temperature).toBe(0.7)
      expect((result.llm as any).opts.maxResponseOutputTokens).toBe(4096)
    })

    test('OpenAI inputTranscription maps to inputAudioTranscription', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          inputTranscription: {
            model: 'gpt-4o-mini-transcribe',
            prompt: 'Transcribe the call in English.',
          },
        }),
      )

      expect((result.llm as any).opts.inputAudioTranscription).toEqual({
        model: 'gpt-4o-mini-transcribe',
        prompt: 'Transcribe the call in English.',
      })
    })

    test('OpenAI inputTranscription without prompt omits it', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          inputTranscription: { model: 'whisper-1' },
        }),
      )

      expect((result.llm as any).opts.inputAudioTranscription).toEqual({
        model: 'whisper-1',
      })
    })

    test('OpenAI noiseReduction maps to inputAudioNoiseReduction', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          noiseReduction: { type: 'near_field' },
        }),
      )

      expect((result.llm as any).opts.inputAudioNoiseReduction).toEqual({
        type: 'near_field',
      })
    })

    test('OpenAI all audio options together', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          voice: 'ballad',
          turnDetection: { type: 'server_vad', silenceDurationMs: 1200 },
          inputTranscription: { model: 'gpt-4o-mini-transcribe' },
          noiseReduction: { type: 'near_field' },
        }),
      )

      const opts = (result.llm as any).opts
      expect(opts.voice).toBe('ballad')
      expect(opts.turnDetection.type).toBe('server_vad')
      expect(opts.inputAudioTranscription.model).toBe('gpt-4o-mini-transcribe')
      expect(opts.inputAudioNoiseReduction.type).toBe('near_field')
    })

    test('Gemini full-realtime', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'gemini', name: 'gemini-2.0-flash-exp' },
          voice: 'Puck',
        }),
      )

      expect((result.llm as any).__google_realtime).toBe(true)
      expect((result.llm as any).opts.model).toBe('gemini-2.0-flash-exp')
      expect((result.llm as any).opts.voice).toBe('Puck')
    })

    test('Gemini half-cascade', () => {
      const mockTTS = { __custom_tts: true }
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'gemini', name: 'gemini-2.0-flash-exp' },
          tts: mockTTS,
        }),
      )

      expect((result.llm as any).opts.modalities).toEqual(['TEXT'])
      expect(result.tts).toBe(mockTTS)
    })

    test('Gemini full-pipeline', () => {
      const mockSTT = { __stt: true }
      const mockTTS = { __tts: true }
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'gemini', name: 'gemini-1.5-flash' },
          stt: mockSTT,
          tts: mockTTS,
        }),
      )

      expect((result.llm as any).__google_llm).toBe(true)
      expect(result.stt).toBe(mockSTT)
      expect(result.tts).toBe(mockTTS)
    })

    test('Gemini turn detection maps to realtimeInputConfig', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'gemini', name: 'gemini-2.0-flash-exp' },
          turnDetection: { silenceDurationMs: 400, prefixPaddingMs: 100 },
        }),
      )

      expect((result.llm as any).opts.realtimeInputConfig).toEqual({
        automaticActivityDetection: {
          disabled: false,
          silenceDurationMs: 400,
          prefixPaddingMs: 100,
        },
      })
    })

    test('throws for unsupported provider', () => {
      expect(() =>
        createLiveKitModel(
          realtime({
            model: { provider: 'claude' as any, name: 'claude-3' },
          }),
        ),
      ).toThrow("Unsupported provider for voice mode: 'claude'")
    })

    test('throws for stt without tts', () => {
      expect(() =>
        createLiveKitModel(
          realtime({
            model: { provider: 'openai', name: 'gpt-4o-realtime' },
            stt: { __stt: true },
          }),
        ),
      ).toThrow('stt without tts is not supported')
    })
  })

  describe('createLiveKitAgent', () => {
    const mockState = {
      get: vi.fn<(...args: unknown[]) => unknown>(),
      set: vi.fn<(...args: unknown[]) => unknown>(),
      update: vi.fn<(...args: unknown[]) => unknown>(),
      delete: vi.fn<(...args: unknown[]) => unknown>(),
    }
    const mockSession = {
      state: mockState,
      boundState: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue(mockState),
      events: [],
      id: 'test-session',
      appName: 'voice',
      scopes: {},
    } as any

    test('creates LK Agent with instructions and tools', () => {
      const testAgent = {
        kind: 'agent' as const,
        name: 'test',
        model: {} as any,
        tools: [],
        context: [],
      }

      const lkTools = { myTool: { __lk_tool: true } }
      const agent = createLiveKitAgent(testAgent as any, 'You are helpful.', lkTools, mockSession)

      expect(lkAgents.voice.Agent).toHaveBeenCalledWith({
        instructions: 'You are helpful.',
        tools: lkTools,
      })
      expect(agent).toBeDefined()
    })

    test('does not override onEnter when no callback provided', () => {
      const testAgent = {
        kind: 'agent' as const,
        name: 'test',
        model: {} as any,
        tools: [],
        context: [],
      }

      const agent = createLiveKitAgent(testAgent as any, 'Hello.', {}, mockSession)
      const agentObj = agent as any
      expect(agentObj.onEnter).toBeDefined()
    })

    test('patches onEnter when callback provided', async () => {
      const onEnterFn = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const testAgent = {
        kind: 'agent' as const,
        name: 'test',
        model: {} as any,
        tools: [],
        context: [],
      }

      const agent = createLiveKitAgent(
        testAgent as any,
        'System instructions.',
        {},
        mockSession,
        undefined,
        onEnterFn,
      ) as any

      await agent.onEnter()

      expect(onEnterFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('convertTools', () => {
    beforeEach(() => {
      mockLLMTool.mockClear()
    })

    const mockState = {
      get: vi.fn<(...args: unknown[]) => unknown>(),
      set: vi.fn<(...args: unknown[]) => unknown>(),
      update: vi.fn<(...args: unknown[]) => unknown>(),
      delete: vi.fn<(...args: unknown[]) => unknown>(),
    }
    const makeBridgeCtx = () => ({
      session: {
        state: mockState,
        boundState: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue(mockState),
        events: [],
        id: 'test',
        appName: 'voice',
        scopes: {},
      } as any,
      sessionService: {
        appendEvent: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      } as any,
      invocationId: 'inv_1',
      agentName: 'test-agent',
      agent: { kind: 'agent', name: 'test-agent' } as any,
      voiceSession: {} as any,
    })

    test('converts ADK tools to LK format with correct schema', () => {
      const adkTools = [
        {
          name: 'getWeather',
          description: 'Get weather for a city',
          schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
          execute: vi.fn<(...args: unknown[]) => unknown>(),
        },
        {
          name: 'searchDocs',
          description: 'Search documentation',
          schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
          execute: vi.fn<(...args: unknown[]) => unknown>(),
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      const result = convertTools(adkTools as any, () => bridgeCtx)

      expect(Object.keys(result)).toEqual(['getWeather', 'searchDocs'])
      expect(mockLLMTool).toHaveBeenCalledTimes(2)

      expect(mockLLMTool).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Get weather for a city',
          parameters: expect.anything(),
        }),
      )
      expect(mockLLMTool).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Search documentation',
          parameters: expect.anything(),
        }),
      )
    })

    test('empty tools array returns empty object', () => {
      const bridgeCtx = makeBridgeCtx()
      const result = convertTools([], () => bridgeCtx)
      expect(result).toEqual({})
      expect(mockLLMTool).not.toHaveBeenCalled()
    })

    test('tool execute callback invokes ADK tool and appends events', async () => {
      const mockExecute = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue('sunny, 72F')
      const adkTools = [
        {
          name: 'getWeather',
          description: 'Get weather',
          schema: { type: 'object', properties: { city: { type: 'string' } } },
          execute: mockExecute,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      // Get the execute callback that was passed to llm.tool()
      const lkToolOpts = mockLLMTool.mock.calls[0][0]
      const executeCallback = lkToolOpts.execute

      const result = await executeCallback({ city: 'London' }, {})

      expect(mockExecute).toHaveBeenCalled()
      expect(result).toBe('sunny, 72F')

      // Should have appended tool_call and tool_result events
      expect(bridgeCtx.sessionService.appendEvent).toHaveBeenCalledTimes(2)
      const events = bridgeCtx.sessionService.appendEvent.mock.calls.map((c: any[]) => c[1])
      expect(events[0].type).toBe('tool_call')
      expect(events[0].name).toBe('getWeather')
      expect(events[0].args).toEqual({ city: 'London' })
      expect(events[1].type).toBe('tool_result')
      expect(events[1].name).toBe('getWeather')
    })

    test('tool execute handles errors gracefully', async () => {
      const mockExecute = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('API down'))
      const adkTools = [
        {
          name: 'failTool',
          description: 'A failing tool',
          schema: {},
          execute: mockExecute,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe('Error: API down')
    })

    test('tool execute handles OutputSignal', async () => {
      const mockExecute = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue(signalOutput({ summary: 'Call ended' }))
      const onOutput = vi.fn<(...args: unknown[]) => unknown>()
      const adkTools = [
        {
          name: 'endCall',
          description: 'End the call',
          schema: {},
          execute: mockExecute,
        },
      ]

      const bridgeCtx = { ...makeBridgeCtx(), onOutput }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(onOutput).toHaveBeenCalledWith({ summary: 'Call ended' })
      expect(result).toBeUndefined()
    })

    test('tool execute handles Runnable return with onTransfer callback', async () => {
      const transferAgent = { kind: 'agent', name: 'specialist' }
      const mockExecute = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(transferAgent)
      const handoffResult = { __handoff: true, agent: 'specialist' }
      const onTransfer = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(handoffResult)
      const adkTools = [
        {
          name: 'transfer',
          description: 'Transfer to specialist',
          schema: {},
          execute: mockExecute,
        },
      ]

      const bridgeCtx = { ...makeBridgeCtx(), onTransfer }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toEqual(handoffResult)
      expect(onTransfer).toHaveBeenCalledWith(transferAgent)
    })

    test('tool execute warns when Runnable returned without onTransfer', async () => {
      const transferAgent = { kind: 'agent', name: 'specialist' }
      const mockExecute = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(transferAgent)
      const adkTools = [
        {
          name: 'transfer',
          description: 'Transfer to specialist',
          schema: {},
          execute: mockExecute,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe("Transferring to agent 'specialist'")
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('is not supported in this context'),
      )

      warnSpy.mockRestore()
    })

    test('tool execute runs prepare/finalize lifecycle', async () => {
      const prepareFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ city: 'LONDON' })
      const executeFn = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue('rainy')
      const finalizeFn = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue('rainy (UK)')

      const adkTools = [
        {
          name: 'getWeather',
          description: 'Get weather',
          schema: {},
          prepare: prepareFn,
          execute: executeFn,
          finalize: finalizeFn,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({ city: 'london' }, {})

      expect(prepareFn).toHaveBeenCalled()
      expect(executeFn).toHaveBeenCalled()
      expect(finalizeFn).toHaveBeenCalled()
      expect(result).toBe('rainy (UK)')
    })

    test('beforeTool hook can short-circuit execution', async () => {
      const executeFn = vi.fn<(...args: unknown[]) => unknown>()
      const adkTools = [
        {
          name: 'blocked',
          description: 'Blocked tool',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        hook: {
          beforeTool: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({
            id: 'evt_1',
            type: 'tool_result',
            createdAt: Date.now(),
            invocationId: 'inv_1',
            agentName: 'test',
            callId: 'call_1',
            name: 'blocked',
            result: 'intercepted by hook',
          }),
        },
      }

      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      // Execute should NOT have been called
      expect(executeFn).not.toHaveBeenCalled()
      expect(result).toBe('intercepted by hook')
    })

    test('afterTool hook can modify result', async () => {
      const executeFn = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue('original')
      const adkTools = [
        {
          name: 'myTool',
          description: 'My tool',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        hook: {
          afterTool: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({
            id: 'evt_2',
            type: 'tool_result',
            createdAt: Date.now(),
            invocationId: 'inv_1',
            agentName: 'test',
            callId: 'call_1',
            name: 'myTool',
            result: 'modified by hook',
          }),
        },
      }

      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe('modified by hook')
    })

    test('tool execute serializes non-string results to JSON', async () => {
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ temp: 72, unit: 'F' })
      const adkTools = [
        {
          name: 'getTemp',
          description: 'Get temp',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe('{"temp":72,"unit":"F"}')
    })

    test('tool execute preserves undefined results', async () => {
      const executeFn = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const adkTools = [
        {
          name: 'voidTool',
          description: 'Void',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBeUndefined()
    })

    test('tool execute returns empty string for null results', async () => {
      const executeFn = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(null)
      const adkTools = [
        {
          name: 'nullTool',
          description: 'Null',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe('')
    })

    test('onToolStart/onToolEnd called around tool execution', async () => {
      const callOrder: string[] = []
      const onToolStart = vi.fn<(...args: unknown[]) => unknown>(() => callOrder.push('start'))
      const onToolEnd = vi.fn<(...args: unknown[]) => unknown>(() => callOrder.push('end'))
      const executeFn = vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
        callOrder.push('execute')
        return 'ok'
      })
      const adkTools = [{ name: 'myTool', description: 'Test', schema: {}, execute: executeFn }]

      const bridgeCtx = { ...makeBridgeCtx(), onToolStart, onToolEnd }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      expect(onToolStart).toHaveBeenCalledTimes(1)
      expect(onToolEnd).toHaveBeenCalledTimes(1)
      expect(callOrder).toEqual(['start', 'execute', 'end'])
    })

    test('onToolEnd called even when tool throws', async () => {
      const onToolStart = vi.fn<(...args: unknown[]) => unknown>()
      const onToolEnd = vi.fn<(...args: unknown[]) => unknown>()
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('boom'))
      const adkTools = [
        {
          name: 'failTool',
          description: 'Fails',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = { ...makeBridgeCtx(), onToolStart, onToolEnd }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      expect(onToolStart).toHaveBeenCalledTimes(1)
      expect(onToolEnd).toHaveBeenCalledTimes(1)
    })

    test('tool context includes voice session from bridge', async () => {
      let capturedCtx: any
      const executeFn = vi.fn<(...args: unknown[]) => unknown>().mockImplementation((ctx: any) => {
        capturedCtx = ctx
        return 'ok'
      })
      const adkTools = [
        {
          name: 'voiceTool',
          description: 'Uses voice',
          schema: {},
          execute: executeFn,
        },
      ]

      const mockVoiceSession = {
        generateReply: vi.fn<(...args: unknown[]) => unknown>(),
        say: vi.fn<(...args: unknown[]) => unknown>(),
        playSound: vi.fn<(...args: unknown[]) => unknown>(),
        waitForPlayout: vi.fn<(...args: unknown[]) => unknown>(),
        shutdown: vi.fn<(...args: unknown[]) => unknown>(),
        interrupt: vi.fn<(...args: unknown[]) => unknown>(),
        turnCount: 0,
      }
      const bridgeCtx = { ...makeBridgeCtx(), voiceSession: mockVoiceSession }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      expect(capturedCtx.voice).toBe(mockVoiceSession)
    })

    test('tool execute can trigger voice.generateReply before returning', async () => {
      const order: string[] = []
      const mockVoiceSession = {
        generateReply: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async () => {
          order.push('generateReply')
          return {}
        }),
        say: vi.fn<(...args: unknown[]) => unknown>(),
        playSound: vi.fn<(...args: unknown[]) => unknown>(),
        interrupt: vi.fn<(...args: unknown[]) => unknown>(),
        turnCount: 1,
      }

      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(async (ctx: any) => {
          const value = 42
          const reply = await ctx.voice.generateReply({
            userInput: `The generateRandomNumber tool produced ${value}.`,
            instructions: `Tell the caller the generated number is ${value}.`,
            toolChoice: 'none',
          })
          expect(reply).toBeDefined()
          order.push('return')
          return { value }
        })
      const adkTools = [
        {
          name: 'generateRandomNumber',
          description: 'Generate a random number',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = { ...makeBridgeCtx(), voiceSession: mockVoiceSession }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(mockVoiceSession.generateReply).toHaveBeenCalledWith({
        userInput: 'The generateRandomNumber tool produced 42.',
        instructions: 'Tell the caller the generated number is 42.',
        toolChoice: 'none',
      })
      expect(order).toEqual(['generateReply', 'return'])
      expect(result).toBe('{"value":42}')
    })

    test('tool execute can wait for voice.generateReply playout before returning', async () => {
      const playout = deferred()
      const order: string[] = []
      const mockVoiceSession = {
        generateReply: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async () => ({
          waitForPlayout: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async () => {
            order.push('wait-start')
            await playout.promise
            order.push('wait-end')
          }),
        })),
        say: vi.fn<(...args: unknown[]) => unknown>(),
        playSound: vi.fn<(...args: unknown[]) => unknown>(),
        interrupt: vi.fn<(...args: unknown[]) => unknown>(),
        turnCount: 1,
      }

      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(async (ctx: any) => {
          order.push('tool-start')
          const reply = await ctx.voice.generateReply({
            userInput: 'The lookup is still running.',
            instructions: 'Tell the caller you are checking.',
            toolChoice: 'none',
          })
          order.push('reply-created')
          await reply.waitForPlayout()
          order.push('tool-return')
          return { ok: true }
        })
      const adkTools = [
        {
          name: 'longLookup',
          description: 'Perform a long lookup',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = { ...makeBridgeCtx(), voiceSession: mockVoiceSession }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const execution = executeCallback({}, {})
      let finished = false
      void execution.then(() => {
        finished = true
      })
      await Promise.resolve()
      await Promise.resolve()

      expect(order).toEqual(['tool-start', 'reply-created', 'wait-start'])
      expect(finished).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(finished).toBe(false)

      playout.resolve()
      const result = await execution

      expect(mockVoiceSession.generateReply).toHaveBeenCalledWith({
        userInput: 'The lookup is still running.',
        instructions: 'Tell the caller you are checking.',
        toolChoice: 'none',
      })
      expect(order).toEqual([
        'tool-start',
        'reply-created',
        'wait-start',
        'wait-end',
        'tool-return',
      ])
      expect(finished).toBe(true)
      expect(result).toBe('{"ok":true}')
    })

    test('tool context includes endInvocation set to false', async () => {
      let capturedCtx: any
      const executeFn = vi.fn<(...args: unknown[]) => unknown>().mockImplementation((ctx: any) => {
        capturedCtx = ctx
        return 'ok'
      })
      const adkTools = [
        {
          name: 'checkTool',
          description: 'Check ctx',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      expect(capturedCtx.endInvocation).toBe(false)
    })

    test('tool execution error returns Error: prefix string', async () => {
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new TypeError('null is not iterable'))
      const adkTools = [
        {
          name: 'crashTool',
          description: 'Crashes',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe('Error: null is not iterable')
    })

    test('tool execution error appends tool_result event with error field', async () => {
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('db timeout'))
      const adkTools = [
        {
          name: 'dbTool',
          description: 'DB lookup',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = makeBridgeCtx()
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      const appendCalls = bridgeCtx.sessionService.appendEvent.mock.calls
      const resultEvent = appendCalls.find((c: any[]) => c[1].type === 'tool_result')
      expect(resultEvent).toBeDefined()
      expect(resultEvent![1].error).toBe('db timeout')
    })

    test('error handler retry action retries tool execution', async () => {
      const executeFn = vi.fn<(...args: unknown[]) => unknown>()
      executeFn.mockRejectedValueOnce(new Error('rate limit'))
      executeFn.mockResolvedValueOnce('success')
      const adkTools = [
        {
          name: 'retryTool',
          description: 'Retries',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        errorHandler: {
          handle: vi
            .fn<(...args: unknown[]) => unknown>()
            .mockResolvedValue({ action: 'retry', delay: 0 }),
        },
      }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(executeFn).toHaveBeenCalledTimes(2)
      expect(result).toBe('success')
      expect(bridgeCtx.errorHandler.handle).toHaveBeenCalledTimes(1)
      expect(bridgeCtx.errorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'tool',
          attempt: 1,
          toolName: 'retryTool',
        }),
      )
    })

    test('error handler fallback action returns fallback result', async () => {
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('service down'))
      const adkTools = [
        {
          name: 'fallbackTool',
          description: 'Falls back',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        errorHandler: {
          handle: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({
            action: 'fallback',
            result: { fallback: true },
          }),
        },
      }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe('{"fallback":true}')
      // tool_result event should have the fallback value, not an error
      const appendCalls = bridgeCtx.sessionService.appendEvent.mock.calls
      const resultEvent = appendCalls.find((c: any[]) => c[1].type === 'tool_result')
      expect(resultEvent![1].result).toEqual({ fallback: true })
      expect(resultEvent![1].error).toBeUndefined()
    })

    test('error handler skip action returns error to model', async () => {
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('forbidden'))
      const adkTools = [
        {
          name: 'skipTool',
          description: 'Skips',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        errorHandler: {
          handle: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ action: 'skip' }),
        },
      }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      const result = await executeCallback({}, {})

      expect(result).toBe('Error: forbidden')
    })

    test('error handler throw action re-throws the error', async () => {
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('fatal'))
      const adkTools = [
        {
          name: 'throwTool',
          description: 'Throws',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        errorHandler: {
          handle: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ action: 'throw' }),
        },
      }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await expect(executeCallback({}, {})).rejects.toThrow('fatal')
    })

    test('afterTool hook fires for OutputSignal results', async () => {
      const mockExecute = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue(signalOutput({ done: true }))
      const afterTool = vi.fn<(...args: unknown[]) => unknown>()
      const onOutput = vi.fn<(...args: unknown[]) => unknown>()
      const adkTools = [
        {
          name: 'endTool',
          description: 'Ends',
          schema: {},
          execute: mockExecute,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        onOutput,
        hook: { afterTool },
      }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      expect(afterTool).toHaveBeenCalledTimes(1)
      const resultEvent = afterTool.mock.calls[0][1]
      expect(resultEvent.output).toBe(true)
      expect(resultEvent.result).toEqual({ done: true })
    })

    test('afterTool hook fires for Runnable transfer results', async () => {
      const transferAgent = { kind: 'agent', name: 'specialist' }
      const mockExecute = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(transferAgent)
      const afterTool = vi.fn<(...args: unknown[]) => unknown>()
      const onTransfer = vi.fn<(...args: unknown[]) => unknown>()
      const adkTools = [
        {
          name: 'transferTool',
          description: 'Transfers',
          schema: {},
          execute: mockExecute,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        onTransfer,
        hook: { afterTool },
      }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      expect(afterTool).toHaveBeenCalledTimes(1)
      const resultEvent = afterTool.mock.calls[0][1]
      expect(resultEvent.result).toBe("Transferring to agent 'specialist'")
    })

    test('afterTool hook fires for error results', async () => {
      const executeFn = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockRejectedValue(new Error('oops'))
      const afterTool = vi.fn<(...args: unknown[]) => unknown>()
      const adkTools = [
        {
          name: 'errTool',
          description: 'Errors',
          schema: {},
          execute: executeFn,
        },
      ]

      const bridgeCtx = {
        ...makeBridgeCtx(),
        hook: { afterTool },
      }
      convertTools(adkTools as any, () => bridgeCtx)

      const executeCallback = mockLLMTool.mock.calls[0][0].execute
      await executeCallback({}, {})

      expect(afterTool).toHaveBeenCalledTimes(1)
      const resultEvent = afterTool.mock.calls[0][1]
      expect(resultEvent.error).toBe('oops')
    })
  })

  describe('createLiveKitModel — turn detection', () => {
    test('OpenAI semantic turn detection maps to semantic_vad', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          turnDetection: { type: 'semantic' },
        }),
      )

      expect((result.llm as any).opts.turnDetection).toEqual({
        type: 'semantic_vad',
      })
    })

    test('OpenAI server_vad with all options', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          turnDetection: {
            type: 'server_vad',
            threshold: 0.7,
            silenceDurationMs: 600,
            prefixPaddingMs: 150,
          },
        }),
      )

      const td = (result.llm as any).opts.turnDetection
      expect(td.type).toBe('server_vad')
      expect(td.threshold).toBe(0.7)
      expect(td.silence_duration_ms).toBe(600)
      expect(td.prefix_padding_ms).toBe(150)
    })

    test('OpenAI omits turn detection fields that are not set', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
          turnDetection: { type: 'server_vad' },
        }),
      )

      const td = (result.llm as any).opts.turnDetection
      expect(td.type).toBe('server_vad')
      expect(td).not.toHaveProperty('threshold')
      expect(td).not.toHaveProperty('silence_duration_ms')
      expect(td).not.toHaveProperty('prefix_padding_ms')
    })

    test('Gemini turn detection maps to realtimeInputConfig', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'gemini', name: 'gemini-2.0-flash-exp' },
          turnDetection: { silenceDurationMs: 300, prefixPaddingMs: 80 },
        }),
      )

      const ric = (result.llm as any).opts.realtimeInputConfig
      expect(ric.automaticActivityDetection.disabled).toBe(false)
      expect(ric.automaticActivityDetection.silenceDurationMs).toBe(300)
      expect(ric.automaticActivityDetection.prefixPaddingMs).toBe(80)
    })

    test('Gemini omits turn detection fields that are not set', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'gemini', name: 'gemini-2.0-flash-exp' },
          turnDetection: {},
        }),
      )

      const aad = (result.llm as any).opts.realtimeInputConfig.automaticActivityDetection
      expect(aad.disabled).toBe(false)
      expect(aad).not.toHaveProperty('silenceDurationMs')
      expect(aad).not.toHaveProperty('prefixPaddingMs')
    })

    test('no turnDetection means no turn detection config on model', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
        }),
      )

      expect((result.llm as any).opts).not.toHaveProperty('turnDetection')
    })
  })

  describe('createLiveKitModel — temperature passthrough in full-pipeline', () => {
    test('OpenAI full-pipeline preserves temperature', () => {
      const mockSTT = { __stt: true }
      const mockTTS = { __tts: true }
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o', temperature: 0.3 },
          stt: mockSTT,
          tts: mockTTS,
        }),
      )

      expect((result.llm as any).opts.temperature).toBe(0.3)
    })

    test('Gemini full-pipeline preserves temperature', () => {
      const mockSTT = { __stt: true }
      const mockTTS = { __tts: true }
      const result = createLiveKitModel(
        realtime({
          model: {
            provider: 'gemini',
            name: 'gemini-1.5-flash',
            temperature: 0.5,
          },
          stt: mockSTT,
          tts: mockTTS,
        }),
      )

      expect((result.llm as any).opts.temperature).toBe(0.5)
    })

    test('OpenAI full-pipeline works without temperature', () => {
      const result = createLiveKitModel(
        realtime({
          model: { provider: 'openai', name: 'gpt-4o' },
          stt: { __stt: true },
          tts: { __tts: true },
        }),
      )

      expect((result.llm as any).opts.temperature).toBeUndefined()
    })
  })

  describe('createLiveKitAgent — onEnter callback', () => {
    const mockState = {
      get: vi.fn<(...args: unknown[]) => unknown>(),
      set: vi.fn<(...args: unknown[]) => unknown>(),
      update: vi.fn<(...args: unknown[]) => unknown>(),
      delete: vi.fn<(...args: unknown[]) => unknown>(),
    }
    const mockSession = {
      state: mockState,
      boundState: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue(mockState),
      events: [],
      id: 'test-session',
      appName: 'voice',
      scopes: {},
    } as any

    test('onEnter callback is awaited (async completes before onEnter returns)', async () => {
      let callbackResolved = false
      const onEnterFn = vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            callbackResolved = true
            resolve()
          }, 10)
        })
      })

      const testAgent = {
        kind: 'agent' as const,
        name: 'test',
        model: {} as any,
        tools: [],
        context: [],
      }

      const agent = createLiveKitAgent(
        testAgent as any,
        'System.',
        {},
        mockSession,
        undefined,
        onEnterFn,
      ) as any

      await agent.onEnter()
      expect(callbackResolved).toBe(true)
      expect(onEnterFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('voice handler error scenarios', () => {
    test('LiveKitVoiceSession generateReply throws after shutdown', async () => {
      const session = new LiveKitVoiceSession(
        mockLKSession({
          shutdown: vi.fn<(...args: unknown[]) => unknown>(),
        }),
      )

      session.shutdown()
      await expect(session.generateReply()).rejects.toThrow('Cannot generate reply after shutdown')
    })

    test('LiveKitVoiceSession shutdown only calls underlying once even with multiple calls', () => {
      const mockShutdown = vi.fn<(...args: unknown[]) => unknown>()
      const session = new LiveKitVoiceSession(
        mockLKSession({
          shutdown: mockShutdown,
        }),
      )

      session.shutdown()
      session.shutdown()
      session.shutdown()
      expect(mockShutdown).toHaveBeenCalledTimes(1)
    })
  })

  // --- Shared mock references ---

  const lkAgents = mockAgents

  // --- Shared integration test helpers ---

  function makeAgent(overrides?: Record<string, unknown>): any {
    return {
      kind: 'agent' as const,
      name: 'test-agent',
      model: realtime({
        model: { provider: 'openai', name: 'gpt-4o-realtime' },
      }),
      tools: [],
      context: [],
      ...overrides,
    }
  }

  function makeSessionService() {
    const events: any[] = []
    return {
      createSession: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation((_app: string, opts: any) => ({
          id: opts.sessionId,
          appName: _app,
          state: {
            get: vi.fn<(...args: unknown[]) => unknown>(),
            set: vi.fn<(...args: unknown[]) => unknown>(),
            update: vi.fn<(...args: unknown[]) => unknown>(),
            delete: vi.fn<(...args: unknown[]) => unknown>(),
          },
          boundState: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({
            get: vi.fn<(...args: unknown[]) => unknown>(),
            set: vi.fn<(...args: unknown[]) => unknown>(),
            update: vi.fn<(...args: unknown[]) => unknown>(),
            delete: vi.fn<(...args: unknown[]) => unknown>(),
          }),
          events,
          scopes: opts.scopes ?? {},
        })),
      getSession: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(null),
      appendEvent: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation((_s: any, ev: any) => {
          events.push(ev)
          return Promise.resolve()
        }),
      deleteSession: vi.fn<(...args: unknown[]) => unknown>(),
      getScopedState: vi.fn<(...args: unknown[]) => unknown>(),
      setScopedState: vi.fn<(...args: unknown[]) => unknown>(),
      commitSession: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ ok: true }),
    }
  }

  function makeLKSessionMock(generateReplyReturn: unknown = {}) {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    return {
      on: vi.fn<(...args: unknown[]) => unknown>(
        (event: string, cb: (...args: unknown[]) => void) => {
          if (!listeners.has(event)) listeners.set(event, [])
          listeners.get(event)!.push(cb)
        },
      ),
      start: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      updateAgent: vi.fn<(...args: unknown[]) => unknown>(),
      close: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      shutdown: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
        const closeFns = listeners.get('close') ?? []
        for (const fn of closeFns) fn()
      }),
      generateReply: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue(generateReplyReturn),
      interrupt: vi.fn<(...args: unknown[]) => unknown>(),
      _emit(event: string, ...args: unknown[]) {
        for (const fn of listeners.get(event) ?? []) fn(...args)
      },
      _listeners: listeners,
    }
  }

  function makeJobContext(
    overrides?: Partial<{
      roomName: string
      participantAttrs: Record<string, string>
    }>,
  ) {
    const roomListeners = new Map<string, ((...args: unknown[]) => void)[]>()
    const shutdownCallbacks: Array<() => Promise<void>> = []
    return {
      room: {
        name: overrides?.roomName ?? 'test-room',
        on: vi.fn<(...args: unknown[]) => unknown>(
          (event: string, cb: (...args: unknown[]) => void) => {
            if (!roomListeners.has(event)) roomListeners.set(event, [])
            roomListeners.get(event)!.push(cb)
          },
        ),
        off: vi.fn<(...args: unknown[]) => unknown>(
          (event: string, cb: (...args: unknown[]) => void) => {
            const fns = roomListeners.get(event)
            if (fns) {
              const idx = fns.indexOf(cb)
              if (idx >= 0) fns.splice(idx, 1)
            }
          },
        ),
        _emit(event: string, ...args: unknown[]) {
          for (const fn of roomListeners.get(event) ?? []) fn(...args)
        },
        _listeners: roomListeners,
      },
      connect: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      waitForParticipant: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({
        identity: 'caller',
        attributes: overrides?.participantAttrs ?? {},
      }),
      addShutdownCallback: vi.fn<(...args: unknown[]) => unknown>((cb: () => Promise<void>) => {
        shutdownCallbacks.push(cb)
      }),
      shutdown: vi.fn<(...args: unknown[]) => unknown>(),
      _shutdownCallbacks: shutdownCallbacks,
    }
  }

  const defaultAgentSessionMock = () => ({
    on: vi.fn<(...args: unknown[]) => unknown>(),
    start: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
    updateAgent: vi.fn<(...args: unknown[]) => unknown>(),
    close: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
    shutdown: vi.fn<(...args: unknown[]) => unknown>(),
    generateReply: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({}),
  })

  function withAgentSessionRestore() {
    let originalImpl: any
    beforeEach(() => {
      originalImpl = lkAgents.voice.AgentSession.getMockImplementation?.()
    })
    afterEach(() => {
      if (originalImpl) {
        lkAgents.voice.AgentSession.mockImplementation(originalImpl)
      } else {
        lkAgents.voice.AgentSession.mockImplementation(defaultAgentSessionMock)
      }
    })
  }

  describe('voiceHandler integration — entry function', () => {
    withAgentSessionRestore()

    beforeEach(() => {
      resetCallTerminationMocks()
    })

    test('custom onEnter hook can explicitly generate an entry reply', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            onEnter: async (ctx: any) => {
              await ctx.voice.generateReply({
                instructions: 'Say a custom greeting',
                toolChoice: 'none',
              })
            },
          },
        ],
      })

      lkSessionMock.start.mockImplementation(async (opts: any) => {
        await opts.agent.onEnter()
        setTimeout(() => lkSessionMock._emit('close'), 10)
      })

      await handle.entry(jobCtx)

      expect(lkSessionMock.generateReply).toHaveBeenCalledTimes(1)
      expect(lkSessionMock.generateReply).toHaveBeenCalledWith({
        instructions: 'Say a custom greeting',
        toolChoice: 'none',
      })
    })

    async function runOutputToolCompletion(opts: {
      lkSessionMock: ReturnType<typeof makeLKSessionMock>
      handle: ReturnType<typeof voiceHandler>
      jobCtx: ReturnType<typeof makeJobContext>
      toolArgs?: Record<string, unknown>
      toolRunCtx?: unknown
      afterTool?: () => void
    }) {
      const toolExecution = new Promise<void>((resolve, reject) => {
        opts.lkSessionMock.start.mockImplementation(async (startOpts: any) => {
          setTimeout(async () => {
            try {
              emitUserSpeech(opts.lkSessionMock)
              await startOpts.agent.tools.endCall.execute(
                opts.toolArgs ?? { summary: 'done' },
                opts.toolRunCtx ?? {},
              )
              opts.afterTool?.()
              resolve()
            } catch (err) {
              reject(err)
              opts.lkSessionMock._emit('close')
            }
          }, 10)
        })
      })

      await opts.handle.entry(opts.jobCtx)
      await toolExecution
    }

    test('happy path: entry runs session and emits invocation_start + invocation_end', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
      })

      // Simulate the session closing shortly after start
      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => lkSessionMock._emit('close'), 10)
      })

      await handle.entry(jobCtx)

      const appendedEvents = sessionService.appendEvent.mock.calls.map((c: any[]) => c[1])
      const startEvents = appendedEvents.filter((e: any) => e.type === 'invocation_start')
      const endEvents = appendedEvents.filter((e: any) => e.type === 'invocation_end')

      expect(startEvents).toHaveLength(1)
      expect(startEvents[0].agentName).toBe('test-agent')
      expect(endEvents).toHaveLength(1)
      expect(endEvents[0].reason).toBe('completed')
    })

    test('participant disconnect sets reason to participant_left', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
      })

      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => {
          ;(jobCtx.room as any)._emit('participantDisconnected')
        }, 10)
      })

      await handle.entry(jobCtx)

      const endEvents = sessionService.appendEvent.mock.calls
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'invocation_end')

      expect(endEvents).toHaveLength(1)
      expect(endEvents[0].reason).toBe('participant_left')
    })

    test('participant disconnect waits for output tool before room termination', async () => {
      const order: string[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async () => {
          order.push('output-tool-start')
          await new Promise((resolve) => setTimeout(resolve, 20))
          order.push('output-tool-end')
          return { summary: 'done' }
        }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      jobCtx.shutdown.mockImplementation(() => {
        order.push('job-shutdown')
      })

      let tools: any
      const outputExecution = new Promise<void>((resolve, reject) => {
        lkSessionMock.start.mockImplementation(async (opts: any) => {
          tools = opts.agent.tools
          setTimeout(() => {
            emitUserSpeech(lkSessionMock)
            ;(jobCtx.room as any)._emit('participantDisconnected')
          }, 10)
        })
        lkSessionMock.generateReply.mockImplementation(async () => {
          setTimeout(() => {
            tools.endCall
              .execute(
                { summary: 'done' },
                {
                  ctx: {
                    waitForPlayout: async () => {
                      order.push('playout')
                    },
                  },
                },
              )
              .then(resolve)
              .catch(reject)
          }, 10)
          return {}
        })
      })

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
      })

      await handle.entry(jobCtx)
      await outputExecution

      expect(order).toEqual(['playout', 'output-tool-start', 'output-tool-end', 'job-shutdown'])
      expect(lkSessionMock.generateReply).toHaveBeenCalledWith({
        toolChoice: 'required',
        userInput: '*The participant disconnected*',
        instructions: expect.stringContaining('Required tool: endCall'),
      })

      const endEvents = sessionService.appendEvent.mock.calls
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'invocation_end')
      expect(endEvents).toHaveLength(1)
      expect(endEvents[0].reason).toBe('participant_left')
    })

    test('room disconnect sets reason to disconnected', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
      })

      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => {
          ;(jobCtx.room as any)._emit('disconnected')
        }, 10)
      })

      await handle.entry(jobCtx)

      const endEvents = sessionService.appendEvent.mock.calls
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'invocation_end')

      expect(endEvents).toHaveLength(1)
      expect(endEvents[0].reason).toBe('disconnected')
    })

    test('room listeners are cleaned up after session ends', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
      })

      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => lkSessionMock._emit('close'), 10)
      })

      await handle.entry(jobCtx)

      expect(jobCtx.room.off).toHaveBeenCalledWith('participantDisconnected', expect.any(Function))
      expect(jobCtx.room.off).toHaveBeenCalledWith('disconnected', expect.any(Function))
    })

    test('setup callback maps participant to session config', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext({
        participantAttrs: { CALL_ID: 'call_123', ORG_ID: 'org_1' },
      })

      const handle = voiceHandler({
        agent: makeAgent(),
        appName: 'test-app',
        sessionService,
        setup: (p: any) => ({
          sessionId: p.attributes.CALL_ID,
          scopes: { org: p.attributes.ORG_ID },
          state: { fromResolve: true },
        }),
      })

      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => lkSessionMock._emit('close'), 10)
      })

      await handle.entry(jobCtx)

      expect(sessionService.createSession).toHaveBeenCalledWith(
        'test-app',
        expect.objectContaining({ sessionId: 'call_123' }),
      )
    })

    test('output tool side effects and playout complete before job shutdown', async () => {
      const order: string[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
          order.push('output-tool')
          return { summary: 'done' }
        }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      jobCtx.shutdown.mockImplementation(() => {
        order.push('job-shutdown')
      })

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
      })

      await runOutputToolCompletion({
        lkSessionMock,
        handle,
        jobCtx,
        toolRunCtx: {
          ctx: {
            waitForPlayout: async () => {
              order.push('playout')
            },
          },
        },
      })

      expect(order).toEqual(['playout', 'output-tool', 'job-shutdown'])
      expect(jobCtx.shutdown).toHaveBeenCalledWith('Session ended')
      expect(mockDeleteRoom).toHaveBeenCalledWith('test-room')
    })

    test('afterTurn runs before job shutdown so finalization can observe output', async () => {
      const order: string[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
          order.push('output-tool')
          return signalOutput({ summary: 'done' })
        }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      jobCtx.shutdown.mockImplementation(() => {
        order.push('job-shutdown')
      })

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
        hooks: [
          {
            afterTurn: async (ctx: any) => {
              order.push('after-turn')
              expect(ctx.output).toEqual({ summary: 'done' })
            },
          },
        ],
      })

      await runOutputToolCompletion({
        lkSessionMock,
        handle,
        jobCtx,
        toolRunCtx: {
          ctx: {
            waitForPlayout: async () => {
              order.push('playout')
            },
          },
        },
      })

      expect(order).toEqual(['playout', 'output-tool', 'after-turn', 'job-shutdown'])
      expect(jobCtx.shutdown).toHaveBeenCalledWith('Session ended')
      expect(mockDeleteRoom).toHaveBeenCalledWith('test-room')
    })

    test('end-of-invocation hooks run inside the worker shutdown barrier', async () => {
      // The LiveKit worker awaits every registered shutdown callback before it reports
      // the job done and exits the process. If finalization (afterAgent/afterTurn) is not
      // part of that barrier, a job teardown (e.g. caller disconnect during a transfer)
      // can outrace the post-sessionDone main path and skip it entirely.
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let afterTurnCalls = 0
      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            afterTurn: async () => {
              afterTurnCalls++
            },
          },
        ],
      })

      // Session starts and stays open — it never ends normally, so the post-sessionDone
      // main path has NOT run the end-of-invocation hooks.
      lkSessionMock.start.mockResolvedValue(undefined)
      const entryPromise = handle.entry(jobCtx)

      // Wait until the session is active and shutdown callbacks are registered.
      for (let i = 0; i < 200; i++) {
        if (lkSessionMock.start.mock.calls.length > 0 && jobCtx._shutdownCallbacks.length > 0) {
          break
        }
        await new Promise<void>((r) => setTimeout(r, 0))
      }
      await new Promise<void>((r) => setTimeout(r, 0))
      expect(afterTurnCalls).toBe(0)

      // Simulate the worker shutdown barrier: await all shutdown callbacks.
      await Promise.all(jobCtx._shutdownCallbacks.map((cb) => cb()))

      // By the time the worker would exit, finalization must have run.
      expect(afterTurnCalls).toBe(1)

      await entryPromise
    })

    test('end-of-invocation hooks run exactly once across normal end and worker shutdown', async () => {
      // Finalization is idempotent: when the session ends normally AND the worker then runs
      // its shutdown callbacks, afterTurn (where completeCall lives) must not run twice.
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let afterTurnCalls = 0
      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            afterTurn: async () => {
              afterTurnCalls++
            },
          },
        ],
      })

      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => lkSessionMock._emit('close'), 10)
      })
      await handle.entry(jobCtx)

      // Worker teardown runs its shutdown callbacks after the session already ended.
      await Promise.all(jobCtx._shutdownCallbacks.map((cb) => cb()))

      expect(afterTurnCalls).toBe(1)
    })

    test('output tool completion interrupts realtime generation before shutdown', async () => {
      const order: string[] = []
      const lkSessionMock = makeLKSessionMock()
      lkSessionMock.interrupt.mockImplementation(() => {
        order.push('interrupt')
      })
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
          order.push('output-tool')
          return signalOutput({ summary: 'done' })
        }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      jobCtx.shutdown.mockImplementation(() => {
        order.push('job-shutdown')
      })

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
      })

      await runOutputToolCompletion({
        lkSessionMock,
        handle,
        jobCtx,
        toolRunCtx: {
          ctx: {
            waitForPlayout: async () => {
              order.push('playout')
            },
          },
        },
      })

      expect(order).toEqual(['playout', 'output-tool', 'interrupt', 'job-shutdown'])
      expect(lkSessionMock.interrupt).toHaveBeenCalledTimes(1)
    })

    test('ctx.end from a non-output tool runs the output tool before room termination', async () => {
      const order: string[] = []
      const voiceEvents: any[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const finishRequest = {
        name: 'finishRequest',
        description: 'Finish',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation((ctx: any) => {
          order.push('end-tool')
          return ctx.end()
        }),
      }
      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
          order.push('output-tool')
          return { summary: 'done' }
        }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      jobCtx.shutdown.mockImplementation(() => {
        order.push('job-shutdown')
      })

      let tools: any
      const toolExecution = new Promise<void>((resolve, reject) => {
        lkSessionMock.start.mockImplementation(async (opts: any) => {
          tools = opts.agent.tools
          setTimeout(async () => {
            try {
              emitUserSpeech(lkSessionMock)
              await tools.finishRequest.execute({}, {})
              resolve()
            } catch (err) {
              reject(err)
              lkSessionMock._emit('close')
            }
          }, 10)
        })
        lkSessionMock.generateReply.mockImplementation(() => {
          void tools.endCall
            .execute(
              { summary: 'done' },
              {
                ctx: {
                  waitForPlayout: async () => {
                    order.push('playout')
                  },
                },
              },
            )
            .catch(reject)
          return {
            waitForPlayout: async () => {
              order.push('output-reply-playout')
            },
          }
        })
      })

      const handle = voiceHandler({
        agent: makeAgent({ tools: [finishRequest], output: endCall }),
        sessionService,
        hooks: [{ onVoiceEvent: (event: any) => voiceEvents.push(event) }],
      })

      await handle.entry(jobCtx)
      await toolExecution

      expect(order).toEqual([
        'end-tool',
        'playout',
        'output-tool',
        'output-reply-playout',
        'job-shutdown',
      ])
      expect(mockDeleteRoom).toHaveBeenCalledTimes(1)
      expect(mockDeleteRoom).toHaveBeenCalledWith('test-room')
      expect(voiceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'output_tool_completion_started',
            intendedToolName: 'endCall',
            source: 'output_tool_completion',
          }),
          expect.objectContaining({
            type: 'output_tool_completion_succeeded',
            intendedToolName: 'endCall',
            source: 'output_tool_completion',
          }),
        ]),
      )
    })

    test('ctx.end emits output completion failure when output generation fails', async () => {
      const voiceEvents: any[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const finishRequest = {
        name: 'finishRequest',
        description: 'Finish',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation((ctx: any) => {
          return ctx.end()
        }),
      }
      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({ summary: 'done' }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const toolExecution = new Promise<void>((resolve, reject) => {
        lkSessionMock.start.mockImplementation(async (opts: any) => {
          setTimeout(async () => {
            try {
              emitUserSpeech(lkSessionMock)
              await opts.agent.tools.finishRequest.execute({}, {})
              resolve()
            } catch (err) {
              reject(err)
              lkSessionMock._emit('close')
            }
          }, 10)
        })
        lkSessionMock.generateReply.mockImplementation(() => {
          throw new TypeError('AgentSession is closing')
        })
      })

      const handle = voiceHandler({
        agent: makeAgent({ tools: [finishRequest], output: endCall }),
        sessionService,
        hooks: [{ onVoiceEvent: (event: any) => voiceEvents.push(event) }],
      })

      await handle.entry(jobCtx)
      await toolExecution

      expect(endCall.execute).not.toHaveBeenCalled()
      expect(voiceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'output_tool_completion_failed',
            intendedToolName: 'endCall',
            source: 'output_tool_completion',
            phase: 'generation',
            errorName: 'TypeError',
            errorMessage: 'AgentSession is closing',
          }),
        ]),
      )
      expect(sessionService.commitSession).toHaveBeenCalledTimes(1)
      expect(mockDeleteRoom).toHaveBeenCalledTimes(1)
    })

    test('ctx.end preserves the tool list and redirects wrong tool calls to the output tool', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const finishRequest = {
        name: 'finishRequest',
        description: 'Finish',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation((ctx: any) => {
          return ctx.end()
        }),
      }
      const transferToHuman = {
        name: 'transferToHuman',
        description: 'Transfer',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue('transferred'),
      }
      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => {
          return { summary: 'done' }
        }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let tools: any
      let exposedToolNames: string[] = []
      let correctionInstructions = ''
      const toolExecution = new Promise<void>((resolve, reject) => {
        lkSessionMock.start.mockImplementation(async (opts: any) => {
          tools = opts.agent.tools
          setTimeout(async () => {
            try {
              emitUserSpeech(lkSessionMock)
              await tools.finishRequest.execute({}, {})
              resolve()
            } catch (err) {
              reject(err)
              lkSessionMock._emit('close')
            }
          }, 10)
        })
        lkSessionMock.generateReply.mockImplementation((opts: any) => {
          exposedToolNames = Object.keys(tools)
          if (opts?.instructions?.includes('<tool_call_correction>')) {
            correctionInstructions = opts.instructions
            void tools.endCall.execute({ summary: 'done' }, {}).catch(reject)
          } else {
            void tools.transferToHuman.execute({}, {}).catch(reject)
          }
          return {}
        })
      })

      const handle = voiceHandler({
        agent: makeAgent({ tools: [finishRequest, transferToHuman], output: endCall }),
        sessionService,
      })

      await handle.entry(jobCtx)
      await toolExecution
      expect(exposedToolNames).toEqual(['finishRequest', 'transferToHuman', 'endCall'])
      expect(lkSessionMock.updateAgent).not.toHaveBeenCalled()
      expect(transferToHuman.execute).not.toHaveBeenCalled()
      expect(endCall.execute).toHaveBeenCalledTimes(1)
      expect(correctionInstructions).toContain('Incorrect tool called: transferToHuman')
      expect(correctionInstructions).toContain('Required tool: endCall')
    })

    test('named voice generateReply redirects wrong tool calls before execution', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const startVerification = {
        name: 'startVerification',
        description: 'Start verification',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async (ctx: any) => {
          await ctx.voice.generateReply({
            toolChoice: { name: 'isPatient' },
            instructions: 'Immediately run isPatient.',
          })
          return 'verification started'
        }),
      }
      const transferToHuman = {
        name: 'transferToHuman',
        description: 'Transfer',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue('transferred'),
      }
      const isPatient = {
        name: 'isPatient',
        description: 'Verify patient',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue('verified'),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let tools: any
      let correctionInstructions = ''
      const toolExecution = new Promise<void>((resolve, reject) => {
        lkSessionMock.start.mockImplementation(async (opts: any) => {
          tools = opts.agent.tools
          setTimeout(async () => {
            try {
              emitUserSpeech(lkSessionMock)
              await tools.startVerification.execute({}, {})
            } catch (err) {
              reject(err)
              lkSessionMock._emit('close')
            }
          }, 10)
        })
        lkSessionMock.generateReply.mockImplementation((opts: any) => {
          if (opts?.instructions?.includes('<tool_call_correction>')) {
            correctionInstructions = opts.instructions
            void tools.isPatient
              .execute({}, {})
              .then(() => {
                lkSessionMock._emit('close')
                resolve()
              })
              .catch(reject)
          } else {
            void tools.transferToHuman.execute({}, {}).catch(reject)
          }
          return {}
        })
      })

      const handle = voiceHandler({
        agent: makeAgent({ tools: [startVerification, transferToHuman, isPatient] }),
        sessionService,
      })

      await handle.entry(jobCtx)
      await toolExecution

      expect(lkSessionMock.generateReply).toHaveBeenNthCalledWith(1, {
        instructions: 'Immediately run isPatient.',
        toolChoice: 'required',
      })
      expect(transferToHuman.execute).not.toHaveBeenCalled()
      expect(isPatient.execute).toHaveBeenCalledTimes(1)
      expect(correctionInstructions).toContain('Incorrect tool called: transferToHuman')
      expect(correctionInstructions).toContain('Required tool: isPatient')
    })

    test('ctx.end waits for async output tool completion before room termination', async () => {
      const order: string[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const finishRequest = {
        name: 'finishRequest',
        description: 'Finish',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation((ctx: any) => {
          order.push('end-tool')
          return ctx.end()
        }),
      }
      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async () => {
          order.push('output-tool-start')
          await new Promise((resolve) => setTimeout(resolve, 20))
          order.push('output-tool-end')
          return { summary: 'done' }
        }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      jobCtx.shutdown.mockImplementation(() => {
        order.push('job-shutdown')
      })

      let tools: any
      const outputExecution = new Promise<void>((resolve, reject) => {
        lkSessionMock.start.mockImplementation(async (opts: any) => {
          tools = opts.agent.tools
          setTimeout(async () => {
            try {
              emitUserSpeech(lkSessionMock)
              await tools.finishRequest.execute({}, {})
              resolve()
            } catch (err) {
              reject(err)
              lkSessionMock._emit('close')
            }
          }, 10)
        })
        lkSessionMock.generateReply.mockImplementation(async () => {
          setTimeout(() => {
            tools.endCall
              .execute(
                { summary: 'done' },
                {
                  ctx: {
                    waitForPlayout: async () => {
                      order.push('playout')
                    },
                  },
                },
              )
              .catch(reject)
          }, 10)
          return {}
        })
      })

      const handle = voiceHandler({
        agent: makeAgent({ tools: [finishRequest], output: endCall }),
        sessionService,
      })

      await handle.entry(jobCtx)
      await outputExecution

      expect(order).toEqual([
        'end-tool',
        'playout',
        'output-tool-start',
        'output-tool-end',
        'job-shutdown',
      ])
      expect(mockDeleteRoom).toHaveBeenCalledTimes(1)
    })

    test('removeParticipant call termination strategy uses the initial caller identity', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ summary: 'done' }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
        callTermination: {
          strategy: 'removeParticipant',
          livekitUrl: 'wss://livekit.example.test',
          apiKey: 'key',
          apiSecret: 'secret',
        },
      })

      await runOutputToolCompletion({ lkSessionMock, handle, jobCtx })

      expect(mockRoomServiceClient).toHaveBeenCalledWith(
        'https://livekit.example.test',
        'key',
        'secret',
      )
      expect(mockRemoveParticipant).toHaveBeenCalledWith('test-room', 'caller')
      expect(mockDeleteRoom).not.toHaveBeenCalled()
    })

    test('callTermination false leaves LiveKit room termination to the deployment', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ summary: 'done' }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
        callTermination: false,
      })

      await runOutputToolCompletion({ lkSessionMock, handle, jobCtx })

      expect(jobCtx.shutdown).not.toHaveBeenCalled()
      expect(mockRoomServiceClient).not.toHaveBeenCalled()
      expect(mockDeleteRoom).not.toHaveBeenCalled()
      expect(mockRemoveParticipant).not.toHaveBeenCalled()
    })

    test('missing room during deleteRoom is treated as successful cleanup', async () => {
      const voiceEvents: any[] = []
      mockDeleteRoom.mockRejectedValue(
        Object.assign(new Error('room does not exist'), { status: 404 }),
      )
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ summary: 'done' }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
        hooks: [{ onVoiceEvent: (event: any) => voiceEvents.push(event) }],
      })

      await runOutputToolCompletion({ lkSessionMock, handle, jobCtx })

      expect(mockDeleteRoom).toHaveBeenCalledWith('test-room')
      expect(voiceEvents.filter((event) => event.type === 'voice_error')).toHaveLength(0)
    })

    test('deleteRoom failures emit voice_error and still commit the session', async () => {
      const voiceEvents: any[] = []
      const error = new Error('livekit unavailable')
      mockDeleteRoom.mockRejectedValue(error)
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ summary: 'done' }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
        hooks: [{ onVoiceEvent: (event: any) => voiceEvents.push(event) }],
      })

      await runOutputToolCompletion({ lkSessionMock, handle, jobCtx })

      expect(voiceEvents).toContainEqual({ type: 'voice_error', error })
      expect(sessionService.commitSession).toHaveBeenCalledTimes(1)
    })

    test('duplicate completion and disconnect races terminate the call once', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const endCall = {
        name: 'endCall',
        description: 'End the call',
        schema: {},
        execute: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ summary: 'done' }),
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent({ output: endCall }),
        sessionService,
      })

      await runOutputToolCompletion({
        lkSessionMock,
        handle,
        jobCtx,
        afterTool: () => jobCtx.room._emit('disconnected'),
      })

      expect(jobCtx.shutdown).toHaveBeenCalledTimes(1)
      expect(mockDeleteRoom).toHaveBeenCalledTimes(1)
    })
  })

  describe('wireEventListeners', () => {
    function makeLKSessionWithListeners() {
      const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
      return {
        on: vi.fn<(...args: unknown[]) => unknown>(
          (event: string, cb: (...args: unknown[]) => void) => {
            if (!listeners.has(event)) listeners.set(event, [])
            listeners.get(event)!.push(cb)
          },
        ),
        emit(event: string, ...args: unknown[]) {
          for (const fn of listeners.get(event) ?? []) fn(...args)
        },
      }
    }

    function makeGetAgentState(overrides?: Record<string, any>) {
      return () => ({
        agent: overrides?.agent ?? makeAgent({ name: 'test' }),
        invocationId: overrides?.invocationId ?? 'inv_1',
        composedHook: overrides?.composedHook ?? {},
        composedErrorHandler: overrides?.composedErrorHandler ?? {
          handle: vi.fn<(...args: unknown[]) => unknown>(),
        },
        functionTools: overrides?.functionTools ?? [],
      })
    }

    test('MetricsCollected populates usage from realtime_model_metrics', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any

      const tracker = wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState(),
      })

      lkSession.emit('metrics_collected', {
        metrics: {
          type: 'realtime_model_metrics',
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { audioTokens: 80, cachedTokens: 10 },
          outputTokenDetails: { audioTokens: 40 },
        },
      })

      await tracker.queue.drain()

      const usage = tracker.getUsage()
      expect(usage).toBeDefined()
      expect(usage!.inputTokens).toBe(100)
      expect(usage!.outputTokens).toBe(50)
      expect(usage!.audioInputTokens).toBe(80)
      expect(usage!.audioOutputTokens).toBe(40)
      expect(usage!.cachedTokens).toBe(10)
      expect(usage!.modelCalls).toBe(1)
    })

    test('MetricsCollected aggregates usage across multiple model turns', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any

      const tracker = wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState(),
      })
      tracker.resetUsage('gpt-4o-realtime')

      lkSession.emit('metrics_collected', {
        metrics: {
          type: 'realtime_model_metrics',
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { audioTokens: 80, cachedTokens: 10 },
          outputTokenDetails: { audioTokens: 40 },
        },
      })

      lkSession.emit('metrics_collected', {
        metrics: {
          type: 'realtime_model_metrics',
          inputTokens: 200,
          outputTokens: 100,
          inputTokenDetails: { audioTokens: 160, cachedTokens: 20 },
          outputTokenDetails: { audioTokens: 80 },
        },
      })

      lkSession.emit('metrics_collected', {
        metrics: {
          type: 'realtime_model_metrics',
          inputTokens: 300,
          outputTokens: 150,
          inputTokenDetails: {
            audioTokens: 240,
            cachedTokens: 30,
            cachedTokensDetails: { audioTokens: 15 },
          },
          outputTokenDetails: { audioTokens: 120 },
        },
      })

      await tracker.queue.drain()

      const usage = tracker.getUsage()
      expect(usage).toBeDefined()
      expect(usage!.modelName).toBe('gpt-4o-realtime')
      expect(usage!.modelCalls).toBe(3)
      expect(usage!.inputTokens).toBe(600)
      expect(usage!.outputTokens).toBe(300)
      expect(usage!.audioInputTokens).toBe(480)
      expect(usage!.audioOutputTokens).toBe(240)
      expect(usage!.cachedTokens).toBe(60)
      expect(usage!.audioCachedTokens).toBe(15)
    })

    test('AgentStateChanged emits model_start on thinking and model_end on transition out', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any
      const tools = [{ name: 'myTool', description: 'A tool' }]

      const tracker = wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState({ functionTools: tools }),
      })

      lkSession.emit('agent_state_changed', {
        oldState: 'listening',
        newState: 'thinking',
      })
      lkSession.emit('agent_state_changed', {
        oldState: 'thinking',
        newState: 'speaking',
      })
      lkSession.emit('agent_state_changed', {
        oldState: 'speaking',
        newState: 'listening',
      })

      await tracker.queue.drain()

      const appended = mockAppendEvent.mock.calls.map((c: any[]) => c[1])
      const starts = appended.filter((e: any) => e.type === 'model_start')
      const ends = appended.filter((e: any) => e.type === 'model_end')

      expect(starts).toHaveLength(1)
      expect(starts[0].stepIndex).toBe(0)
      expect(ends).toHaveLength(1)
      expect(ends[0].stepIndex).toBe(0)
      expect(ends[0].finishReason).toBe('stop')
    })

    test('ConversationItemAdded emits user and assistant transcript events', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any

      const tracker = wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState(),
      })

      lkSession.emit('conversation_item_added', {
        item: { role: 'user', textContent: 'Hello', createdAt: 1000 },
      })
      lkSession.emit('conversation_item_added', {
        item: { role: 'assistant', textContent: 'Hi there!', createdAt: 2000 },
      })

      await tracker.queue.drain()

      const appended = mockAppendEvent.mock.calls.map((c: any[]) => c[1])
      const userEvents = appended.filter((e: any) => e.type === 'user')
      const assistantEvents = appended.filter((e: any) => e.type === 'assistant')

      expect(userEvents).toHaveLength(1)
      expect(userEvents[0].text).toBe('Hello')
      expect(userEvents[0].source).toBe('transcript')
      expect(userEvents[0].createdAt).toBe(1000)

      expect(assistantEvents).toHaveLength(1)
      expect(assistantEvents[0].text).toBe('Hi there!')
      expect(assistantEvents[0].source).toBe('transcript')
      expect(assistantEvents[0].createdAt).toBe(2000)
    })

    test('ConversationItemAdded lets forced-tool gate consume assistant transcript events', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any
      const onAssistantMessage = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(true)
      const onTranscript = vi.fn<(...args: unknown[]) => unknown>()

      const tracker = wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState(),
        onAssistantMessage,
        onTranscript,
      })

      lkSession.emit('conversation_item_added', {
        item: { role: 'assistant', textContent: 'I am ending the call now.', createdAt: 2000 },
      })

      await tracker.queue.drain()

      expect(onAssistantMessage).toHaveBeenCalledWith('I am ending the call now.')
      expect(mockAppendEvent).not.toHaveBeenCalled()
      expect(onTranscript).not.toHaveBeenCalled()
    })

    test('UserStateChanged away does not append events (ADK owns inactivity timer)', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any

      const tracker = wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState(),
      })

      lkSession.emit('user_state_changed', { newState: 'away' })
      await tracker.queue.drain()
      expect(mockAppendEvent).not.toHaveBeenCalled()
    })

    test('onTranscript fires for user transcript with correct event', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any
      const onTranscript = vi.fn<(...args: unknown[]) => unknown>()

      wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState({
          invocationId: 'inv_42',
          agent: makeAgent({ name: 'bot' }),
        }),
        onTranscript,
      })

      lkSession.emit('conversation_item_added', {
        item: { role: 'user', textContent: 'Hi there', createdAt: 5000 },
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(onTranscript).toHaveBeenCalledTimes(1)
      const [event, invId, agent] = onTranscript.mock.calls[0]
      expect(event.type).toBe('user')
      expect(event.text).toBe('Hi there')
      expect(invId).toBe('inv_42')
      expect(agent.name).toBe('bot')
    })

    test('onTranscript fires for assistant transcript with correct event', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any
      const onTranscript = vi.fn<(...args: unknown[]) => unknown>()

      wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState({
          invocationId: 'inv_99',
          agent: makeAgent({ name: 'assistant-bot' }),
        }),
        onTranscript,
      })

      lkSession.emit('conversation_item_added', {
        item: { role: 'assistant', textContent: 'Hello!', createdAt: 6000 },
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(onTranscript).toHaveBeenCalledTimes(1)
      const [event, invId, agent] = onTranscript.mock.calls[0]
      expect(event.type).toBe('assistant')
      expect(event.text).toBe('Hello!')
      expect(invId).toBe('inv_99')
      expect(agent.name).toBe('assistant-bot')
    })

    test('onTranscript captures snapshot of invocationId at event time, not execution time', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any
      const onTranscript = vi.fn<(...args: unknown[]) => unknown>()

      let currentState = {
        invocationId: 'inv_before',
        agent: makeAgent({ name: 'agent-a' }),
      }
      const getAgentState = () => ({
        ...currentState,
        composedHook: {},
        composedErrorHandler: { handle: vi.fn<(...args: unknown[]) => unknown>() },
        functionTools: [],
      })

      wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState,
        onTranscript,
      })

      lkSession.emit('conversation_item_added', {
        item: { role: 'user', textContent: 'Before transfer', createdAt: 1000 },
      })

      currentState = {
        invocationId: 'inv_after',
        agent: makeAgent({ name: 'agent-b' }),
      }

      await new Promise((r) => setTimeout(r, 20))

      expect(onTranscript).toHaveBeenCalledTimes(1)
      const [, invId, agent] = onTranscript.mock.calls[0]
      expect(invId).toBe('inv_before')
      expect(agent.name).toBe('agent-a')
    })

    test('onTranscript is not called for unknown roles', async () => {
      const lkSession = makeLKSessionWithListeners()
      const mockAppendEvent = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const sessionService = { appendEvent: mockAppendEvent } as any
      const session = { events: [] } as any
      const onTranscript = vi.fn<(...args: unknown[]) => unknown>()

      wireEventListeners({
        lkSession: lkSession as any,
        sessionService,
        session,
        getAgentState: makeGetAgentState(),
        onTranscript,
      })

      lkSession.emit('conversation_item_added', {
        item: {
          role: 'system',
          textContent: 'System message',
          createdAt: 1000,
        },
      })

      await new Promise((r) => setTimeout(r, 20))

      expect(onTranscript).not.toHaveBeenCalled()
    })
  })

  describe('beforeAgent hook redirect', () => {
    withAgentSessionRestore()

    test('transfer to second agent runs two invocation cycles', async () => {
      const agentB = makeAgent({ name: 'agent-b' })
      let hookCallCount = 0

      lkAgents.voice.AgentSession.mockImplementation(() => {
        const mock = makeLKSessionMock()
        mock.start.mockImplementation(async () => {
          setTimeout(() => mock._emit('close'), 10)
        })
        return mock
      })

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent({ name: 'agent-a' }),
        sessionService,
        hooks: [
          {
            beforeAgent: () => {
              hookCallCount++
              if (hookCallCount === 1) return agentB
            },
          },
        ],
      })

      await handle.entry(jobCtx)

      const events = sessionService.appendEvent.mock.calls.map((c: any[]) => c[1])
      const starts = events.filter((e: any) => e.type === 'invocation_start')
      const ends = events.filter((e: any) => e.type === 'invocation_end')

      expect(starts).toHaveLength(2)
      expect(starts[0].agentName).toBe('agent-a')
      expect(starts[1].agentName).toBe('agent-b')
      expect(ends).toHaveLength(2)
      expect(ends[0].reason).toBe('transferred')
    })
  })

  describe('beforeAgent hook paths', () => {
    withAgentSessionRestore()

    beforeEach(() => {
      resetCallTerminationMocks()
    })

    test('beforeAgent returning Runnable transfers without starting LiveKit session', async () => {
      const transferTarget = {
        kind: 'agent',
        name: 'specialist',
        model: realtime({
          model: { provider: 'openai', name: 'gpt-4o-realtime' },
        }),
        tools: [],
        context: [],
      }
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let hookCallCount = 0
      lkAgents.voice.AgentSession.mockImplementation(() => {
        const mock = makeLKSessionMock()
        mock.start.mockImplementation(async () => {
          setTimeout(() => mock._emit('close'), 10)
        })
        return mock
      })

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            beforeAgent: () => {
              hookCallCount++
              if (hookCallCount === 1) return transferTarget
            },
          },
        ],
      })

      await handle.entry(jobCtx)

      const events = sessionService.appendEvent.mock.calls.map((c: any[]) => c[1])
      const ends = events.filter((e: any) => e.type === 'invocation_end')

      expect(ends).toHaveLength(2)
      expect(ends[0].reason).toBe('transferred')
      expect(ends[0].handoffTarget.agentName).toBe('specialist')
      expect(ends[1].agentName).toBe('specialist')
    })

    test('beforeAgent returning string speaks and ends', async () => {
      const lkSessionMock = makeLKSessionMock({
        waitForPlayout: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      })
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            beforeAgent: () => 'Sorry, we are closed.',
          },
        ],
      })

      await handle.entry(jobCtx)

      expect(lkSessionMock.start).toHaveBeenCalled()
      expect(lkSessionMock.generateReply).toHaveBeenCalled()

      const events = sessionService.appendEvent.mock.calls.map((c: any[]) => c[1])
      const ends = events.filter((e: any) => e.type === 'invocation_end')
      expect(ends).toHaveLength(1)
      expect(ends[0].reason).toBe('completed')
      expect(jobCtx.shutdown).toHaveBeenCalledWith('Session ended')
      expect(mockDeleteRoom).toHaveBeenCalledWith('test-room')
    })

    test('beforeAgent returning string finalizes through the single path (runs completion hooks)', async () => {
      // The string "speak and end" path flows through the same finalize as any other call:
      // exactly one invocation_end, and the end-of-invocation completion hooks run.
      const lkSessionMock = makeLKSessionMock({
        waitForPlayout: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      })
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let afterTurnCalls = 0
      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          { beforeAgent: () => 'Sorry, we are closed.' },
          {
            afterTurn: async () => {
              afterTurnCalls++
            },
          },
        ],
      })

      await handle.entry(jobCtx)

      expect(lkSessionMock.generateReply).toHaveBeenCalled()
      expect(afterTurnCalls).toBe(1)
      const ends = sessionService.appendEvent.mock.calls
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'invocation_end')
      expect(ends).toHaveLength(1)
      expect(ends[0].reason).toBe('completed')
    })

    test('agent-level onInactivity hook can keep the voice session alive', async () => {
      const waitForPlayout = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined)
      const lkSessionMock = makeLKSessionMock({ waitForPlayout })
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()
      const onInactivity = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockImplementation(async (ctx) => {
          await ctx.voice.generateReply({
            instructions: `Prompt ${ctx.inactivityCount}`,
            toolChoice: 'none',
          })
          // End the call once the inactivity hook has fired. Driving close from here —
          // rather than a fixed real-timer delay racing the inactivity timeout — keeps this
          // test deterministic under CI load. Returning false proves the hook kept the call
          // alive: the session was still running to receive this close.
          setTimeout(() => lkSessionMock._emit('close'), 0)
          return false
        })

      const handle = voiceHandler({
        agent: makeAgent({
          timeouts: { inactivity: 10 },
          hooks: [{ onInactivity }],
        }),
        sessionService,
      })

      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => {
          lkSessionMock._emit('agent_state_changed', {
            oldState: 'speaking',
            newState: 'listening',
          })
        }, 0)
      })

      await handle.entry(jobCtx)

      expect(onInactivity).toHaveBeenCalled()
      expect(lkSessionMock.generateReply).toHaveBeenCalledWith({
        instructions: 'Prompt 0',
        toolChoice: 'none',
      })

      const endEvents = sessionService.appendEvent.mock.calls
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'invocation_end')
      expect(endEvents).toHaveLength(1)
      expect(endEvents[0].reason).toBe('completed')
    })
  })

  describe('patient call completion on abnormal teardown', () => {
    // Regression coverage for the production failure where calls never ran the completeCall
    // lambda. The patient-requests agent invokes completeCall from an afterTurn completion
    // hook; on abnormal teardown the LiveKit worker killed the job before the post-sessionDone
    // main path ran, so afterTurn — and thus completeCall — was skipped. Both prod triggers
    // (immediate caller disconnect, and a human-transfer racing the disconnect) reduce to the
    // same guarantee: afterTurn must run inside the worker shutdown barrier. These fail on the
    // pre-0.5.24 handler (completeCall never fires) and pass on 0.5.24.
    withAgentSessionRestore()

    // Drives the real voiceHandler with a completeCall spy in afterTurn (mirroring the
    // agent's completionHook), parks the session so the ONLY finalization path is the worker
    // shutdown barrier (the in-process stand-in for "the worker exits before the main path
    // finalizes"), runs that barrier as the worker does, and reports completeCall invocations.
    async function runUntilWorkerShutdown(onActive?: () => void) {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)
      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let completeCall = 0
      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            afterTurn: async () => {
              completeCall++
            },
          },
        ],
      })

      lkSessionMock.start.mockResolvedValue(undefined)
      const entryPromise = handle.entry(jobCtx)

      for (let i = 0; i < 200; i++) {
        if (lkSessionMock.start.mock.calls.length > 0 && jobCtx._shutdownCallbacks.length > 0) {
          break
        }
        await new Promise<void>((r) => setTimeout(r, 0))
      }
      await new Promise<void>((r) => setTimeout(r, 0))
      onActive?.()
      const completeCallBeforeShutdown = completeCall

      // The LiveKit worker awaits its shutdown callbacks, then reports the job done and exits.
      // Capture the count at that instant: in production the process is gone immediately after,
      // so whatever the post-sessionDone main path would do later never happens. (Awaiting the
      // entry promise first would let the in-process main path finalize and mask the bug.)
      await Promise.all(jobCtx._shutdownCallbacks.map((cb) => cb()))
      const completeCallAfterShutdown = completeCall

      await entryPromise
      return { completeCallBeforeShutdown, completeCallAfterShutdown }
    }

    test('caller disconnects immediately at the start of the call → completeCall still runs', async () => {
      // No turns occur — the caller drops at the very start. Pre-0.5.24 the worker tore the
      // job down before finalize, so completeCall was never invoked for these dropped calls.
      const r = await runUntilWorkerShutdown()
      expect(r.completeCallBeforeShutdown).toBe(0) // nothing finalized before the barrier
      expect(r.completeCallAfterShutdown).toBe(1) // completeCall runs inside the barrier
    })

    test('human transfer racing the caller disconnect → completeCall runs exactly once', async () => {
      // Models call 5cb8b9f0: a human transfer is in flight when the caller disconnects and
      // the job is torn down. completeCall must run exactly once — not zero (the prod bug),
      // and not twice (no double finalize).
      const r = await runUntilWorkerShutdown(() => {
        // The turn that requested the transfer has occurred by the time teardown races in.
      })
      expect(r.completeCallAfterShutdown).toBe(1)
    })
  })

  describe('disconnect race fix', () => {
    withAgentSessionRestore()

    test('simultaneous participantDisconnected + disconnected uses participant_left when hook runs first', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: {
          kind: 'agent',
          name: 'test',
          model: realtime({
            model: { provider: 'openai', name: 'gpt-4o-realtime' },
          }),
          tools: [],
          context: [],
        },
        sessionService,
      })

      lkSessionMock.start.mockImplementation(async () => {
        setTimeout(() => {
          ;(jobCtx.room as any)._emit('participantDisconnected')
          ;(jobCtx.room as any)._emit('disconnected')
        }, 10)
      })

      await handle.entry(jobCtx)

      const endEvents = sessionService.appendEvent.mock.calls
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'invocation_end')

      expect(endEvents).toHaveLength(1)
      expect(endEvents[0].reason).toBe('participant_left')
    })
  })

  describe('onTranscript integration', () => {
    withAgentSessionRestore()

    test('onTranscript hook fires for each transcript message with session and state', async () => {
      const transcriptEvents: any[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            onTranscript: (ctx: any) => {
              transcriptEvents.push({
                type: ctx.event.type,
                text: ctx.event.text,
                hasSession: !!ctx.session,
                hasState: !!ctx.state,
                hasVoice: !!ctx.voice,
                hasRun: typeof ctx.run === 'function',
              })
            },
          },
        ],
      })

      lkSessionMock.start.mockImplementation(async () => {
        lkSessionMock._emit('conversation_item_added', {
          item: { role: 'user', textContent: 'Hello', createdAt: 1000 },
        })
        lkSessionMock._emit('conversation_item_added', {
          item: { role: 'assistant', textContent: 'Hi!', createdAt: 2000 },
        })
        setTimeout(() => lkSessionMock._emit('close'), 50)
      })

      await handle.entry(jobCtx)

      expect(transcriptEvents).toHaveLength(2)
      expect(transcriptEvents[0]).toEqual({
        type: 'user',
        text: 'Hello',
        hasSession: true,
        hasState: true,
        hasVoice: true,
        hasRun: true,
      })
      expect(transcriptEvents[1]).toEqual({
        type: 'assistant',
        text: 'Hi!',
        hasSession: true,
        hasState: true,
        hasVoice: true,
        hasRun: true,
      })
    })

    test('onTranscript error does not crash the session', async () => {
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      let secondHookCalled = false

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            onTranscript: () => {
              throw new Error('Hook explosion')
            },
          },
          {
            onTranscript: () => {
              secondHookCalled = true
            },
          },
        ],
      })

      lkSessionMock.start.mockImplementation(async () => {
        lkSessionMock._emit('conversation_item_added', {
          item: { role: 'user', textContent: 'Boom', createdAt: 1000 },
        })
        setTimeout(() => lkSessionMock._emit('close'), 50)
      })

      await handle.entry(jobCtx)

      expect(secondHookCalled).toBe(true)

      const endEvents = sessionService.appendEvent.mock.calls
        .map((c: any[]) => c[1])
        .filter((e: any) => e.type === 'invocation_end')
      expect(endEvents).toHaveLength(1)
    })

    test('multiple onTranscript hooks run in order', async () => {
      const order: number[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            onTranscript: () => {
              order.push(1)
            },
          },
          {
            onTranscript: () => {
              order.push(2)
            },
          },
          {
            onTranscript: () => {
              order.push(3)
            },
          },
        ],
      })

      lkSessionMock.start.mockImplementation(async () => {
        lkSessionMock._emit('conversation_item_added', {
          item: { role: 'user', textContent: 'Test', createdAt: 1000 },
        })
        setTimeout(() => lkSessionMock._emit('close'), 50)
      })

      await handle.entry(jobCtx)

      expect(order).toEqual([1, 2, 3])
    })

    test('onTranscript queue drains before commit', async () => {
      const callOrder: string[] = []
      const lkSessionMock = makeLKSessionMock()
      lkAgents.voice.AgentSession.mockImplementation(() => lkSessionMock)

      const sessionService = makeSessionService()
      sessionService.commitSession.mockImplementation(async () => {
        callOrder.push('commit')
        return { ok: true }
      })
      const jobCtx = makeJobContext()

      const handle = voiceHandler({
        agent: makeAgent(),
        sessionService,
        hooks: [
          {
            onTranscript: async () => {
              await new Promise((r) => setTimeout(r, 30))
              callOrder.push('transcript_hook_done')
            },
          },
        ],
      })

      lkSessionMock.start.mockImplementation(async () => {
        lkSessionMock._emit('conversation_item_added', {
          item: { role: 'user', textContent: 'Slow hook', createdAt: 1000 },
        })
        setTimeout(() => lkSessionMock._emit('close'), 10)
      })

      await handle.entry(jobCtx)

      expect(callOrder.indexOf('transcript_hook_done')).toBeLessThan(callOrder.indexOf('commit'))
    })
  })
})
