import type { Event } from '../../types/events'
import type { Agent } from '../../types/runnables'
import type { UsageSummary } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'
import type { VoiceEvent, VoiceHook } from '../../voice/types'
import type { Metric } from '../metrics/types'
import type { BaseEvalCaseResult, BaseEvalResult, ToolMocks, StateChanges } from '../types'

// ---------------------------------------------------------------------------
// Case
// ---------------------------------------------------------------------------

export interface VoiceEvalCase<S extends StateSchema = StateSchema> {
  name: string
  description?: string
  agent: Agent<any, any>
  userAgent: Agent<any, any>
  /** @internal Bound by `app.evaluate.voice.case((control) => ...)`. */
  evalControl?: VoiceEvalControl
  initialState?: StateChanges<S>
  toolMocks?: ToolMocks<S>
  metrics?: Metric<VoiceRunResult<S>>[]
  retries?: number
  /** Wall-clock timeout in ms. Default: 300_000 (5 min). */
  timeout?: number
}

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
}

export interface VoiceEvalControlBinding {
  disconnectUser(options?: VoiceEvalControlDisconnectOptions): Promise<void>
}

export type VoiceEvalCaseFactory<S extends StateSchema = StateSchema> = (
  control: VoiceEvalControl,
) => VoiceEvalCase<S>

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

export type VoiceDiagnosticEvent = VoiceEvent & { createdAt: number }

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

export interface VoiceRunResult<S extends StateSchema = StateSchema> {
  status: VoiceRunStatus
  startedAtMs: number
  session: Session<S>
  events: readonly Event[]
  voiceEvents: readonly VoiceDiagnosticEvent[]
  transcript: TranscriptEntry[]
  timing: VoiceTiming
  recording: { path: string }
  usage?: UsageSummary
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
