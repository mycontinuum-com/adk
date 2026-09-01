import type { Event, StateScope } from '../../types/events'
import type { Metric, MetricRun, MetricResult, StateAssertion } from './types'

export interface StateMetricConfig<T = unknown> {
  name: string
  scope: StateScope
  key: string
  assertion: StateAssertion<T>
}

function computeFinalStateValue(events: Event[], scope: StateScope, key: string): unknown {
  let value: unknown

  for (const event of events) {
    if (event.type === 'state_change') {
      if (event.scope === scope) {
        for (const change of event.changes) {
          if (change.key === key) {
            value = change.newValue
          }
        }
      }
    }
  }

  return value
}

export function stateMetric<T = unknown>(config: StateMetricConfig<T>): Metric {
  return {
    name: config.name,
    evaluate: (run: MetricRun): MetricResult => {
      const events = [...run.session.events]
      const value = computeFinalStateValue(events, config.scope, config.key)
      const passed = config.assertion(value as T | undefined)

      return {
        passed,
        evidence: [`Final value of ${config.scope}.${config.key}: ${JSON.stringify(value)}`],
      }
    },
  }
}
