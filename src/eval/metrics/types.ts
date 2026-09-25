import type { Event, EventType, EventMap } from '../../types/events'
import type { UsageSummary } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'

/** Minimal run shape shared by text and voice metrics. */
export type MetricRun<S extends StateSchema = StateSchema> = {
  session: Session<S>
  /** Optional observed-event view; session.events retains durable ledger order. */
  events?: readonly Event[]
}

export interface Metric<TRun = MetricRun> {
  name: string
  evaluate: (run: TRun) => MetricResult | Promise<MetricResult>
}

export interface MetricResult {
  passed: boolean
  score?: number
  evidence?: string[]
  data?: Record<string, unknown>
  /** Model usage the metric itself spent, such as a judge call. The report shows it as `judge`. */
  usage?: UsageSummary
  /** Set when the metric could not produce a verdict. The case's status becomes `error`. */
  error?: string
}

export type EventFilter<T extends EventType = EventType> = (event: EventMap[T]) => boolean

export type StateAssertion<T = unknown> = (value: T | undefined) => boolean

export type CountAssertion = (count: number) => boolean

export type NumberAssertion = (value: number) => boolean
