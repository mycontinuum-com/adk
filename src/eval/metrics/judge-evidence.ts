import type { Event } from '../../types/events'
import type { VoiceRunResult } from '../voice/types'
import type { MetricRun } from './types'

/** What a judge model reads about one run, serialised as JSON. Every text is passed verbatim. */
export interface JudgeEvidence {
  /** Text: the run status. Voice: the voice run status, for example `max_duration`. */
  status?: string
  /** Speech and tool use in order. */
  timeline: JudgeTurn[]
  /** Live runs only: the simulated caller's transcription of the agent's audio. */
  callerHeard?: { atMs: number; text: string }[]
  /** Session state at the end of the run. */
  finalState: Record<string, unknown>
}

/**
 * One timeline entry. Voice speech times are the provider's audio offsets; voice tool times are
 * milliseconds from the start of the run. Text runs carry no times.
 */
export type JudgeTurn =
  | { kind: 'caller' | 'agent'; said: string; fromMs?: number; toMs?: number }
  | { kind: 'tool_call'; name: string; args: unknown; atMs?: number }
  | { kind: 'tool_result'; name: string; result?: unknown; error?: string; atMs?: number }

/** Consecutive GPT Live transcript fragments from one speaker, joined without added text. */
export interface LiveTranscriptTurn {
  speaker: 'caller' | 'agent'
  text: string
  /** Audio offset of the first fragment, when the provider reported one. */
  fromMs: number | null
  /** Audio offset where the last timed fragment ends, when the provider reported one. */
  toMs: number | null
  /** Wall-clock time at which the first fragment arrived. */
  receivedAt: number
}

/**
 * Splits a Live run's transcript fragments into turns. A turn ends at a speaker change, a new
 * provider connection, or a silence longer than `pauseMs` between timed fragments.
 */
export function liveTranscriptTurns(
  run: Pick<VoiceRunResult, 'liveTranscript'>,
  options: { pauseMs?: number } = {},
): LiveTranscriptTurn[] {
  const pauseMs = options.pauseMs ?? 1000
  const turns: LiveTranscriptTurn[] = []
  let previous: NonNullable<VoiceRunResult['liveTranscript']>['fragments'][number] | undefined
  for (const fragment of run.liveTranscript?.fragments ?? []) {
    const turn = turns.at(-1)
    const paused =
      previous !== undefined &&
      previous.endMs !== null &&
      fragment.startMs !== null &&
      fragment.startMs - previous.endMs > pauseMs
    if (
      turn &&
      previous?.speaker === fragment.speaker &&
      previous.connection.index === fragment.connection.index &&
      !paused
    ) {
      turn.text += fragment.text
      turn.toMs = fragment.endMs ?? turn.toMs
    } else {
      turns.push({
        speaker: fragment.speaker,
        text: fragment.text,
        fromMs: fragment.startMs,
        toMs: fragment.endMs,
        receivedAt: fragment.receivedAt,
      })
    }
    previous = fragment
  }
  return turns
}

/** Renders a text or voice run as the evidence a judge reads. */
export function renderJudgeEvidence(run: MetricRun | VoiceRunResult): JudgeEvidence {
  const events = run.session.events
  const finalState = events.length ? run.session.stateAt(events.length - 1).sessionState : {}
  if (!('voiceEvents' in run)) {
    return {
      ...('status' in run && typeof run.status === 'string' && { status: run.status }),
      timeline: events.flatMap(textTurn),
      finalState,
    }
  }
  return {
    status: run.status,
    timeline: voiceTimeline(run),
    ...(run.callerHeard && {
      callerHeard: run.callerHeard.map(({ atMs, text }) => ({ atMs, text })),
    }),
    finalState,
  }
}

function textTurn(event: Event): JudgeTurn[] {
  switch (event.type) {
    case 'user':
      return [{ kind: 'caller', said: event.text }]
    case 'assistant':
      return [{ kind: 'agent', said: event.text }]
    case 'tool_call':
      return [{ kind: 'tool_call', name: event.name, args: event.args }]
    case 'tool_result':
      if (event.output) {
        const said = typeof event.result === 'string' ? event.result : JSON.stringify(event.result)
        return [{ kind: 'agent', said }]
      }
      return [toolResult(event)]
    default:
      return []
  }
}

function toolResult(
  event: Extract<Event, { type: 'tool_result' }>,
  atMs?: number,
): Extract<JudgeTurn, { kind: 'tool_result' }> {
  return {
    kind: 'tool_result',
    name: event.name,
    ...(event.result !== undefined && { result: event.result }),
    ...(event.error !== undefined && { error: event.error }),
    ...(atMs !== undefined && { atMs }),
  }
}

type Timed = { at: number; turn: JudgeTurn }

/**
 * Merges speech and tool use by wall-clock receipt, keeping each list's own order. Session `user`
 * and `assistant` events are left out: the transcript carries what was spoken.
 */
function voiceTimeline(run: VoiceRunResult): JudgeTurn[] {
  const speech: Timed[] = run.liveTranscript
    ? liveTranscriptTurns(run).map((turn) => ({
        at: turn.receivedAt,
        turn: spoken(turn.speaker, turn.text, turn.fromMs, turn.toMs),
      }))
    : realtimeSpeech(run)
  const tools = run.session.events.flatMap((event): Timed[] => {
    const atMs = event.createdAt - run.startedAtMs
    if (event.type === 'tool_call')
      return [
        {
          at: event.createdAt,
          turn: { kind: 'tool_call', name: event.name, args: event.args, atMs },
        },
      ]
    if (event.type === 'tool_result')
      return [{ at: event.createdAt, turn: toolResult(event, atMs) }]
    return []
  })
  const timeline: JudgeTurn[] = []
  let s = 0
  let t = 0
  while (s < speech.length || t < tools.length) {
    const next = t >= tools.length || (s < speech.length && speech[s].at <= tools[t].at)
    timeline.push(next ? speech[s++].turn : tools[t++].turn)
  }
  return timeline
}

/**
 * Places each entry at its speech start. An entry without one goes at its receipt (`endMs`), never
 * before the entry ahead of it, so it cannot jump ahead of tool use that came first.
 */
function realtimeSpeech(run: VoiceRunResult): Timed[] {
  let at = run.startedAtMs
  return run.transcript.map((entry) => {
    if (entry.startMs !== undefined) at = run.startedAtMs + entry.startMs
    else if (entry.endMs !== undefined) at = Math.max(at, run.startedAtMs + entry.endMs)
    const speaker = entry.role === 'user' ? 'caller' : 'agent'
    return { at, turn: spoken(speaker, entry.text, entry.startMs ?? null, entry.endMs ?? null) }
  })
}

function spoken(
  kind: 'caller' | 'agent',
  said: string,
  fromMs: number | null,
  toMs: number | null,
): JudgeTurn {
  return {
    kind,
    said,
    ...(fromMs !== null && { fromMs }),
    ...(toMs !== null && { toMs }),
  }
}
