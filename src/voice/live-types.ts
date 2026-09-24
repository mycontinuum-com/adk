import type { Agent, LiveAgent } from '../types/runnables'
import type { StateSchema, TypedState } from '../types/schema'
import type { Session } from '../types/session'
import type { GPTLiveTranscript } from './gpt-live-transcript'
import type { VoiceHandlerConfig } from './types'

export interface LiveVoiceControls {
  /** Request call termination. Does not wait for speech playback. */
  end(): void
  appendThinking(text: string): void
  appendCommentary(text: string): void
  appendInstructions(text: string): void
}

export interface LiveVoiceContext<S extends StateSchema = StateSchema> {
  readonly session: Session<S>
  readonly state: TypedState<S>
  readonly callId: string
  readonly voice: LiveVoiceControls
  readonly transcript: GPTLiveTranscript
}

export interface LiveVoiceDelegation {
  readonly id: string
  readonly connectionId: string
  readonly nativeThrough: number
}

export interface LiveVoiceResultContext<
  S extends StateSchema = StateSchema,
  T = unknown,
> extends LiveVoiceContext<S> {
  readonly delegation: LiveVoiceDelegation
  readonly backendSession: Session<S>
  readonly output: T
}

export interface LiveVoiceErrorContext<
  S extends StateSchema = StateSchema,
> extends LiveVoiceContext<S> {
  readonly recoverable: boolean
  readonly error: unknown
  readonly delegation?: LiveVoiceDelegation
}

export interface LiveVoiceHook<S extends StateSchema = StateSchema, T = unknown> {
  onEnter?(ctx: LiveVoiceContext<S>): void | Promise<void>
  onResult?(ctx: LiveVoiceResultContext<S, T>): void | Promise<void>
  onExit?(ctx: LiveVoiceContext<S>): void | Promise<void>
  onError?(
    ctx: LiveVoiceErrorContext<S>,
  ): 'continue' | 'end' | void | Promise<'continue' | 'end' | void>
}

export interface LiveVoiceHandlerConfig<
  S extends StateSchema = StateSchema,
  T = unknown,
> extends Pick<VoiceHandlerConfig<S>, 'name' | 'worker' | 'prewarm' | 'setup' | 'callTermination'> {
  agent: LiveAgent<S>
  backend: Agent<S, T>
  hooks?: LiveVoiceHook<S, T>[]
  backendTimeoutMs?: number
}
