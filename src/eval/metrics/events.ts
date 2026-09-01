import type { Event, EventType, EventMap } from '../../types/events'
import type { Metric, MetricRun, MetricResult, EventFilter, CountAssertion } from './types'

export interface EventCountMetricConfig<T extends EventType = EventType> {
  name: string
  eventType?: T
  filter?: EventFilter<T>
  assertion: CountAssertion
}

export function eventCountMetric<T extends EventType = EventType>(
  config: EventCountMetricConfig<T>,
): Metric {
  return {
    name: config.name,
    evaluate: (run: MetricRun): MetricResult => {
      const events = [...run.session.events]

      const count = events.filter((e) => {
        if (config.eventType && e.type !== config.eventType) return false
        if (config.filter && !(config.filter as EventFilter)(e)) return false
        return true
      }).length

      const passed = config.assertion(count)

      return {
        passed,
        evidence: [`Found ${count} matching events`],
      }
    },
  }
}

export type EventSequenceStep = {
  [T in EventType]: { eventType: T; filter?: (event: EventMap[T]) => boolean }
}[EventType]

export interface EventSequenceMetricConfig {
  name: string
  sequence: EventSequenceStep[]
}

function matchesSequenceStep(event: Event, step: EventSequenceStep): boolean {
  if (event.type !== step.eventType) return false
  if (!step.filter) return true
  return (step as { filter: (event: Event) => boolean }).filter(event)
}

export function eventSequenceMetric(config: EventSequenceMetricConfig): Metric {
  return {
    name: config.name,
    evaluate: (run: MetricRun): MetricResult => {
      const events = [...run.session.events]
      let sequenceIndex = 0
      const matchedEvents: Event[] = []

      for (const event of events) {
        if (sequenceIndex >= config.sequence.length) break

        if (!matchesSequenceStep(event, config.sequence[sequenceIndex])) continue

        matchedEvents.push(event)
        sequenceIndex++
      }

      const passed = sequenceIndex === config.sequence.length

      return {
        passed,
        evidence: [
          passed
            ? `Found all ${config.sequence.length} events in sequence`
            : `Found ${matchedEvents.length} of ${config.sequence.length} events in sequence`,
        ],
      }
    },
  }
}
