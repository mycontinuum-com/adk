import type { Metric, MetricResult } from '../metrics/types'
import type { VoiceRunResult } from './types'

export type VoiceTimingMeasure =
  | 'time_to_first_speech'
  | 'response_latency_p50'
  | 'response_latency_p95'
  | 'response_latency_max'
  | 'silence_gap_max'
  | 'silence_gap_total'
  | 'interruption_count'

export interface VoiceTimingMetricConfig {
  name: string
  measure: VoiceTimingMeasure
  assertion: (value: number) => boolean
}

export function voiceTimingMetric(config: VoiceTimingMetricConfig): Metric<VoiceRunResult> {
  return {
    name: config.name,
    evaluate: (run: VoiceRunResult): MetricResult => {
      const value = computeMeasure(run, config.measure)

      if (value === undefined) {
        return {
          passed: false,
          evidence: [`Could not compute ${config.measure} — missing timing data`],
        }
      }

      const passed = config.assertion(value)
      return {
        passed,
        evidence: [`${config.measure}: ${value.toFixed(2)}ms`],
      }
    },
  }
}

function computeMeasure(run: VoiceRunResult, measure: VoiceTimingMeasure): number | undefined {
  const t = run.timing
  const agentResponseTimes = t.responseTimes.filter((r) => r.speaker === 'agent' || !r.speaker)

  switch (measure) {
    case 'time_to_first_speech':
      return t.timeToFirstSpeechMs

    case 'response_latency_p50':
      return percentile(
        agentResponseTimes.map((r) => r.ms),
        0.5,
      )

    case 'response_latency_p95':
      return percentile(
        agentResponseTimes.map((r) => r.ms),
        0.95,
      )

    case 'response_latency_max':
      return agentResponseTimes.length > 0
        ? Math.max(...agentResponseTimes.map((r) => r.ms))
        : undefined

    case 'silence_gap_max':
      return t.silenceGaps.length > 0 ? Math.max(...t.silenceGaps.map((g) => g.ms)) : undefined

    case 'silence_gap_total':
      return t.silenceGaps.length > 0 ? t.silenceGaps.reduce((sum, g) => sum + g.ms, 0) : undefined

    case 'interruption_count':
      return t.interruptions.count
  }
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].toSorted((a, b) => a - b)
  const index = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, index)]
}
