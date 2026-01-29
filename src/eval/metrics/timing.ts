import type {
  Event,
  ModelStartEvent,
  ModelEndEvent,
  InvocationStartEvent,
  InvocationEndEvent,
  AssistantEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '../../types';
import type { Metric, MetricResult, CountAssertion } from './types';

export type TimingMeasure =
  | 'total_duration'
  | 'time_to_first_assistant'
  | 'time_to_first_tool_call'
  | 'model_latency_total'
  | 'model_latency_average'
  | 'tool_execution_total'
  | 'tool_execution_average';

export interface TimingMetricConfig {
  name: string;
  measure: TimingMeasure;
  assertion: CountAssertion;
}

function getTimestamp(event: Event): number | undefined {
  return (event as { timestamp?: number }).timestamp;
}

function findFirstEventOfType<T extends Event>(
  events: Event[],
  type: T['type'],
): T | undefined {
  return events.find((e) => e.type === type) as T | undefined;
}

function filterEventsByType<T extends Event>(
  events: Event[],
  type: T['type'],
): T[] {
  return events.filter((e) => e.type === type) as T[];
}

function computeTotalDuration(events: Event[]): number | undefined {
  const starts = filterEventsByType<InvocationStartEvent>(
    events,
    'invocation_start',
  );
  const ends = filterEventsByType<InvocationEndEvent>(events, 'invocation_end');

  if (starts.length === 0) return undefined;

  const firstStart = starts[0];
  const lastEnd = ends[ends.length - 1];

  const startTime = getTimestamp(firstStart);
  const endTime = lastEnd ? getTimestamp(lastEnd) : undefined;

  if (startTime === undefined) return undefined;
  if (endTime === undefined) return undefined;

  return endTime - startTime;
}

function computeTimeToFirstAssistant(events: Event[]): number | undefined {
  const firstStart = findFirstEventOfType<InvocationStartEvent>(
    events,
    'invocation_start',
  );
  const firstAssistant = findFirstEventOfType<AssistantEvent>(
    events,
    'assistant',
  );

  if (!firstStart || !firstAssistant) return undefined;

  const startTime = getTimestamp(firstStart);
  const assistantTime = getTimestamp(firstAssistant);

  if (startTime === undefined || assistantTime === undefined) return undefined;

  return assistantTime - startTime;
}

function computeTimeToFirstToolCall(events: Event[]): number | undefined {
  const firstStart = findFirstEventOfType<InvocationStartEvent>(
    events,
    'invocation_start',
  );
  const firstToolCall = findFirstEventOfType<ToolCallEvent>(
    events,
    'tool_call',
  );

  if (!firstStart || !firstToolCall) return undefined;

  const startTime = getTimestamp(firstStart);
  const toolCallTime = getTimestamp(firstToolCall);

  if (startTime === undefined || toolCallTime === undefined) return undefined;

  return toolCallTime - startTime;
}

function computeModelLatencies(events: Event[]): number[] {
  const latencies: number[] = [];
  const modelStarts = filterEventsByType<ModelStartEvent>(
    events,
    'model_start',
  );
  const modelEnds = filterEventsByType<ModelEndEvent>(events, 'model_end');

  for (let i = 0; i < Math.min(modelStarts.length, modelEnds.length); i++) {
    const start = modelStarts[i];
    const end = modelEnds[i];

    if (end?.durationMs !== undefined) {
      latencies.push(end.durationMs);
    } else {
      const startTime = getTimestamp(start);
      const endTime = getTimestamp(end);
      if (startTime !== undefined && endTime !== undefined) {
        latencies.push(endTime - startTime);
      }
    }
  }

  return latencies;
}

function computeToolExecutionTimes(events: Event[]): number[] {
  const times: number[] = [];
  const toolCalls = filterEventsByType<ToolCallEvent>(events, 'tool_call');
  const toolResults = filterEventsByType<ToolResultEvent>(
    events,
    'tool_result',
  );

  const resultByCallId = new Map<string, ToolResultEvent>();
  for (const result of toolResults) {
    resultByCallId.set(result.callId, result);
  }

  for (const call of toolCalls) {
    const result = resultByCallId.get(call.callId);
    if (!result) continue;

    const callTime = getTimestamp(call);
    const resultTime = getTimestamp(result);

    if (callTime !== undefined && resultTime !== undefined) {
      times.push(resultTime - callTime);
    }
  }

  return times;
}

function computeMeasure(
  events: Event[],
  measure: TimingMeasure,
): number | undefined {
  switch (measure) {
    case 'total_duration':
      return computeTotalDuration(events);

    case 'time_to_first_assistant':
      return computeTimeToFirstAssistant(events);

    case 'time_to_first_tool_call':
      return computeTimeToFirstToolCall(events);

    case 'model_latency_total': {
      const latencies = computeModelLatencies(events);
      return latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0)
        : undefined;
    }

    case 'model_latency_average': {
      const latencies = computeModelLatencies(events);
      return latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : undefined;
    }

    case 'tool_execution_total': {
      const times = computeToolExecutionTimes(events);
      return times.length > 0 ? times.reduce((a, b) => a + b, 0) : undefined;
    }

    case 'tool_execution_average': {
      const times = computeToolExecutionTimes(events);
      return times.length > 0
        ? times.reduce((a, b) => a + b, 0) / times.length
        : undefined;
    }
  }
}

export function timingMetric(config: TimingMetricConfig): Metric {
  return {
    name: config.name,
    evaluate: (events: Event[]): MetricResult => {
      const value = computeMeasure(events, config.measure);

      if (value === undefined) {
        return {
          passed: false,
          evidence: [
            `Could not compute ${config.measure} - missing timestamp data or no matching events`,
          ],
        };
      }

      const passed = config.assertion(value);

      return {
        passed,
        value,
        score: value,
        evidence: [`${config.measure}: ${value.toFixed(2)}ms`],
      };
    },
  };
}

export interface DurationMetricConfig {
  name: string;
  maxDurationMs: number;
}

export function durationMetric(config: DurationMetricConfig): Metric {
  return timingMetric({
    name: config.name,
    measure: 'total_duration',
    assertion: (duration) => duration <= config.maxDurationMs,
  });
}

export interface ModelLatencyMetricConfig {
  name: string;
  maxAverageMs: number;
}

export function modelLatencyMetric(config: ModelLatencyMetricConfig): Metric {
  return timingMetric({
    name: config.name,
    measure: 'model_latency_average',
    assertion: (avg) => avg <= config.maxAverageMs,
  });
}

export interface TimeToFirstResponseMetricConfig {
  name: string;
  maxMs: number;
}

export function timeToFirstResponseMetric(
  config: TimeToFirstResponseMetricConfig,
): Metric {
  return timingMetric({
    name: config.name,
    measure: 'time_to_first_assistant',
    assertion: (time) => time <= config.maxMs,
  });
}
