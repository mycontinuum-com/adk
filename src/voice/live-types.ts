import type { Agent, AgentTimeouts, LiveAgent } from '../types/runnables'
import type { CostAccount, UsageSummary } from '../types/runtime'
import type { StateSchema, TypedState } from '../types/schema'
import type { Session } from '../types/session'
import type { GPTLiveTranscript } from './gpt-live-transcript'
import type { VoiceHandlerConfig } from './types'

interface LiveCommentaryOptions {
  /**
   * `false` makes a line the caller cannot talk over, such as a notice or a goodbye. Caller audio
   * is replaced with silence at once. The line is given only once GPT Live is quiet and no
   * delegation is in flight, and counts as said when GPT Live's next speaking turn has started and
   * ended. The caller is heard again after that, or after `playoutTimeoutMs` if GPT Live never
   * speaks. Default: `true`, which gives the line at once.
   */
  allowInterruptions?: boolean
}

export interface LiveVoiceControls {
  /**
   * Request call termination. The call closes once every line given with `allowInterruptions:
   * false` has been said, within `playoutTimeoutMs`, so a goodbye is not cut off.
   */
  end(): void
  appendThinking(text: string): void
  appendCommentary(text: string, options?: LiveCommentaryOptions): void
  appendInstructions(text: string): void
  /** Caller speech turns so far in the call. */
  readonly turnCount: number
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

/** GPT Live session time for one call. The voice model bills connected time, not tokens. */
export interface LiveVoiceSessionUsage {
  readonly modelName: string
  /** Billed session seconds. Absent when neither provider usage nor connection time is known. */
  readonly seconds?: number
  readonly cost: CostAccount
}

/** Token usage and its cost. `usage` is absent when no model call was observed. */
export interface UsageCost {
  readonly usage?: UsageSummary
  readonly cost: CostAccount
}

/** Per-call usage: ADK backend model calls and GPT Live session time, costed separately. */
export interface LiveCallUsage {
  readonly backend: UsageCost
  readonly voice: LiveVoiceSessionUsage
  /** Backend plus voice. Unavailable when either component is unavailable. */
  readonly total: CostAccount
}

export interface LiveVoiceExitContext<
  S extends StateSchema = StateSchema,
> extends LiveVoiceContext<S> {
  /** Final call usage, measured after the voice session closed. */
  readonly usage: LiveCallUsage
}

interface LiveVoiceInactivityContext<
  S extends StateSchema = StateSchema,
> extends LiveVoiceContext<S> {
  /** Silences in a row before this one. Resets to 0 when the caller speaks. */
  readonly inactivityCount: number
}

/** `false` keeps the call. Anything else, including a throw, lets it end. */
type LiveLifecycleHookResult = void | boolean | Promise<void | boolean>

export interface LiveVoiceHook<S extends StateSchema = StateSchema, T = unknown> {
  onEnter?(ctx: LiveVoiceContext<S>): void | Promise<void>
  /** Each time neither the caller nor the agent has spoken for `timeouts.inactivity`. */
  onInactivity?(ctx: LiveVoiceInactivityContext<S>): LiveLifecycleHookResult
  /** Once, when the call reaches `timeouts.expiry`. */
  onExpiry?(ctx: LiveVoiceContext<S>): LiveLifecycleHookResult
  onResult?(ctx: LiveVoiceResultContext<S, T>): void | Promise<void>
  onExit?(ctx: LiveVoiceExitContext<S>): void | Promise<void>
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
  /** Silence and call length limits in milliseconds. An unset limit never fires. */
  timeouts?: Pick<AgentTimeouts, 'inactivity' | 'expiry'>
  /**
   * Longest wait for each step of a line given with `allowInterruptions: false`: for GPT Live to be
   * quiet, then for it to say the line. Default: 30_000.
   */
  playoutTimeoutMs?: number
}
