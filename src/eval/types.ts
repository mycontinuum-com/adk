import type { OutputSignal, EndSignal } from '../core/tools'
import type { Hook } from '../hook/types'
import type { SimulateOptions, Transform } from '../run/simulate'
import type { StateChanges } from '../session/seedState'
import type { Event } from '../types/events'
import type { FunctionTool, Runnable, Agent, HandoffOptions } from '../types/runnables'
import type { SubRunResult } from '../types/runnables'
import type { RunResult, TerminationReason, UsageSummary } from '../types/runtime'
import type { TypedState } from '../types/schema'
import type { StateSchema } from '../types/schema'
import type { VoiceSession } from '../voice/types'
import type { Metric, MetricRun, MetricResult } from './metrics/types'

export type { Metric, MetricRun, MetricResult }
export type { Transform, TerminationReason }

export interface EvalOptions<S extends StateSchema = StateSchema> {
  hooks?: Hook<any>[]
  metrics?: Metric<MetricRun<S>>[]
  concurrency?: number
  stopOnFirstFailure?: boolean
  repeat?: number
  onCase?: (result: EvalCaseResult<S>, index: number, total: number) => void
}

export interface MockToolContext<S extends StateSchema = StateSchema> {
  readonly callId: string
  readonly toolName: string
  readonly invocationId: string
  readonly state: TypedState<S>
  readonly voice?: VoiceSession
  readonly waitForPlayout?: () => Promise<void>
  now(): number
  output<V = unknown>(value: V): OutputSignal
  end(): EndSignal
  run<TOut>(
    agent: Agent<S, TOut>,
    inputOrOptions?: string | HandoffOptions,
  ): Promise<SubRunResult<TOut>>
  run(agent: Runnable<S>, inputOrOptions?: string | HandoffOptions): Promise<SubRunResult>
}

export interface ToolMock<S extends StateSchema = StateSchema> {
  execute: (args: unknown, ctx: MockToolContext<S>) => unknown | Promise<unknown>
}

export type ToolMocks<S extends StateSchema = StateSchema> = Record<
  string,
  ToolMock<S> | FunctionTool<any, any, any, any>
>

export type { StateChanges }

export interface EvalCase<S extends StateSchema = StateSchema> extends Pick<
  SimulateOptions,
  'input' | 'userAgent' | 'toolAgents' | 'transform' | 'maxTurns' | 'maxDuration' | 'stateMatches'
> {
  name: string
  description?: string
  runnable: Runnable<any>
  toolMocks?: ToolMocks<S>
  metrics?: Metric<MetricRun<S>>[]
  retries?: number
  timeout?: number
}

export type EvalStatus = 'passed' | 'failed' | 'error' | 'terminated' | 'aborted' | 'timeout'

export interface BaseEvalCaseResult {
  name: string
  status: EvalStatus
  metrics: Record<string, MetricResult>
  usage?: UsageSummary
  durationMs: number
  error?: { message: string; stack?: string }
  attempts?: number
  repeatIndex?: number
  repeatTotal?: number
}

export interface EvalCaseResult<S extends StateSchema = StateSchema> extends BaseEvalCaseResult {
  run: RunResult<S>
  events: readonly Event[]
  turns: number
  terminationReason?: TerminationReason
}

export interface EvalSummary {
  total: number
  passed: number
  failed: number
  errors: number
  terminated: number
  aborted: number
  timedOut: number
}

export interface BaseEvalResult<C extends BaseEvalCaseResult = BaseEvalCaseResult> {
  summary: EvalSummary
  results: C[]
  durationMs: number
}

export interface EvalResult<S extends StateSchema = StateSchema> extends BaseEvalResult<
  EvalCaseResult<S>
> {}

export const STATE_CHANGE_MARKER = Symbol.for('adk.eval.stateChange')

export interface StateChangeResult<T = unknown> {
  readonly [STATE_CHANGE_MARKER]: true
  result: T
  stateChanges: StateChanges
}

export function isStateChangeResult(value: unknown): value is StateChangeResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    STATE_CHANGE_MARKER in value &&
    (value as StateChangeResult)[STATE_CHANGE_MARKER] === true
  )
}

export function withStateChange<T>(result: T, stateChanges: StateChanges): StateChangeResult<T> {
  return {
    [STATE_CHANGE_MARKER]: true,
    result,
    stateChanges,
  }
}

export function unwrapStateChange<T>(value: T | StateChangeResult<T>): T {
  if (isStateChangeResult(value)) {
    return value.result
  }
  return value
}

export function collectStateChanges(results: unknown[]): StateChanges {
  const collected: StateChanges = {}

  for (const result of results) {
    if (!isStateChangeResult(result)) continue

    for (const scope of Object.keys(result.stateChanges) as (keyof StateChanges)[]) {
      const values = result.stateChanges[scope]
      if (values) {
        collected[scope] = { ...collected[scope], ...values }
      }
    }
  }

  return collected
}
