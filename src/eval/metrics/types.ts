import type { EventType, EventMap } from '../../types/events'
import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'

/** Minimal run shape shared by text and voice metrics. */
export type MetricRun<S extends StateSchema = StateSchema> = { session: Session<S> }

export interface Metric<TRun = MetricRun> {
  name: string
  evaluate: (run: TRun) => MetricResult | Promise<MetricResult>
}

export interface MetricResult {
  passed: boolean
  score?: number
  evidence?: string[]
  data?: Record<string, unknown>
}

export type EventFilter<T extends EventType = EventType> = (event: EventMap[T]) => boolean

export type StateAssertion<T = unknown> = (value: T | undefined) => boolean

export type CountAssertion = (count: number) => boolean

export type NumberAssertion = (value: number) => boolean
