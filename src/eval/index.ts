export type { ReportOptions } from './report'

export { interceptTools, type InterceptToolsOptions } from './interceptTools'

export { evalConversationLogger, type EvalLoggerOptions, type LogLevel } from './logger'

export { EvalToolError } from './errors'

export {
  stateMetric,
  eventCountMetric,
  eventSequenceMetric,
  timingMetric,
  codingDeltaMetric,
} from './metrics'

export type {
  Metric,
  MetricRun,
  MetricResult,
  EventFilter,
  StateAssertion,
  CountAssertion,
  NumberAssertion,
  CodingDelta,
  CodingDeltaMetric,
  CodingDeltaMetricConfig,
} from './metrics'
export type { StateMetricConfig } from './metrics/state'
export type {
  EventCountMetricConfig,
  EventSequenceMetricConfig,
  EventSequenceStep,
} from './metrics/events'
export type { TimingMeasure, TimingMetricConfig } from './metrics/timing'

export type {
  BaseEvalCaseResult,
  BaseEvalResult,
  EvalCase,
  EvalOptions,
  EvalCaseResult,
  EvalStatus,
  EvalResult,
  EvalSummary,
  ToolMock,
  ToolMocks,
  MockToolContext,
  Transform,
  TerminationReason,
  StateChanges,
  StateChangeResult,
} from './types'

export {
  STATE_CHANGE_MARKER,
  isStateChangeResult,
  withStateChange,
  unwrapStateChange,
  collectStateChanges,
} from './types'

// Voice eval
export { evaluateVoice, voiceTimingMetric, createSpeakerTracker } from './voice'

export type {
  VoiceEvalCase,
  VoiceEvalCaseFactory,
  VoiceEvalControl,
  VoiceEvalControlDisconnectMode,
  VoiceEvalControlDisconnectOptions,
  VoiceRoomConfig,
  VoiceEvalOptions,
  VoiceTiming,
  TimingEntry,
  TranscriptEntry,
  VoiceRunStatus,
  VoiceRunResult,
  VoiceEvalCaseResult,
  VoiceEvalResult,
  VoiceTimingMeasure,
  VoiceTimingMetricConfig,
} from './voice'
