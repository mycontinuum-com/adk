import type { Correction } from '../parser'
import type { Runnable } from './runnables'

export type MediaSource =
  | { type: 'base64'; mimeType: string; data: string }
  | { type: 'url'; url: string }

export type MediaPart =
  | { type: 'image'; source: MediaSource }
  | { type: 'audio'; source: MediaSource }
  | { type: 'document'; source: MediaSource }

export type EventType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'assistant_delta'
  | 'thought'
  | 'thought_delta'
  | 'tool_call'
  | 'tool_yield'
  | 'tool_input'
  | 'tool_result'
  | 'state_change'
  | 'invocation_start'
  | 'invocation_end'
  | 'invocation_yield'
  | 'invocation_resume'
  | 'model_start'
  | 'model_end'
  | 'artifact_update'
  | 'annotation'

export type InvocationEndReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'transferred'
  | 'max_steps'
  | 'max_turns'
  | 'disconnected'
  | 'participant_left'
  | 'inactivity_timeout'
  | 'max_duration'

export type InvocationOutcome = InvocationEndReason | 'yielded'

export type SharedScope = 'user' | 'patient' | 'practice' | 'org' | 'team'
export type StateScope = 'session' | SharedScope | 'temp'

export interface ProviderContext {
  provider: string
  data: unknown
}

export interface EventBase {
  id: string
  type: EventType
  createdAt: number
  invocationId: string
  agentName: string
  providerContext?: ProviderContext
}

interface TextEvent<T extends EventType> extends EventBase {
  type: T
  text: string
}

export interface PartialOutputState {
  value: unknown
  complete: boolean
  corrections: Correction[]
}

export interface ParsedOutput {
  value: unknown
  corrections: Correction[]
  totalScore: number
}

export type SystemEvent = TextEvent<'system'>
export type UserEvent = Omit<EventBase, 'invocationId' | 'agentName'> & {
  type: 'user'
  text: string
  media?: MediaPart[]
  invocationId?: string
  agentName?: string
  /**
   * 'text' (default) = model received text. 'transcript' = text derived from audio via realtime
   * model transcription.
   */
  source?: 'text' | 'transcript'
}
export type AssistantEvent = TextEvent<'assistant'> & {
  output?: ParsedOutput
  media?: MediaPart[]
  /**
   * 'text' (default) = model produced text. 'transcript' = text derived from audio via realtime
   * model transcription.
   */
  source?: 'text' | 'transcript'
}
export type ThoughtEvent = TextEvent<'thought'>

export interface ToolCallEvent extends EventBase {
  type: 'tool_call'
  callId: string
  name: string
  args: Record<string, unknown>
  yields?: boolean
}

export interface ToolYieldEvent extends EventBase {
  type: 'tool_yield'
  callId: string
  name: string
  args: unknown
}

export interface ToolInputEvent extends Omit<EventBase, 'invocationId' | 'agentName'> {
  type: 'tool_input'
  callId: string
  name: string
  input: unknown
  invocationId?: string
  agentName?: string
}

export type ToolResultEventBase = Pick<
  ToolResultEvent,
  'id' | 'type' | 'createdAt' | 'callId' | 'name' | 'providerContext' | 'invocationId' | 'agentName'
>

export interface ToolResultEvent extends EventBase {
  type: 'tool_result'
  callId: string
  name: string
  result?: unknown
  media?: MediaPart[]
  error?: string
  durationMs?: number
  retryCount?: number
  timedOut?: boolean
  /** When true, this tool result is the invocation's explicit output (set via ctx.output()). */
  output?: boolean
}

export type StateChangeSource = 'observation' | 'mutation' | 'direct'

export type StateChangeEvent = Omit<EventBase, 'invocationId' | 'agentName'> & {
  type: 'state_change'
  scope: StateScope
  source: StateChangeSource
  invocationId?: string
  agentName?: string
  changes: Array<{
    key: string
    oldValue: unknown
    newValue: unknown
  }>
}

export type InvocationKind = 'agent' | 'step' | 'sequence' | 'parallel' | 'loop'

interface InvocationEventFields {
  agentName: string
  parentInvocationId?: string
}

export type HandoffOrigin =
  | { type: 'run'; invocationId: string; callId?: string }
  /** @deprecated Use `'run'`. Kept for backward compatibility with persisted sessions. */
  | { type: 'call'; invocationId: string; callId?: string }
  | { type: 'spawn'; invocationId: string; callId?: string }
  | { type: 'dispatch'; invocationId: string; callId?: string }
  | { type: 'transfer'; invocationId: string; agentName?: string }

export interface InvocationStartEvent extends EventBase, InvocationEventFields {
  type: 'invocation_start'
  invocationId: string
  kind: InvocationKind
  handoffOrigin?: HandoffOrigin
  fingerprint?: string
  version?: number
}

export interface HandoffTarget {
  invocationId: string
  agentName: string
}

export interface InvocationEndEvent extends EventBase, InvocationEventFields {
  type: 'invocation_end'
  invocationId: string
  kind?: InvocationKind
  reason: InvocationEndReason
  iterations?: number
  error?: string
  handoffTarget?: HandoffTarget
}

export interface InvocationYieldEvent extends EventBase, InvocationEventFields {
  type: 'invocation_yield'
  invocationId: string
  yieldedToolIds: string[]
  yieldIndex: number
  awaitingInput?: boolean
}

export interface InvocationResumeEvent extends EventBase, InvocationEventFields {
  type: 'invocation_resume'
  invocationId: string
  yieldIndex: number
}

export interface ContextMessageSummary {
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'thought'
  content: string
}

export interface ContextToolSummary {
  name: string
  description: string
}

export interface ModelStartEvent extends EventBase {
  type: 'model_start'
  stepIndex: number
  messageCount: number
  tools: ContextToolSummary[]
  outputSchema?: string
}

export interface ModelUsage {
  modelName?: string
  inputTokens: number
  cachedTokens?: number
  /** Input tokens written to a provider prompt cache. */
  cacheWriteTokens?: number
  reasoningTokens?: number
  outputTokens: number
  /** Audio input tokens — from realtime model metrics. Omitted for text-mode agents. */
  audioInputTokens?: number
  /** Audio output tokens — from realtime model metrics. Omitted for text-mode agents. */
  audioOutputTokens?: number
  /** Cached audio input tokens — repeated context the provider doesn't reprocess. */
  audioCachedTokens?: number
}

export interface ModelEndEvent extends EventBase {
  type: 'model_end'
  stepIndex: number
  durationMs: number
  usage?: ModelUsage
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'
  error?: string
}

/**
 * Generic annotation event — phase markers, log messages, and checkpoints emitted via ctx.note().
 * This is the only new event kind added for workflow orchestration; it is general-purpose and
 * usable outside workflows.
 */
export interface AnnotationEvent extends EventBase {
  type: 'annotation'
  /** The kind of annotation. Defaults to 'log' when not specified. */
  kind: 'phase' | 'log' | 'mark'
  /** Optional label, e.g. a phase title. */
  label?: string
  /** Optional human-readable message. */
  message?: string
  /** Optional structured data payload. */
  data?: Record<string, unknown>
}

/**
 * Event emitted when an artifact is updated. Flows through gw.subscribe() alongside other stream
 * events. Artifacts are versioned binary blobs with MIME types.
 */
export interface ArtifactUpdateEvent extends Omit<EventBase, 'invocationId' | 'agentName'> {
  type: 'artifact_update'
  /** Artifact name that was updated. */
  name: string
  /** New version number (immutable, 0-indexed). */
  version: number
  /** MIME type of the new version. */
  mimeType: string
  /** Process that owns this artifact. */
  processId: string
  /** Optional invocation context. */
  invocationId?: string
  agentName?: string
}

export type Event =
  | SystemEvent
  | UserEvent
  | AssistantEvent
  | ThoughtEvent
  | ToolCallEvent
  | ToolYieldEvent
  | ToolInputEvent
  | ToolResultEvent
  | StateChangeEvent
  | InvocationStartEvent
  | InvocationEndEvent
  | InvocationYieldEvent
  | InvocationResumeEvent
  | ModelStartEvent
  | ModelEndEvent
  | ArtifactUpdateEvent
  | AnnotationEvent

export interface EventMap {
  system: SystemEvent
  user: UserEvent
  assistant: AssistantEvent
  assistant_delta: AssistantDeltaEvent
  thought: ThoughtEvent
  thought_delta: ThoughtDeltaEvent
  tool_call: ToolCallEvent
  tool_yield: ToolYieldEvent
  tool_input: ToolInputEvent
  tool_result: ToolResultEvent
  state_change: StateChangeEvent
  invocation_start: InvocationStartEvent
  invocation_end: InvocationEndEvent
  invocation_yield: InvocationYieldEvent
  invocation_resume: InvocationResumeEvent
  model_start: ModelStartEvent
  model_end: ModelEndEvent
  artifact_update: ArtifactUpdateEvent
  annotation: AnnotationEvent
}

interface DeltaEvent<T extends 'thought_delta' | 'assistant_delta'> extends EventBase {
  type: T
  delta: string
  text: string
}

export type ThoughtDeltaEvent = DeltaEvent<'thought_delta'>
export type AssistantDeltaEvent = DeltaEvent<'assistant_delta'> & {
  partial?: PartialOutputState
}

export type StreamEvent =
  | SystemEvent
  | UserEvent
  | ThoughtEvent
  | ThoughtDeltaEvent
  | AssistantEvent
  | AssistantDeltaEvent
  | ToolCallEvent
  | ToolYieldEvent
  | ToolInputEvent
  | ToolResultEvent
  | StateChangeEvent
  | InvocationStartEvent
  | InvocationEndEvent
  | InvocationYieldEvent
  | InvocationResumeEvent
  | ModelStartEvent
  | ModelEndEvent
  | ArtifactUpdateEvent
  | AnnotationEvent

export function isSystemEvent(e: Event | StreamEvent): e is SystemEvent {
  return e.type === 'system'
}
export function isUserEvent(e: Event | StreamEvent): e is UserEvent {
  return e.type === 'user'
}
export function isAssistantEvent(e: Event | StreamEvent): e is AssistantEvent {
  return e.type === 'assistant'
}
export function isThoughtEvent(e: Event | StreamEvent): e is ThoughtEvent {
  return e.type === 'thought'
}
export function isToolCallEvent(e: Event | StreamEvent): e is ToolCallEvent {
  return e.type === 'tool_call'
}
export function isToolYieldEvent(e: Event | StreamEvent): e is ToolYieldEvent {
  return e.type === 'tool_yield'
}
export function isToolInputEvent(e: Event | StreamEvent): e is ToolInputEvent {
  return e.type === 'tool_input'
}
export function isToolResultEvent(e: Event | StreamEvent): e is ToolResultEvent {
  return e.type === 'tool_result'
}
export function isStateChangeEvent(e: Event | StreamEvent): e is StateChangeEvent {
  return e.type === 'state_change'
}
export function isInvocationStartEvent(e: Event | StreamEvent): e is InvocationStartEvent {
  return e.type === 'invocation_start'
}
export function isInvocationEndEvent(e: Event | StreamEvent): e is InvocationEndEvent {
  return e.type === 'invocation_end'
}
export function isInvocationYieldEvent(e: Event | StreamEvent): e is InvocationYieldEvent {
  return e.type === 'invocation_yield'
}
export function isInvocationResumeEvent(e: Event | StreamEvent): e is InvocationResumeEvent {
  return e.type === 'invocation_resume'
}
export function isModelStartEvent(e: Event | StreamEvent): e is ModelStartEvent {
  return e.type === 'model_start'
}
export function isModelEndEvent(e: Event | StreamEvent): e is ModelEndEvent {
  return e.type === 'model_end'
}
export function isArtifactUpdateEvent(e: Event | StreamEvent): e is ArtifactUpdateEvent {
  return e.type === 'artifact_update'
}

export function isAnnotationEvent(e: Event | StreamEvent): e is AnnotationEvent {
  return e.type === 'annotation'
}

export interface ErrorContext {
  invocationId: string
  agent: Runnable
  phase: 'model' | 'tool' | 'callback' | 'render'
  attempt: number
  error: Error
  toolName?: string
  callId?: string
  invocationStack?: string[]
  timestamp: number
}
