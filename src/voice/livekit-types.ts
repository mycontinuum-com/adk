import type { VoiceParticipant } from './types'

export interface LKPlayHandle {
  done(): boolean
  stop(): void
  waitForPlayout(): Promise<void>
}

export interface LKSpeechHandle {
  waitForPlayout(): Promise<void>
  interrupted?: boolean
}

export interface LKBackgroundAudioPlayer {
  start(opts: { room: unknown; agentSession?: unknown }): Promise<void>
  play(audio: unknown, loop?: boolean): LKPlayHandle
  close(): Promise<void>
}

export interface LKAgentSession {
  on(event: string, cb: (...args: unknown[]) => void): void
  start(opts: {
    agent: unknown
    room: unknown
    inputOptions?: Record<string, unknown>
  }): Promise<void>
  updateAgent(agent: unknown): void
  close(): Promise<void>
  shutdown?(opts?: { reason?: string }): void
  generateReply(opts?: {
    userInput?: string
    instructions?: string
    toolChoice?: string | object
    allowInterruptions?: boolean
  }): unknown
  say?(
    text: string | unknown,
    opts?: { audio?: unknown; allowInterruptions?: boolean; addToChatCtx?: boolean },
  ): LKSpeechHandle
  interrupt?(): void
}

export interface LKAgentInstance {
  onEnter: () => Promise<void>
  onExit: () => Promise<void>
}

export interface LKImports {
  voice: {
    Agent: new (opts: {
      instructions: string
      tools?: Record<string, unknown>
      llm?: unknown
      stt?: unknown
      tts?: unknown
    }) => LKAgentInstance
    AgentSession: new (opts: Record<string, unknown>) => LKAgentSession
    AgentSessionEventTypes: Record<string, string>
    BackgroundAudioPlayer?: new (opts: Record<string, unknown>) => LKBackgroundAudioPlayer
  }
  llm: {
    tool(opts: {
      description: string
      parameters: unknown
      execute: (args: Record<string, unknown>, opts: unknown) => Promise<unknown>
    }): unknown
    handoff(opts: { agent: unknown; returns?: unknown }): unknown
  }
  cli: { runApp(opts: unknown): void }
  ServerOptions: new (opts: Record<string, unknown>) => unknown
  audioFramesFromFile(filePath: string, options?: Record<string, unknown>): AsyncIterable<unknown>
}

export interface VoiceDeps {
  agents(): LKImports
  openai(): any
  google(): any
  livekitServer(): LiveKitServerImports
}

export interface LiveKitRoomServiceClient {
  deleteRoom(roomName: string): Promise<void>
  removeParticipant(roomName: string, identity: string): Promise<void>
}

export interface LiveKitServerImports {
  RoomServiceClient: new (
    livekitUrl: string,
    apiKey?: string,
    apiSecret?: string,
  ) => LiveKitRoomServiceClient
}

let _lk: LKImports | null = null

export const defaultVoiceDeps: VoiceDeps = {
  agents() {
    return (_lk ??= require('@livekit/agents') as LKImports)
  },
  openai() {
    return require('@livekit/agents-plugin-openai')
  },
  google() {
    return require('@livekit/agents-plugin-google')
  },
  livekitServer() {
    return require('livekit-server-sdk') as LiveKitServerImports
  },
}

export interface JobContext {
  room: {
    name?: string
    on?(event: string, cb: (...args: unknown[]) => void): void
    off?(event: string, cb: (...args: unknown[]) => void): void
  }
  connect(): Promise<void>
  waitForParticipant(): Promise<VoiceParticipant>
  addShutdownCallback(cb: () => Promise<void>): void
  shutdown?(reason?: string): void
}
