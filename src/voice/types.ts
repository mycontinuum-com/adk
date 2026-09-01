import type { ErrorHandler } from '../errors/types'
import type { Hook } from '../hook/types'
import type { StateChanges } from '../session/seedState'
import type { SharedScope, UserEvent, AssistantEvent } from '../types/events'
import type {
  AgentTimeouts,
  Runnable,
  ToolChoice,
  SubRunResult,
  HandoffOptions,
  Agent,
  ModelAdapter,
  Provider,
} from '../types/runnables'
import type { StateSchema, TypedState } from '../types/schema'
import type { SessionService, Session } from '../types/session'

/**
 * Thin typed interface for voice-specific capabilities in audio mode. Wraps LiveKit's AgentSession
 * without exposing LiveKit types directly. `undefined` in text mode — tools that don't reference it
 * work identically in both modes.
 */
export interface VoiceSession {
  /**
   * Trigger a new model generation turn with optional instruction override. If the model is
   * currently speaking, the current speech is interrupted first. The returned VoiceReply represents
   * this specific generation — use reply.waitForPlayout() to wait for the model to finish
   * speaking.
   *
   * Primary use: intermediate speech during tool execution and lifecycle hooks.
   */
  generateReply(options?: {
    userInput?: string
    instructions?: string
    toolChoice?: ToolChoice
    allowInterruptions?: boolean
  }): Promise<VoiceReply>

  /**
   * Speak pre-synthesized audio or text via TTS on the main agent audio track. The text is added to
   * the conversation context. If `audio` is provided it plays that directly instead of running TTS
   * — useful for pre-recorded greetings or cached audio.
   */
  say(
    text: string,
    options?: {
      audio?: AsyncIterable<unknown>
      allowInterruptions?: boolean
    },
  ): Promise<VoiceReply>

  /**
   * Play a sound effect on a separate background audio track. Does not appear in the conversation
   * context. Returns a handle to stop playback or wait for it to finish. Requires
   * `sound.backgroundAudio` to be configured on the handler — returns `undefined` when no
   * background audio player is available.
   */
  playSound(
    source: string,
    options?: {
      volume?: number
      loop?: boolean
    },
  ): PlayHandle | undefined

  /**
   * Immediately stop current model speech output. The model stops speaking but remains active and
   * listening. Does nothing if the model is not currently speaking.
   */
  interrupt(): void

  /** Number of user speech segments (blocks of continuous user speech). */
  readonly turnCount: number
}

/** Represents a specific model generation triggered by generateReply(). */
export interface VoiceReply {
  /** Wait for this specific reply's audio to finish playing to the user. */
  waitForPlayout(): Promise<void>
}

/**
 * Handle returned by `VoiceSession.playSound()` to control background audio playback. Backed by
 * LiveKit's BackgroundAudioPlayer.
 */
export interface PlayHandle {
  stop(): void
  waitForPlayout(): Promise<void>
}

export type NoiseCancellationType = 'telephony' | 'general'

export interface SoundConfig {
  noiseCancellation?: NoiseCancellationType
  backgroundAudio?: { thinking?: { source: string; volume: number } }
}

export interface RecordingConfig {
  /**
   * Local track-level recording. Captures room audio tracks to a WAV file via
   *
   * @livekit/rtc-node AudioStream. Good for dev, testing, and evals — no egress
   * infrastructure required. Not a production-quality mixed recording.
   */
  dir?: string
  /**
   * LiveKit Egress recording. Starts a RoomCompositeEgress that records mixed audio (both
   * participants) as OGG directly to S3. Production-quality. Requires `livekit-server-sdk` and a
   * LiveKit deployment with egress enabled. Credentials default to LIVEKIT_URL, LIVEKIT_API_KEY,
   * LIVEKIT_API_SECRET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION env vars.
   */
  egress?: EgressRecordingConfig
}

export interface EgressRecordingConfig {
  /** S3 bucket for recording files. */
  bucket: string
  /** S3 key prefix (e.g. 'recordings/production'). Session ID and timestamp are appended. */
  prefix?: string
  /** AWS region. Defaults to AWS_REGION env var. */
  region?: string
  /** AWS access key ID. Defaults to AWS_ACCESS_KEY_ID env var. */
  accessKeyId?: string
  /** AWS secret access key. Defaults to AWS_SECRET_ACCESS_KEY env var. */
  secretAccessKey?: string
  /** LiveKit server URL. Defaults to LIVEKIT_URL env var. */
  livekitUrl?: string
  /** LiveKit API key. Defaults to LIVEKIT_API_KEY env var. */
  apiKey?: string
  /** LiveKit API secret. Defaults to LIVEKIT_API_SECRET env var. */
  apiSecret?: string
}

export type CallTerminationStrategy = 'deleteRoom' | 'removeParticipant'

export interface CallTerminationConfig {
  /**
   * How ADK terminates the LiveKit call after final output completes. Defaults to deleting the
   * room, matching the legacy Python voice agent behavior.
   */
  strategy?: CallTerminationStrategy
  /** LiveKit server URL. Defaults to LIVEKIT_URL env var. */
  livekitUrl?: string
  /** LiveKit API key. Defaults to LIVEKIT_API_KEY env var. */
  apiKey?: string
  /** LiveKit API secret. Defaults to LIVEKIT_API_SECRET env var. */
  apiSecret?: string
}

export interface SessionSetup<S extends StateSchema = StateSchema> {
  sessionId: string
  scopes?: Partial<Record<SharedScope, string>>
  state?: Record<string, unknown>
  initialState?: StateChanges<S>
  /**
   * Custom S3 filepath for egress recording (e.g. 'orgId/2025-01-01_+441234.ogg'). If set,
   * overrides the default `{prefix}/{sessionId}.ogg` key generation. Only used when
   * `recording.egress` is configured.
   */
  recordingKey?: string
  /** Per-session noise cancellation profile. Overrides handler-level `sound.noiseCancellation`. */
  noiseCancellation?: NoiseCancellationType
}

/**
 * Minimal interface for a LiveKit participant. Matches the subset of RemoteParticipant that the
 * voice handler actually uses, without requiring a hard dependency on @livekit/rtc-node.
 */
export interface VoiceParticipant {
  identity?: string
  attributes?: Record<string, string>
}

export interface LifecycleHookContext<S extends StateSchema = StateSchema> {
  readonly session: Session<S>
  readonly state: TypedState<S>
  readonly voice: VoiceSession
  /**
   * How many times this inactivity cycle has fired. Resets to 0 when the user speaks. Only
   * meaningful in onInactivity.
   */
  readonly inactivityCount: number
}

export interface TranscriptHookContext<S extends StateSchema = StateSchema> {
  readonly session: Session<S>
  readonly state: TypedState<S>
  readonly voice: VoiceSession
  readonly event: UserEvent | AssistantEvent
  run<TOutput>(
    agent: Agent<S, TOutput>,
    inputOrOptions?: string | HandoffOptions,
  ): Promise<SubRunResult<TOutput>>
  run(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): Promise<SubRunResult>
}

/**
 * Return `false` to keep the session alive, `true` to explicitly end it, or `void` (no return) to
 * proceed with the default end behavior.
 */
export type LifecycleHookResult = void | boolean | Promise<void | boolean>

export type VoiceAgentState = 'initializing' | 'thinking' | 'speaking' | 'listening'
export type VoiceUserState = 'speaking' | 'listening' | 'away'

export type VoiceEvent =
  | { type: 'agent_state'; oldState: VoiceAgentState; newState: VoiceAgentState }
  | { type: 'user_state'; oldState: VoiceUserState; newState: VoiceUserState }
  | { type: 'speech_created'; source: string }
  | {
      type: 'voice_activity'
      activity:
        | 'user_speech_started'
        | 'agent_active'
        | 'agent_idle'
        | 'inactivity_timer_started'
        | 'inactivity_timer_cleared'
        | 'inactivity_timeout_fired'
      inactivityCount?: number
      timeoutMs?: number
      reason?: string
    }
  | {
      type: 'lifecycle_hook_started'
      hookName: 'onInactivity' | 'onExpiry' | 'onDisconnect'
      reason: string
      inactivityCount: number
      hookCount: number
    }
  | {
      type: 'lifecycle_hook_completed'
      hookName: 'onInactivity' | 'onExpiry' | 'onDisconnect'
      reason: string
      inactivityCount: number
      result: 'keep_alive' | 'end'
    }
  | {
      type: 'lifecycle_hook_failed'
      hookName: 'onInactivity' | 'onExpiry' | 'onDisconnect'
      reason: string
      inactivityCount: number
      errorName: string
      errorMessage: string
    }
  | {
      type: 'lifecycle_before_end_started'
      hookName: 'onInactivity' | 'onExpiry' | 'onDisconnect'
      reason: string
      inactivityCount: number
    }
  | {
      type: 'lifecycle_before_end_completed'
      hookName: 'onInactivity' | 'onExpiry' | 'onDisconnect'
      reason: string
      inactivityCount: number
    }
  | {
      type: 'lifecycle_before_end_failed'
      hookName: 'onInactivity' | 'onExpiry' | 'onDisconnect'
      reason: string
      inactivityCount: number
      errorName: string
      errorMessage: string
    }
  | {
      type: 'output_tool_completion_started'
      intendedToolName: string
      source: 'output_tool_completion'
      elapsedMs: number
      attempts?: number
    }
  | {
      type: 'output_tool_completion_succeeded'
      intendedToolName: string
      source: 'output_tool_completion'
      elapsedMs: number
      attempts?: number
    }
  | {
      type: 'output_tool_completion_failed'
      intendedToolName: string
      source: 'output_tool_completion'
      phase: 'trigger' | 'generation' | 'tool' | 'forced_tool' | 'timeout' | 'skipped'
      elapsedMs: number
      attempts?: number
      maxAttempts?: number
      incorrectToolName?: string
      forcedToolReason?: 'active_gate' | 'exhausted' | 'timeout' | 'generation_failed'
      errorName: string
      errorMessage: string
    }
  | {
      type: 'forced_tool_correction'
      intendedToolName: string
      incorrectToolName?: string
      attempts: number
      maxAttempts: number
      source: 'generate_reply' | 'output_tool_completion'
    }
  | {
      type: 'forced_tool_failure'
      intendedToolName: string
      incorrectToolName?: string
      attempts: number
      maxAttempts: number
      source: 'generate_reply' | 'output_tool_completion'
      error: unknown
    }
  | { type: 'voice_error'; error: unknown }

/**
 * Voice-specific hook that extends the standard ADK Hook with lifecycle callbacks. Use within
 * `voiceHandler({ hooks: [...] })` to handle both standard agent lifecycle events and
 * voice-specific lifecycle events in a single composable array.
 *
 * When multiple hooks define the same lifecycle callback, they run in order. If any hook returns
 * `false`, the session stays alive (any hook can veto the end). Return `true` to explicitly end the
 * session, or `void` for the default end behavior.
 */
export interface VoiceHook<S extends StateSchema = StateSchema> extends Hook<S> {
  /**
   * Fires for ephemeral voice-layer telemetry (state transitions, errors). Not persisted to
   * session.
   */
  onVoiceEvent?: (event: VoiceEvent) => void
  /**
   * Fires for each user or assistant transcript message. Runs in a dedicated queue — never blocks
   * the voice pipeline. State mutations are drained before session commit.
   */
  onTranscript?: (ctx: TranscriptHookContext<S>) => void | Promise<void>
  /**
   * Fires when an agent becomes active (initial entry and after transfer). If defined, replaces the
   * default auto-speak. Use `ctx.voice.generateReply()` to trigger speech.
   */
  onEnter?: (ctx: LifecycleHookContext<S>) => void | Promise<void>
  /**
   * Fires when inactivity timer triggers. Return `false` to keep the session alive, `true` to
   * explicitly end it.
   */
  onInactivity?: (ctx: LifecycleHookContext<S>) => LifecycleHookResult
  /**
   * Fires when session expiry is reached. Return `false` to keep the session alive, `true` to
   * explicitly end it.
   */
  onExpiry?: (ctx: LifecycleHookContext<S>) => LifecycleHookResult
  /**
   * Fires when the participant disconnects. Return `false` to keep the session alive for output
   * collection, `true` to explicitly end it.
   */
  onDisconnect?: (ctx: LifecycleHookContext<S>) => LifecycleHookResult
}

export interface VoiceHandlerConfig<S extends StateSchema = StateSchema> {
  agent: Runnable<S>
  appName: string
  schema?: S
  sessionService: SessionService
  setup?: (participant: VoiceParticipant) => SessionSetup<S> | Promise<SessionSetup<S>>
  sound?: SoundConfig
  recording?: RecordingConfig
  /**
   * By default, voice completion terminates the LiveKit room after final output and playout have
   * completed. Set to false only when the deployment owns hangup outside ADK.
   */
  callTermination?: false | CallTerminationConfig
  /**
   * Model adapters keyed by provider, as `adk({ adapters })` registers them. The voice runtime
   * resolves a realtime model of its own, but the sub-runner that executes inline sub-agents is an
   * ordinary text runner — without these it reaches for a real provider and fails on a missing key,
   * even when the app registered a scripted adapter.
   */
  adapters?: Partial<Record<Provider, ModelAdapter>>
  /** Voice hooks for both standard agent lifecycle and voice-specific lifecycle events. */
  hooks?: VoiceHook<S>[]
  errorHandlers?: ErrorHandler[]
  /**
   * Timeout configuration for inactivity and session expiry. Handler-level timeouts serve as
   * defaults; per-agent `timeouts` override them (e.g. after a transfer, the new agent's timeouts
   * take precedence).
   */
  timeouts?: AgentTimeouts
  /** Name to register with the LiveKit server. Defaults to the agent's name. */
  name?: string
  /**
   * Additional LiveKit worker options passed to ServerOptions (e.g. jobMemoryWarnMB,
   * numIdleProcesses).
   */
  worker?: Record<string, unknown>
  /**
   * Called once per worker subprocess before any job runs. Use for process-level initialisation
   * that must happen before the entrypoint (e.g. Sentry, OpenTelemetry, preloading heavy modules).
   * Maps to LiveKit's `prewarm` on the agent default export.
   */
  prewarm?: (proc: unknown) => void | Promise<void>
}

export interface VoiceHandlerHandle {
  /** The LiveKit agent entry function. Export this as the default export of your module. */
  entry: (ctx: unknown) => Promise<void>
  /** Per-subprocess prewarm function. Called by LiveKit before any job runs. */
  prewarm?: (proc: unknown) => void | Promise<void>
  /**
   * Start the LiveKit agent server.
   *
   * @param entryFile - Path to the module file that exports this handler as default. Use
   *   `fileURLToPath(import.meta.url)` or `__filename`.
   */
  start(entryFile: string): void
}
