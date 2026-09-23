import type { Event } from '../types/events'
import type { MetricResult } from './metrics/types'
import type { VoiceRunResult } from './voice/types'

/** Creates a shallow JSON projection of known optional protocol fields. */
export function omitUndefinedProperties<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

/** Projects known ADK event envelopes before strict JSON validation. */
export function serializeEvent(event: Event): Record<string, unknown> {
  const projected = omitUndefinedProperties(event)
  if (event.type !== 'state_change') return projected
  return {
    ...projected,
    changes: event.changes.map(omitUndefinedProperties),
  }
}

export function voiceEvidence(run: VoiceRunResult) {
  return {
    events: run.events.map(serializeEvent),
    voiceEvents: run.voiceEvents.map(omitUndefinedProperties),
    transcript: run.transcript.map(omitUndefinedProperties),
    timing: omitUndefinedProperties({
      ...run.timing,
      responseTimes: run.timing.responseTimes.map(omitUndefinedProperties),
      silenceGaps: run.timing.silenceGaps.map(omitUndefinedProperties),
    }),
    recording: run.recording,
  }
}

function validateEvidence(value: unknown, ancestors: Set<object>, path: string): void {
  if (value === undefined) {
    throw new Error(`Evaluation evidence cannot contain undefined at ${path}`)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Evaluation evidence contains a non-finite number')
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`Evaluation evidence cannot contain ${typeof value}`)
  }
  if (!value || typeof value !== 'object') return
  if (ancestors.has(value)) throw new Error('Evaluation evidence contains a circular reference')
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Evaluation evidence must contain plain JSON objects')
    }
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      validateEvidence(value[index], ancestors, `${path}[${index}]`)
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      validateEvidence(child, ancestors, `${path}.${key}`)
    }
  }
  ancestors.delete(value)
}

/** Serializes evidence after rejecting values JSON would otherwise coerce or lose. */
export function stringifyEvidence(value: unknown): string {
  const ancestors = new Set<object>()
  validateEvidence(value, ancestors, '$')
  return JSON.stringify(value, null, 2)
}

/** Fails before metric data crosses a voice-worker JSON IPC boundary. */
export function assertJsonMetrics(metrics: Record<string, MetricResult>): void {
  stringifyEvidence(metrics)
}
