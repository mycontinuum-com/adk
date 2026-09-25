import type { Event } from '../../types/events'
import type { Agent, LiveAgent } from '../../types/runnables'
import type { CostAccount, UsageSummary } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'
import type { GPTLiveTranscriptSnapshot } from '../../voice/gpt-live-transcript'
import type {
  LiveVoiceHandlerConfig,
  LiveVoiceSessionUsage,
  UsageCost,
} from '../../voice/live-types'
import type { VoiceEvent, VoiceHook } from '../../voice/types'
import type { Metric } from '../metrics/types'
import type { BaseEvalCaseResult, BaseEvalResult, ToolMocks, StateChanges } from '../types'

// ---------------------------------------------------------------------------
// Case
// ---------------------------------------------------------------------------

interface VoiceEvalCaseBase<S extends StateSchema = StateSchema> {
  name: string
  description?: string
  /** @internal Created by `app.evaluate.voice.case((control) => ...)`; the runner binds it to its room. */
  evalControl?: VoiceEvalControl & { bind(binding: VoiceEvalControl): () => void }
  initialState?: StateChanges<S>
  toolMocks?: ToolMocks<S>
  metrics?: Metric<VoiceRunResult<S>>[]
  retries?: number
  /** Wall-clock timeout in ms. Default: 300_000 (5 min). */
  timeout?: number
}

export type RealtimeVoiceEvalCase<S extends StateSchema = StateSchema> = VoiceEvalCaseBase<S> & {
  agent: Agent<any, any>
  /** Simulated caller on a Realtime model. */
  userAgent: Agent<any, any>
  backend?: never
}

export type LiveVoiceEvalCase<S extends StateSchema = StateSchema, T = any> = VoiceEvalCaseBase<S> &
  Pick<
    LiveVoiceHandlerConfig<S, T>,
    'agent' | 'backend' | 'hooks' | 'setup' | 'backendTimeoutMs' | 'playoutTimeoutMs' | 'timeouts'
  > & {
    /**
     * Simulated caller: a Realtime agent, or an `openai.live(...)` agent that speaks from its
     * system instructions alone, with no backend and no tools.
     */
    userAgent: Agent<any, any> | LiveAgent<any>
    /** Successful observation window after startup. Default: 30_000. */
    durationMs?: number
  }

export type VoiceEvalCase<S extends StateSchema = StateSchema, T = any> =
  | RealtimeVoiceEvalCase<S>
  | LiveVoiceEvalCase<S, T>

export type VoiceEvalControlDisconnectMode = 'livekit' | 'lifecycle'

export interface VoiceEvalControlDisconnectOptions {
  /**
   * `livekit` physically disconnects the simulated caller. `lifecycle` exercises ADK's
   * participant-left lifecycle path without tearing down the realtime transport.
   */
  mode?: VoiceEvalControlDisconnectMode
}

export interface VoiceEvalControl {
  disconnectUser(options?: VoiceEvalControlDisconnectOptions): Promise<void>
  /**
   * Stops (`true`) or restores (`false`) the simulated caller's audio. The caller still replies
   * while muted, but the agent hears nothing, so a case can hold a silence a model caller would
   * not.
   */
  muteUser(muted: boolean): void
}

export type VoiceEvalCaseFactory<S extends StateSchema = StateSchema, T = any> = (
  control: VoiceEvalControl,
) => VoiceEvalCase<S, T>

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface VoiceRoomConfig {
  url: string
  apiKey?: string
  apiSecret?: string
}

export interface VoiceEvalOptions<S extends StateSchema = StateSchema> {
  /** LiveKit room config. Defaults to LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET env vars. */
  room?: Partial<VoiceRoomConfig>
  schema?: S
  /** When set, writes per-case folders with report.md + recording.wav. */
  output?: string
  hooks?: VoiceHook<any>[]
  metrics?: Metric<VoiceRunResult<S>>[]
  /** Default: 4. */
  concurrency?: number
  stopOnFirstFailure?: boolean
  repeat?: number
  onCase?: (result: VoiceEvalCaseResult<S>, index: number, total: number) => void
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export interface TimingEntry {
  ms: number
  afterTurnIndex: number
  speaker?: 'agent' | 'user'
}

export interface VoiceTiming {
  timeToFirstSpeechMs?: number
  responseTimes: TimingEntry[]
  silenceGaps: TimingEntry[]
  interruptions: { count: number; byAgent: number; byUser: number }
  vadResolutionMs: number
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  role: 'assistant' | 'user'
  text: string
  startMs?: number
  endMs?: number
  turnIndex: number
}

type VoiceDiagnosticEvent = VoiceEvent & { createdAt: number }

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export type VoiceRunStatus =
  | 'completed'
  | 'error'
  | 'timeout'
  | 'inactivity_timeout'
  | 'max_duration'
  | 'disconnected'
  | 'participant_left'

/** Live eval usage: the handler's backend and voice usage plus the simulated caller's tokens. */
export interface LiveVoiceEvalUsage {
  readonly backend: UsageCost
  readonly voice: LiveVoiceSessionUsage
  /** Token usage for a Realtime caller; session time for a GPT Live caller. */
  readonly caller: UsageCost | LiveVoiceSessionUsage
  /** Backend, voice and caller. Unavailable when any component is unavailable. */
  readonly total: CostAccount
}

export interface VoiceRunResult<S extends StateSchema = StateSchema> {
  status: VoiceRunStatus
  startedAtMs: number
  session: Session<S>
  events: readonly Event[]
  voiceEvents: readonly VoiceDiagnosticEvent[]
  transcript: TranscriptEntry[]
  liveTranscript?: GPTLiveTranscriptSnapshot
  /**
   * Final transcriptions of the agent's audio by the simulated caller, when its model sets
   * `inputTranscription`: what reached the caller rather than what the agent generated. `atMs` is
   * relative to `startedAtMs`. Live runs only.
   */
  callerHeard?: Array<{ text: string; atMs: number }>
  timing: VoiceTiming
  recording: { path: string }
  /** Live runs: backend models only; `liveUsage` adds voice and caller cost. */
  usage?: UsageSummary
  /** Live only: backend, GPT Live voice and simulated caller cost, each with its basis. */
  liveUsage?: LiveVoiceEvalUsage
  error?: { message: string; stack?: string }
  durationMs: number
}

// ---------------------------------------------------------------------------
// Case result
// ---------------------------------------------------------------------------

export interface VoiceEvalCaseResult<
  S extends StateSchema = StateSchema,
> extends BaseEvalCaseResult {
  run: VoiceRunResult<S>
}

// ---------------------------------------------------------------------------
// Suite result
// ---------------------------------------------------------------------------

export interface VoiceEvalResult<S extends StateSchema = StateSchema> extends BaseEvalResult<
  VoiceEvalCaseResult<S>
> {}
