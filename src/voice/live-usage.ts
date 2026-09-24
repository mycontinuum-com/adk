import type { Event, ModelUsage } from '../types/events'
import type { LiveVoiceSessionUsage } from './live-types'

import { calculateSessionCost } from '../providers/pricing'

interface Connection {
  milliseconds: number
  reported: boolean
  closed: boolean
}

/**
 * Meters GPT Live session time. The LiveKit plugin turns each cumulative `usage.seconds` update
 * into a `realtime_model_metrics` delta and restarts the cumulative count on reconnect, so the sum
 * of deltas equals the latest value of every provider connection. Usage is `reported` only when
 * every known connection ended with `session.closed`, which carries its final value. Otherwise the
 * larger of reported and wall-clock connection time is `estimated`.
 */
export class LiveVoiceMeter {
  private readonly connections = new Map<string, Connection>()
  private startedAt: number | undefined
  private stoppedAt: number | undefined

  constructor(
    private readonly modelName: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Marks the start of the voice connection for the wall-clock fallback. */
  start(): void {
    this.startedAt ??= this.now()
  }

  /** Marks the end of the voice connection for the wall-clock fallback. */
  stop(): void {
    if (this.startedAt !== undefined) this.stoppedAt ??= this.now()
  }

  /** Registers a provider connection that must report its usage. */
  observeConnection(connectionId: string): void {
    this.connection(connectionId)
  }

  /** Observes a LiveKit `metrics_collected` payload; other metric types are ignored. */
  observeMetrics(metrics: unknown): void {
    if (!isRealtimeMetrics(metrics)) return
    const deltaMs = metrics.sessionDurationMs
    if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0) return
    const entry = this.connection(typeof metrics.requestId === 'string' ? metrics.requestId : '')
    entry.milliseconds += deltaMs
    entry.reported = true
  }

  /** Observes a raw GPT Live server event on the given provider connection. */
  observeServerEvent(event: unknown, connectionId: string | undefined): void {
    if (!isRecord(event)) return
    if (event.type === 'session.started') {
      const id = isRecord(event.session) ? event.session.id : undefined
      this.connection(typeof id === 'string' ? id : (connectionId ?? ''))
    } else if (event.type === 'session.closed') this.connection(connectionId ?? '').closed = true
  }

  /** Session seconds and their cost; `unavailable` when neither usage nor connection time is known. */
  usage(): LiveVoiceSessionUsage {
    const measured = this.seconds()
    if (!measured) return { modelName: this.modelName, cost: { basis: 'unavailable' } }
    const totalCost = calculateSessionCost(this.modelName, measured.seconds)
    return {
      modelName: this.modelName,
      seconds: measured.seconds,
      cost:
        totalCost === null
          ? { basis: 'unavailable' }
          : { basis: measured.basis, totalCost, currency: 'USD' },
    }
  }

  private seconds(): { seconds: number; basis: 'reported' | 'estimated' } | undefined {
    const observed = [...this.connections.values()]
    const reportedSeconds = observed.reduce((total, entry) => total + entry.milliseconds, 0) / 1000
    if (observed.length && observed.every((entry) => entry.reported && entry.closed))
      return { seconds: reportedSeconds, basis: 'reported' }
    const anyReported = observed.some((entry) => entry.reported)
    const wallSeconds =
      this.startedAt !== undefined && this.stoppedAt !== undefined
        ? Math.max(0, this.stoppedAt - this.startedAt) / 1000
        : undefined
    if (wallSeconds === undefined && !anyReported) return undefined
    return {
      seconds: Math.max(anyReported ? reportedSeconds : 0, wallSeconds ?? 0),
      basis: 'estimated',
    }
  }

  private connection(id: string): Connection {
    let entry = this.connections.get(id)
    if (!entry) {
      entry = { milliseconds: 0, reported: false, closed: false }
      this.connections.set(id, entry)
    }
    return entry
  }
}

/**
 * Usage of each model call in a backend run's events, in order. A call that started without a
 * recorded end, such as one cut off by `maxSteps` or cancellation, has unknown usage.
 */
export function backendModelCalls(events: readonly Event[]): Array<ModelUsage | undefined> {
  const calls: Array<ModelUsage | undefined> = []
  const open = new Set<string>()
  for (const event of events) {
    if (event.type === 'model_start') {
      if (open.has(event.invocationId)) calls.push(undefined)
      open.add(event.invocationId)
    } else if (event.type === 'model_end') {
      open.delete(event.invocationId)
      calls.push(event.usage)
    }
  }
  calls.push(...Array.from(open, () => undefined))
  return calls
}

/**
 * Checks that a LiveKit metrics payload is a Realtime model metric. Its token and duration fields
 * are not validated.
 */
export function isRealtimeMetrics(metrics: unknown): metrics is Record<string, unknown> {
  return isRecord(metrics) && metrics.type === 'realtime_model_metrics'
}

/**
 * Converts one OpenAI Realtime response's token metrics to usage. Audio and cached counts are
 * subsets of the input and output totals. Returns undefined when the response reported no tokens,
 * which the plugin also emits when the provider omitted usage.
 */
export function realtimeTokenUsage(
  metrics: Record<string, unknown>,
  modelName: string,
): ModelUsage | undefined {
  const inputTokens = count(metrics.inputTokens)
  const outputTokens = count(metrics.outputTokens)
  if (inputTokens + outputTokens === 0) return undefined
  const input = isRecord(metrics.inputTokenDetails) ? metrics.inputTokenDetails : {}
  const output = isRecord(metrics.outputTokenDetails) ? metrics.outputTokenDetails : {}
  const cached = isRecord(input.cachedTokensDetails) ? input.cachedTokensDetails : {}
  return {
    provider: 'openai',
    modelName,
    inputTokens,
    cachedTokens: count(input.cachedTokens),
    outputTokens,
    audioInputTokens: count(input.audioTokens),
    audioCachedTokens: count(cached.audioTokens),
    audioOutputTokens: count(output.audioTokens),
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
