import { realtime } from '../providers/models'
import { createLiveKitModel } from './livekit-model'
import { defaultVoiceDeps } from './livekit-types'

describe('default LiveKit dependencies', () => {
  test('load the public API used by the voice adapter', () => {
    const agents = defaultVoiceDeps.agents()
    const openai = defaultVoiceDeps.openai()
    const google = defaultVoiceDeps.google()

    expect(agents.voice.Agent).toBeTypeOf('function')
    expect(agents.voice.AgentSession).toBeTypeOf('function')
    expect(agents.voice.BackgroundAudioPlayer).toBeTypeOf('function')
    expect(agents.llm.tool).toBeTypeOf('function')
    expect(agents.llm.handoff).toBeTypeOf('function')
    expect(agents.cli.runApp).toBeTypeOf('function')
    expect(agents.ServerOptions).toBeTypeOf('function')
    expect(agents.audioFramesFromFile).toBeTypeOf('function')
    expect(openai.LLM).toBeTypeOf('function')
    expect(openai.realtime.RealtimeModel).toBeTypeOf('function')
    expect(google.LLM).toBeTypeOf('function')
    expect(google.beta.realtime.RealtimeModel).toBeTypeOf('function')
  })

  test('construct the voice adapter with provider options', () => {
    const agents = defaultVoiceDeps.agents()
    const openai = defaultVoiceDeps.openai()
    const google = defaultVoiceDeps.google()

    agents.initializeLogger({ pretty: false, level: 'silent' })

    const agent = new agents.voice.Agent({ instructions: 'You are helpful.', tools: {} })
    const session = new agents.voice.AgentSession({})
    const openAIModel = createLiveKitModel(
      realtime({
        model: { provider: 'openai', name: 'gpt-4o-realtime' },
        turnDetection: { type: 'semantic', silenceDurationMs: 300 },
        providerOptions: { apiKey: 'test-key' },
      }),
    )
    const googleModel = createLiveKitModel(
      realtime({
        model: { provider: 'gemini', name: 'gemini-2.0-flash-live' },
        turnDetection: { type: 'server_vad', silenceDurationMs: 300 },
        providerOptions: { apiKey: 'test-key' },
      }),
    )

    expect(agent).toBeInstanceOf(agents.voice.Agent)
    expect(session).toBeInstanceOf(agents.voice.AgentSession)
    expect(openAIModel.llm).toBeInstanceOf(openai.realtime.RealtimeModel)
    expect(googleModel.llm).toBeInstanceOf(google.beta.realtime.RealtimeModel)
  })

  test('keep the GPT Live conversation a reconnect replays where a moderation stop empties it', async () => {
    const agents = defaultVoiceDeps.agents()
    agents.initializeLogger({ pretty: false, level: 'silent' })
    const { GPTLiveModel } = defaultVoiceDeps.openai().realtime
    const session = new GPTLiveModel({
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:9/v1',
      connOptions: { maxRetry: 0, timeoutMs: 100, retryIntervalMs: 0 },
    }).session()
    try {
      // live-handler.ts `forgetConversation` relies on this private field.
      expect(Reflect.get(Reflect.get(session, 'history'), 'items')).toEqual([])
    } finally {
      await (session as unknown as { closeConnection(): Promise<void> }).closeConnection()
    }
  })
})
