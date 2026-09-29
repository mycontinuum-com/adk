import type { Event } from '../types/events'
import type { MetricResult } from './metrics/types'
import type { VoiceRunResult } from './voice/types'

import { safeErrorFields } from '../errors/safe-error'

/** Creates a shallow JSON projection of known optional protocol fields. */
export function omitUndefinedProperties<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

/** State as a JSON session store keeps it: function-valued properties are dropped. */
function storedState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(storedState)
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => typeof item !== 'function')
      .map(([key, item]) => [key, storedState(item)]),
  )
}

/** Projects known ADK event envelopes before strict JSON validation. */
export function serializeEvent(event: Event): Record<string, unknown> {
  const projected = omitUndefinedProperties(event)
  if (event.type !== 'state_change') return projected
  return {
    ...projected,
    changes: event.changes.map((change) =>
      omitUndefinedProperties({
        ...change,
        oldValue: storedState(change.oldValue),
        newValue: storedState(change.newValue),
      }),
    ),
  }
}

export function voiceEvidence(run: VoiceRunResult) {
  return {
    sessionId: run.session.id,
    sessionEvents: run.session.events.map(serializeEvent),
    ...(run.liveTranscript === undefined ? {} : { liveTranscript: run.liveTranscript }),
    ...(run.callerHeard === undefined ? {} : { callerHeard: run.callerHeard }),
    ...(run.liveUsage === undefined ? {} : { liveUsage: run.liveUsage }),
    events: run.events.map(serializeEvent),
    // An error a voice event carries (a forced-tool failure, a voice error) is kept as its safe fields.
    voiceEvents: run.voiceEvents.map((event) =>
      omitUndefinedProperties(
        'error' in event ? { ...event, error: safeErrorFields(event.error) } : event,
      ),
    ),
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
    throw new Error(`Evaluation evidence contains a non-finite number at ${path}`)
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`Evaluation evidence cannot contain ${typeof value} at ${path}`)
  }
  if (!value || typeof value !== 'object') return
  if (ancestors.has(value))
    throw new Error(`Evaluation evidence contains a circular reference at ${path}`)
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Evaluation evidence must contain plain JSON objects at ${path}`)
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
