import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { AnnotationEvent } from '../types/events'
import type { Session, SessionService, SessionStore } from '../types/session'

import { sessionService } from '../session/service'

const transcriptType = z.enum(['session.input_transcript.delta', 'session.output_transcript.delta'])
const controlType = z.enum([
  'session.instructions.append',
  'session.thinking.append',
  'session.commentary.append',
])
const acknowledgementType = z.enum([
  'session.instructions.appended',
  'session.thinking.appended',
  'session.commentary.appended',
])
const eventId = z.string().min(1).optional()
const offset = z.number().finite().nonnegative().nullable().optional()
const transcriptEvent = z.object({
  type: transcriptType,
  event_id: eventId,
  delta: z.string(),
  start_ms: offset,
  end_ms: offset,
})
const startedEvent = z.object({
  type: z.literal('session.started'),
  event_id: eventId,
  session: z.object({ id: z.string().min(1) }),
})
const closedEvent = z.object({
  type: z.literal('session.closed'),
  event_id: eventId,
  reason: z
    .enum(['close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost'])
    .nullable()
    .optional(),
})
const delegationEvent = z.object({
  type: z.literal('session.delegation.created'),
  event_id: eventId,
  offset_ms: offset,
  delegation: z.object({
    id: z.string().min(1),
    target: z.enum(['client', 'responses']).nullable().optional(),
  }),
})
const controlEvent = z.object({
  type: controlType,
  event_id: eventId,
  delegation_id: z.string().nullable(),
  content: z.string(),
})
const acknowledgementEvent = z.object({
  type: acknowledgementType,
  event_id: eventId,
  client_event_id: z.string().optional(),
  offset_ms: offset,
  start_ms: offset,
  end_ms: offset,
})
const payload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transcript'), event: transcriptEvent }),
  z.object({ kind: z.literal('started'), event: startedEvent }),
  z.object({ kind: z.literal('closed'), event: closedEvent }),
  z.object({ kind: z.literal('delegation'), event: delegationEvent }),
  z.object({ kind: z.literal('control'), event: controlEvent }),
  z.object({ kind: z.literal('acknowledgement'), event: acknowledgementEvent }),
  z.object({ kind: z.literal('attached'), late: z.boolean() }),
  z.object({ kind: z.literal('detached') }),
  z.object({ kind: z.literal('invalid-event'), eventType: z.string() }),
])
const connectionSchema = z.object({
  id: z.string().nullable(),
  index: z.number().int().nonnegative(),
})
const observationSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  receivedAt: z.number().finite(),
  connection: connectionSchema,
  payload,
})
export type GPTLiveTranscriptObservation = z.infer<typeof observationSchema>
type Payload = z.infer<typeof payload>
type Connection = z.infer<typeof connectionSchema>

export interface GPTLiveTranscriptSource {
  readonly sessionId?: string | null
  on(
    event: 'openai_server_event_received' | 'openai_client_event_queued',
    listener: (event: unknown) => void,
  ): unknown
  off(
    event: 'openai_server_event_received' | 'openai_client_event_queued',
    listener: (event: unknown) => void,
  ): unknown
}

export interface GPTLiveTranscriptFragment {
  readonly connection: Readonly<Connection>
  readonly speaker: 'caller' | 'agent'
  readonly text: string
  readonly startMs: number | null
  readonly endMs: number | null
  readonly sequence: number
  readonly receivedAt: number
  readonly eventId: string | null
}

export interface GPTLiveTranscriptSnapshot {
  readonly callId: string
  readonly receivedThrough: number
  readonly observations: readonly GPTLiveTranscriptObservation[]
  readonly fragments: readonly GPTLiveTranscriptFragment[]
  readonly status: 'usable' | 'ambiguous'
  readonly duplicates: number
  readonly conflicts: readonly {
    connectionId: string | null
    eventId: string
    sequences: readonly number[]
  }[]
  readonly diagnostics: readonly string[]
}

export interface GPTLiveTranscript {
  readonly receivedThrough: number
  readonly status: GPTLiveTranscriptSnapshot['status']
  attach(source: GPTLiveTranscriptSource): () => void
  snapshot(): GPTLiveTranscriptSnapshot
  checkpoint(): Promise<void>
  close(): Promise<void>
}

const appName = 'adk-gpt-live-transcript'
const label = 'gpt-live-transcript.v1'
const knownServerTypes = new Set([
  ...transcriptType.options,
  'session.started',
  'session.closed',
  'session.delegation.created',
  ...acknowledgementType.options,
])

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
  }
  return Object.freeze(value)
}

type TranscriptIdentity =
  | { kind: 'new' | 'duplicate' }
  | { kind: 'conflict'; eventId: string; previousSequence: number }

function transcriptIdentityClassifier() {
  const seen = new Map<string, { sequence: number; event: z.infer<typeof transcriptEvent> }>()
  return (observation: GPTLiveTranscriptObservation): TranscriptIdentity => {
    if (observation.payload.kind !== 'transcript') return { kind: 'new' }
    const {
      connection,
      sequence,
      payload: { event },
    } = observation
    if (!event.event_id) return { kind: 'new' }
    const key = JSON.stringify([connection.index, connection.id, event.event_id])
    const previous = seen.get(key)
    if (!previous) {
      seen.set(key, { sequence, event })
      return { kind: 'new' }
    }
    return JSON.stringify(previous.event) === JSON.stringify(event)
      ? { kind: 'duplicate' }
      : { kind: 'conflict', eventId: event.event_id, previousSequence: previous.sequence }
  }
}

function project(
  callId: string,
  observations: GPTLiveTranscriptObservation[],
  errors: string[],
): GPTLiveTranscriptSnapshot {
  const fragments: GPTLiveTranscriptFragment[] = []
  const diagnostics = new Set(errors)
  const classify = transcriptIdentityClassifier()
  const conflicts: { connectionId: string | null; eventId: string; sequences: number[] }[] = []
  let duplicates = 0
  for (const observation of observations) {
    const { payload: record, connection, sequence } = observation
    if (record.kind === 'attached' && record.late)
      diagnostics.add(
        'Capture attached after provider startup; earlier observations are unavailable.',
      )
    if (record.kind === 'invalid-event')
      diagnostics.add(`Invalid ${record.eventType} observation at receipt ${sequence}.`)
    if (record.kind !== 'transcript') continue
    const event = record.event
    if (connection.id === null)
      diagnostics.add('Some transcript observations have no provider connection identity.')
    if (event.start_ms == null || event.end_ms == null)
      diagnostics.add('Some transcript observations have no native timing.')
    if (!event.event_id)
      diagnostics.add(
        'Some transcript observations have no provider event identity; they cannot be deduplicated.',
      )
    const identity = classify(observation)
    if (identity.kind === 'duplicate') {
      duplicates++
      continue
    }
    if (identity.kind === 'conflict') {
      conflicts.push({
        connectionId: connection.id,
        eventId: identity.eventId,
        sequences: [identity.previousSequence, sequence],
      })
      continue
    }
    fragments.push({
      connection,
      speaker: event.type === 'session.input_transcript.delta' ? 'caller' : 'agent',
      text: event.delta,
      startMs: event.start_ms ?? null,
      endMs: event.end_ms ?? null,
      sequence,
      eventId: event.event_id ?? null,
      receivedAt: observation.receivedAt,
    })
  }
  fragments.sort(
    (a, b) =>
      a.connection.index - b.connection.index ||
      (a.startMs ?? Infinity) - (b.startMs ?? Infinity) ||
      a.sequence - b.sequence,
  )
  return freeze({
    callId,
    receivedThrough: observations.at(-1)?.sequence ?? 0,
    observations,
    fragments,
    status: conflicts.length ? 'ambiguous' : 'usable',
    duplicates,
    conflicts,
    diagnostics: [...diagnostics],
  })
}

/** A persisted transcript session and the service that writes it. */
interface TranscriptPersistence {
  readonly session: Session
  readonly sessions: SessionService
}

/**
 * Opens the native transcript recorder for one GPT Live call. With a `store`, observations persist
 * in the `adk-gpt-live-transcript` session named by `callId`, and an existing session is reopened
 * rather than replaced. `checkpointMs` flushes on an interval and requires a store and `onError`.
 * Without a store, observations stay in memory.
 *
 * @returns A recorder to `attach()` to the Live session. Call `close()` to stop capture and flush.
 * @throws When the options are invalid or the stored observations cannot be loaded.
 */
export async function openGPTLiveTranscript(
  options: {
    callId: string
    onError?: (error: Error) => void
  } & ({ store: SessionStore; checkpointMs?: number } | { store?: never; checkpointMs?: never }),
): Promise<GPTLiveTranscript> {
  const { store, callId, checkpointMs, onError } = options
  if (checkpointMs !== undefined && !store)
    throw new Error('Transcript checkpoints require a store')
  if (!callId.trim()) throw new Error('Transcript callId must not be empty')
  if (
    checkpointMs !== undefined &&
    (!Number.isFinite(checkpointMs) || checkpointMs <= 0 || !onError)
  ) {
    throw new Error(
      'Periodic transcript checkpoints require a positive checkpointMs and onError callback',
    )
  }
  const sessions = store ? sessionService(store) : undefined
  const persistence = sessions
    ? {
        sessions,
        session:
          (await sessions.getSession(appName, callId)) ??
          (await sessions.createSession(appName, { sessionId: callId })),
      }
    : undefined
  const observations =
    persistence?.session.events.map((event) => {
      if (event.type !== 'annotation' || event.label !== label)
        throw new Error('Unexpected event in transcript session')
      const parsed = observationSchema.safeParse(event.data?.observation)
      if (!parsed.success) throw new Error('Invalid persisted GPT Live transcript observation')
      return parsed.data
    }) ?? []
  return new GPTLiveTranscriptRecorder(callId, observations, persistence, checkpointMs, onError)
}

class GPTLiveTranscriptRecorder implements GPTLiveTranscript {
  private readonly classify = transcriptIdentityClassifier()
  private currentStatus: GPTLiveTranscriptSnapshot['status'] = 'usable'
  private sequence = 0
  private connection: Connection = { id: null, index: 0 }
  private detach: (() => void) | undefined
  private closed = false
  private checkpointError: string | undefined
  private readonly appendFailures: string[] = []
  private timerCheckpointPending = false
  private persistedThrough: number
  private readonly timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly callId: string,
    private readonly observations: GPTLiveTranscriptObservation[],
    private readonly persistence: TranscriptPersistence | undefined,
    checkpointMs: number | undefined,
    private readonly onError: ((error: Error) => void) | undefined,
  ) {
    for (const observation of observations) {
      if (observation.sequence <= this.sequence)
        throw new Error('Transcript receipt sequence must increase')
      this.sequence = observation.sequence
      this.connection = observation.connection
      if (this.classify(observation).kind === 'conflict') this.currentStatus = 'ambiguous'
    }
    this.persistedThrough = this.sequence
    this.timer =
      checkpointMs === undefined
        ? undefined
        : setInterval(() => this.checkpointOnTimer(), checkpointMs)
    this.timer?.unref()
  }

  get receivedThrough(): number {
    return this.sequence
  }

  get status(): GPTLiveTranscriptSnapshot['status'] {
    return this.currentStatus
  }

  attach(source: GPTLiveTranscriptSource): () => void {
    if (this.closed) throw new Error('Transcript capture is closed')
    if (this.detach) throw new Error('Transcript capture already has an attached source')
    const id = source.sessionId ?? null
    if (id === null || id !== this.connection.id)
      this.connection = { id, index: this.connection.index + 1 }
    this.append({ kind: 'attached', late: id !== null })
    const serverListener = (raw: unknown) => this.receive(raw, false)
    const clientListener = (raw: unknown) => this.receive(raw, true)
    source.on('openai_server_event_received', serverListener)
    source.on('openai_client_event_queued', clientListener)
    const stop = () => {
      if (this.detach !== stop) return
      source.off('openai_server_event_received', serverListener)
      source.off('openai_client_event_queued', clientListener)
      this.detach = undefined
      this.append({ kind: 'detached' })
    }
    this.detach = stop
    return stop
  }

  snapshot(): GPTLiveTranscriptSnapshot {
    return project(this.callId, structuredClone(this.observations), [
      ...this.appendFailures,
      ...(this.checkpointError ? [this.checkpointError] : []),
    ])
  }

  async checkpoint(): Promise<void> {
    if (!this.persistence) return
    try {
      if (this.appendFailures.length)
        throw new Error('Transcript buffering failed; capture is incomplete')
      const through = this.sequence
      if (through === this.persistedThrough) return
      const result = await this.persistence.sessions.commitSession(this.persistence.session)
      if (!result.ok)
        throw new Error(`Transcript checkpoint conflict at version ${result.currentVersion}`)
      this.persistedThrough = through
      this.checkpointError = undefined
    } catch (error) {
      this.checkpointError =
        'Transcript checkpoint failed; buffered observations are not confirmed durable.'
      throw error
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.detach?.()
    await this.checkpoint()
  }

  private checkpointOnTimer(): void {
    if (this.timerCheckpointPending) return
    this.timerCheckpointPending = true
    void this.checkpoint()
      .catch(() => this.report(new Error('GPT Live transcript checkpoint failed')))
      .finally(() => {
        this.timerCheckpointPending = false
      })
  }

  private report(error: Error): void {
    try {
      this.onError?.(error)
    } catch {}
  }

  private append(record: Payload): void {
    const observation: GPTLiveTranscriptObservation = {
      version: 1,
      sequence: ++this.sequence,
      receivedAt: Date.now(),
      connection: { ...this.connection },
      payload: record,
    }
    this.observations.push(observation)
    if (this.classify(observation).kind === 'conflict') this.currentStatus = 'ambiguous'
    if (!this.persistence) return
    const { session, sessions } = this.persistence
    const event: AnnotationEvent = {
      id: randomUUID(),
      type: 'annotation',
      kind: 'mark',
      label,
      agentName: appName,
      invocationId: session.id,
      createdAt: observation.receivedAt,
      data: { observation },
    }
    void sessions.appendEvent(session, event).catch(() => {
      const message = `Transcript buffering failed at receipt ${observation.sequence}`
      this.appendFailures.push(message)
      this.report(new Error(message))
    })
  }

  /** Records one provider event. Malformed supported events never interrupt provider dispatch. */
  private receive(raw: unknown, outgoing: boolean): void {
    try {
      this.observe(raw, outgoing)
    } catch {
      const type = z.object({ type: z.string() }).safeParse(raw)
      this.append({ kind: 'invalid-event', eventType: type.success ? type.data.type : 'unknown' })
      this.report(new Error('Invalid GPT Live transcript event'))
    }
  }

  private observe(raw: unknown, outgoing: boolean): void {
    const type = z.object({ type: z.string() }).safeParse(raw)
    if (!type.success) return
    const name = type.data.type
    if (!(outgoing ? controlType.safeParse(name).success : knownServerTypes.has(name))) return
    let parsed: Payload
    if (outgoing) parsed = { kind: 'control', event: controlEvent.parse(raw) }
    else if (name === 'session.started')
      parsed = { kind: 'started', event: startedEvent.parse(raw) }
    else if (name === 'session.closed') parsed = { kind: 'closed', event: closedEvent.parse(raw) }
    else if (name === 'session.delegation.created')
      parsed = { kind: 'delegation', event: delegationEvent.parse(raw) }
    else if (transcriptType.safeParse(name).success)
      parsed = { kind: 'transcript', event: transcriptEvent.parse(raw) }
    else parsed = { kind: 'acknowledgement', event: acknowledgementEvent.parse(raw) }
    if (parsed.kind === 'started' && this.connection.id !== parsed.event.session.id) {
      this.connection = { id: parsed.event.session.id, index: this.connection.index + 1 }
    }
    this.append(parsed)
  }
}
