import type {
  Event,
  FunctionTool,
  Runnable,
  Session,
  ScopedStateChanges,
  StateAccessorWithScopes,
} from '../types';

export interface MockToolContext {
  readonly callId: string;
  readonly toolName: string;
  readonly invocationId: string;
  readonly state: StateAccessorWithScopes;
  now(): number;
}

export interface ToolMock {
  execute: (args: unknown, ctx: MockToolContext) => unknown | Promise<unknown>;
}

export type ToolMocks = Record<string, ToolMock | FunctionTool>;

export interface YieldInfo {
  type: 'loop' | 'tool';
  invocationId: string;
  awaitingInput?: boolean;
  toolName?: string;
  callId?: string;
  args?: unknown;
}

export interface StateChanges {
  session?: Record<string, unknown>;
  user?: Record<string, unknown>;
  patient?: Record<string, unknown>;
  practice?: Record<string, unknown>;
}

export interface Bridge {
  formatPrompt?: (
    mainSession: Session,
    yieldInfo: YieldInfo,
  ) => string | Promise<string>;

  formatResponse?: (
    output: unknown,
    userAgentSession: Session,
    yieldInfo: YieldInfo,
  ) => unknown | Promise<unknown>;
}

export interface UserAgents {
  loop?: Runnable;
  tools?: Record<string, Runnable>;
}


export interface TerminateWhen {
  maxTurns?: number;
  maxDuration?: number;
  stateMatches?: Record<string, unknown>;
}

export interface Metric {
  name: string;
  evaluate: (events: Event[]) => MetricResult | Promise<MetricResult>;
}

export interface MetricResult {
  passed: boolean;
  score?: number;
  value?: unknown;
  evidence?: string[];
}

export interface EvalCase {
  name: string;
  description?: string;
  runnable: Runnable;
  toolMocks?: ToolMocks;
  userAgents: UserAgents;
  bridge?: Bridge;
  initialState?: ScopedStateChanges;
  firstMessage?: string;
  terminateWhen?: TerminateWhen;
  metrics?: Metric[];
}

export type EvalStatus = 'passed' | 'failed' | 'error' | 'terminated';

export interface EvalError {
  phase: 'system' | 'userAgent' | 'metric';
  message: string;
  stack?: string;
}

export type TerminationReason = 'maxTurns' | 'maxDuration' | 'stateMatches';

export interface EvalResult {
  name: string;
  status: EvalStatus;
  metrics: Record<string, MetricResult>;
  events: Event[];
  durationMs: number;
  turns: number;
  tokenUsage?: { input: number; output: number };
  error?: EvalError;
  terminationReason?: TerminationReason;
}

export interface EvalSuiteConfig {
  cases: EvalCase[];
  parallel?: boolean;
  stopOnFirstFailure?: boolean;
}

export interface EvalSuiteSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  terminated: number;
}

export interface EvalSuiteResult {
  summary: EvalSuiteSummary;
  results: EvalResult[];
  durationMs: number;
}

export const STATE_CHANGE_MARKER = Symbol.for('adk.eval.stateChange');

export interface StateChangeResult<T = unknown> {
  readonly [STATE_CHANGE_MARKER]: true;
  result: T;
  stateChanges: StateChanges;
}

export function isStateChangeResult(
  value: unknown,
): value is StateChangeResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    STATE_CHANGE_MARKER in value &&
    (value as StateChangeResult)[STATE_CHANGE_MARKER] === true
  );
}
