import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { Session, SessionService, SessionStore } from '../types/session'

import { sessionService } from '../session/service'

const transcriptType = z.enum(['session.input_transcript.delta', 'session.output_transcript.delta'])
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
const delegationEvent = z.object({
  type: z.literal('session.delegation.created'),
  event_id: eventId,
  offset_ms: offset,
  delegation: z.object({ id: z.string().min(1) }),
})

interface Connection {
  id: string | null
  index: number
}

export interface GPTLiveTranscriptObservation {
  sequence: number
  receivedAt: number
  connection: Connection
  payload:
    | { kind: 'transcript'; event: z.infer<typeof transcriptEvent> }
    | { kind: 'delegation'; event: z.infer<typeof delegationEvent> }
}

export interface GPTLiveTranscriptSource {
  readonly sessionId?: string | null
  on(event: 'openai_server_event_received', listener: (event: unknown) => void): unknown
  off(event: 'openai_server_event_received', listener: (event: unknown) => void): unknown
}

export interface GPTLiveTranscriptFragment {
  readonly connection: Readonly<Connection>
  readonly speaker: 'caller' | 'agent'
  readonly text: string
  readonly startMs: number | null
  readonly endMs: number | null
  readonly sequence: number
  readonly receivedAt: number
}

export interface GPTLiveTranscriptSnapshot {
  readonly callId: string
  readonly receivedThrough: number
  readonly observations: readonly GPTLiveTranscriptObservation[]
  /** Transcript deltas in receipt order. */
  readonly fragments: readonly GPTLiveTranscriptFragment[]
}

export interface GPTLiveTranscript {
  readonly receivedThrough: number
  attach(source: GPTLiveTranscriptSource): void
  snapshot(): GPTLiveTranscriptSnapshot
  checkpoint(): Promise<void>
  close(): Promise<void>
}

const appName = 'adk-gpt-live-transcript'
const label = 'gpt-live-transcript.v1'
const CHECKPOINT_MS = 500

/**
 * Starts the native transcript recorder for one GPT Live call. Observations persist in a new
 * `adk-gpt-live-transcript` session named by `callId` and are checkpointed every 500 ms; a failed
 * checkpoint or event is reported to `onError`.
 *
 * @returns A recorder to `attach()` to the Live session. Call `close()` to stop capture and flush.
 */
export async function createGPTLiveTranscript(
  store: SessionStore,
  callId: string,
  onError: (error: Error) => void,
): Promise<GPTLiveTranscript> {
  const sessions = sessionService(store)
  const session = await sessions.createSession(appName, { sessionId: callId })
  return new GPTLiveTranscriptRecorder(callId, session, sessions, onError)
}

class GPTLiveTranscriptRecorder implements GPTLiveTranscript {
  private readonly observations: GPTLiveTranscriptObservation[] = []
  private sequence = 0
  private connection: Connection = { id: null, index: 0 }
  private detach: (() => void) | undefined
  private appendFailed = false
  private timerCheckpointPending = false
  private persistedThrough = 0
  private readonly timer = setInterval(() => this.checkpointOnTimer(), CHECKPOINT_MS)

  constructor(
    private readonly callId: string,
    private readonly session: Session,
    private readonly sessions: SessionService,
    private readonly onError: (error: Error) => void,
  ) {
    this.timer.unref()
  }

  get receivedThrough(): number {
    return this.sequence
  }

  attach(source: GPTLiveTranscriptSource): void {
    const id = source.sessionId ?? null
    if (id === null || id !== this.connection.id)
      this.connection = { id, index: this.connection.index + 1 }
    const listener = (raw: unknown) => this.receive(raw)
    source.on('openai_server_event_received', listener)
    this.detach = () => source.off('openai_server_event_received', listener)
  }

  snapshot(): GPTLiveTranscriptSnapshot {
    const observations = structuredClone(this.observations)
    return {
      callId: this.callId,
      receivedThrough: this.sequence,
      observations,
      fragments: observations.flatMap(({ payload, connection, sequence, receivedAt }) =>
        payload.kind === 'transcript'
          ? [
              {
                connection,
                speaker:
                  payload.event.type === 'session.input_transcript.delta' ? 'caller' : 'agent',
                text: payload.event.delta,
                startMs: payload.event.start_ms ?? null,
                endMs: payload.event.end_ms ?? null,
                sequence,
                receivedAt,
              },
            ]
          : [],
      ),
    }
  }

  async checkpoint(): Promise<void> {
    if (this.appendFailed) throw new Error('Transcript buffering failed; capture is incomplete')
    const through = this.sequence
    if (through === this.persistedThrough) return
    const result = await this.sessions.commitSession(this.session)
    if (!result.ok)
      throw new Error(`Transcript checkpoint conflict at version ${result.currentVersion}`)
    this.persistedThrough = through
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
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
      this.onError(error)
    } catch {}
  }

  private append(payload: GPTLiveTranscriptObservation['payload']): void {
    const observation: GPTLiveTranscriptObservation = {
      sequence: ++this.sequence,
      receivedAt: Date.now(),
      connection: { ...this.connection },
      payload,
    }
    this.observations.push(observation)
    void this.sessions
      .appendEvent(this.session, {
        id: randomUUID(),
        type: 'annotation',
        kind: 'mark',
        label,
        agentName: appName,
        invocationId: this.session.id,
        createdAt: observation.receivedAt,
        data: { observation },
      })
      .catch(() => {
        this.appendFailed = true
        this.report(new Error(`Transcript buffering failed at receipt ${observation.sequence}`))
      })
  }

  /** Records one provider event. Malformed supported events never interrupt provider dispatch. */
  private receive(raw: unknown): void {
    const type = z.object({ type: z.string() }).safeParse(raw)
    if (!type.success) return
    try {
      if (type.data.type === 'session.started') {
        const { session } = startedEvent.parse(raw)
        if (this.connection.id !== session.id)
          this.connection = { id: session.id, index: this.connection.index + 1 }
      } else if (type.data.type === 'session.delegation.created')
        this.append({ kind: 'delegation', event: delegationEvent.parse(raw) })
      else if (transcriptType.safeParse(type.data.type).success)
        this.append({ kind: 'transcript', event: transcriptEvent.parse(raw) })
    } catch {
      this.report(new Error('Invalid GPT Live transcript event'))
    }
  }
}
