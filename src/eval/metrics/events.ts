import type { Event, EventType, ToolCallEvent } from '../../types';
import type {
  Metric,
  MetricResult,
  EventFilter,
  CountAssertion,
} from './types';

export interface EventCountMetricConfig {
  name: string;
  eventType?: EventType;
  filter?: EventFilter;
  assertion: CountAssertion;
}

export function eventCountMetric(config: EventCountMetricConfig): Metric {
  return {
    name: config.name,
    evaluate: (events: Event[]): MetricResult => {
      let filtered = events;

      if (config.eventType) {
        filtered = filtered.filter((e) => e.type === config.eventType);
      }

      if (config.filter) {
        filtered = filtered.filter(config.filter);
      }

      const count = filtered.length;
      const passed = config.assertion(count);

      return {
        passed,
        value: count,
        score: count,
        evidence: [`Found ${count} matching events`],
      };
    },
  };
}

export interface ToolCallCountMetricConfig {
  name: string;
  toolName: string;
  assertion: CountAssertion;
}

export function toolCallCountMetric(config: ToolCallCountMetricConfig): Metric {
  return eventCountMetric({
    name: config.name,
    eventType: 'tool_call',
    filter: (e) => (e as ToolCallEvent).name === config.toolName,
    assertion: config.assertion,
  });
}

export interface EventSequenceMetricConfig {
  name: string;
  sequence: Array<{
    eventType: EventType;
    filter?: EventFilter;
  }>;
}

export function eventSequenceMetric(config: EventSequenceMetricConfig): Metric {
  return {
    name: config.name,
    evaluate: (events: Event[]): MetricResult => {
      let sequenceIndex = 0;
      const matchedEvents: Event[] = [];

      for (const event of events) {
        if (sequenceIndex >= config.sequence.length) break;

        const expected = config.sequence[sequenceIndex];
        if (event.type !== expected.eventType) continue;
        if (expected.filter && !expected.filter(event)) continue;

        matchedEvents.push(event);
        sequenceIndex++;
      }

      const passed = sequenceIndex === config.sequence.length;

      return {
        passed,
        value: matchedEvents.length,
        evidence: [
          passed
            ? `Found all ${config.sequence.length} events in sequence`
            : `Found ${matchedEvents.length} of ${config.sequence.length} events in sequence`,
        ],
      };
    },
  };
}
