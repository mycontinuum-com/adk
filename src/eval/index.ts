export { runEval, runEvalSuite, type RunEvalOptions } from './simulator';

export { EvalRunner, createEvalRunner, type EvalRunnerConfig } from './runner';

export {
  evalConversationLogger,
  type EvalLoggerOptions,
  type LogLevel,
} from './logger';

export { EvalSessionService } from './session';

export {
  withStateChange,
  unwrapStateChange,
  collectStateChanges,
  createBridge,
  defaultBridge,
  defaultFormatPrompt,
  defaultFormatResponse,
} from './bridge';

export {
  EvalToolError,
  EvalUserAgentError,
  EvalTerminatedError,
} from './errors';

export {
  stateMetric,
  eventCountMetric,
  toolCallCountMetric,
  eventSequenceMetric,
  llmJudge,
  timingMetric,
  durationMetric,
  modelLatencyMetric,
  timeToFirstResponseMetric,
} from './metrics';

export type {
  Metric,
  MetricResult,
  EventFilter,
  StateAssertion,
  CountAssertion,
} from './metrics';
export type { StateMetricConfig } from './metrics/state';
export type {
  EventCountMetricConfig,
  ToolCallCountMetricConfig,
  EventSequenceMetricConfig,
} from './metrics/events';
export type { LlmJudgeConfig } from './metrics/judge';
export type {
  TimingMeasure,
  TimingMetricConfig,
  DurationMetricConfig,
  ModelLatencyMetricConfig,
  TimeToFirstResponseMetricConfig,
} from './metrics/timing';

export type {
  EvalCase,
  EvalResult,
  EvalStatus,
  EvalError,
  EvalSuiteConfig,
  EvalSuiteResult,
  EvalSuiteSummary,
  ToolMock,
  ToolMocks,
  MockToolContext,
  Bridge,
  UserAgents,
  YieldInfo,
  StateChanges,
  StateChangeResult,
  TerminateWhen,
  TerminationReason,
} from './types';

export { STATE_CHANGE_MARKER, isStateChangeResult } from './types';
