import { vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { z } from 'zod'

import type { GPTLiveSession } from './live-model'

import { realtime } from '../providers/models'
import { requireGPTLive } from './live-model'
import { createLiveKitModel } from './livekit-model'
import { defaultVoiceDeps } from './livekit-types'

const clientEvent = z.object({
  type: z.string(),
  content: z.string().optional(),
  session: z.unknown().optional(),
})

/** The port a listening server was given. */
function portOf(server: WebSocketServer): number {
  const address = server.address()
  if (typeof address !== 'object' || address === null)
    throw new Error('The test server is not listening on a port')
  return address.port
}

/** The plugin's GPT Live session, or a failure naming the contract that changed. */
function liveSession(session: unknown): GPTLiveSession {
  const { GPTLiveSession } = requireGPTLive(defaultVoiceDeps.openai())
  if (!(session instanceof GPTLiveSession))
    throw new Error('The GPT Live plugin no longer returns a GPTLiveSession')
  return session
}

/** A private method of the plugin's session, or a failure naming the method that went missing. */
function callPrivate(target: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(target, name)
  if (typeof method !== 'function') throw new Error(`The GPT Live session lost its ${name} method`)
  return method.apply(target, args)
}

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
      await callPrivate(session, 'closeConnection')
    }
  })

  test('replace the GPT Live connection a hook closes, giving later lines to the new one', async () => {
    const agents = defaultVoiceDeps.agents()
    agents.initializeLogger({ pretty: false, level: 'silent' })
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((resolve) => server.once('listening', resolve))
    const connections: Array<Array<z.infer<typeof clientEvent>>> = []
    server.on('connection', (socket) => {
      const received: (typeof connections)[number] = []
      connections.push(received)
      const id = `connection-${connections.length}`
      socket.on('message', (data) => {
        const event = clientEvent.parse(JSON.parse(String(data)))
        received.push(event)
        if (event.type === 'session.start')
          socket.send(JSON.stringify({ type: 'session.started', session: { id } }))
        if (event.type === 'session.close')
          socket.send(JSON.stringify({ type: 'session.closed', reason: 'client' }))
      })
    })
    const port = portOf(server)
    const { GPTLiveModel } = defaultVoiceDeps.openai().realtime
    const session = liveSession(
      new GPTLiveModel({
        apiKey: 'test-key',
        baseURL: `http://127.0.0.1:${port}/v1`,
        delegation: 'client',
        connOptions: { maxRetry: 0, timeoutMs: 2_000, retryIntervalMs: 0 },
      }).session(),
    )
    const reconnected = new Promise<void>((resolve) =>
      session.on('session_reconnected', () => resolve()),
    )
    try {
      // live-handler.ts `reconnect` leaves a connection alone until this is set.
      expect(session.sessionId).toBeUndefined()
      await callPrivate(session, '_updateSession', 'Be brief.')
      await vi.waitFor(() => expect(session.sessionId).toBe('connection-1'))
      session.appendCommentary('Say the opening.', {})
      // live-handler.ts `replaceConnection` relies on this private method.
      callPrivate(session, 'requestConnectionClose')
      session.appendCommentary('Say the opening again.', {})
      await reconnected
      await vi.waitFor(() =>
        expect(connections[1]?.map(({ type }) => type)).toEqual([
          'session.start',
          'session.commentary.append',
        ]),
      )
      expect(session.sessionId).toBe('connection-2')
      expect(connections[1]![0]!.session).toMatchObject({ instructions: 'Be brief.' })
      expect(connections[1]![1]!.content).toBe('Say the opening again.')
      expect(connections[0]!.map(({ type }) => type)).toEqual([
        'session.start',
        'session.commentary.append',
        'session.close',
      ])
    } finally {
      await callPrivate(session, 'closeConnection')
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
