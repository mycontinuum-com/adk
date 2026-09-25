import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Event } from '../../types/events'
import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'
import type { LiveVoiceAppContext } from '../../voice/live-handler'
import type { Metric, MetricResult } from '../metrics/types'
import type { EvalStatus } from '../types'
import type {
  VoiceEvalCase,
  VoiceEvalOptions,
  VoiceRoomConfig,
  VoiceEvalCaseResult,
  VoiceEvalResult,
  VoiceRunResult,
  VoiceRunStatus,
} from './types'

import { BaseSession } from '../../session'
import { sanitize } from '../../voice/recording'
import {
  assertJsonMetrics,
  omitUndefinedProperties,
  stringifyEvidence,
  voiceEvidence,
} from '../json'
import { createEvalSession } from '../session'
import {
  runWithPool,
  runMetrics,
  mergeMetrics,
  buildSummary,
  expandCaseRuns,
  metricsStatus,
  type CaseRun,
} from '../suite-runner'
import { createCaseWriter } from './case-writer'
import { isProcessWorker, getWorkerCaseIndex, sendWorkerResult, forkCase } from './process-pool'
import { runVoiceCase } from './runner'
import { emptyTiming } from './speaker-tracker'

type SerializedVoiceRun = Omit<VoiceRunResult, 'session'> & {
  sessionId: string
  sessionEvents: readonly Event[]
}
type SerializedVoiceResult = Omit<VoiceEvalCaseResult, 'run'> & { run: SerializedVoiceRun }

const WORKER_STAGGER_MS = 2_000

function mapVoiceStatus(
  runStatus: VoiceRunStatus,
  metricResults: Record<string, MetricResult>,
): EvalStatus {
  switch (runStatus) {
    case 'error':
      return 'error'
    case 'timeout':
    case 'disconnected':
      return 'terminated'
    case 'participant_left':
      return Object.keys(metricResults).length === 0 ? 'terminated' : metricsStatus(metricResults)
    default:
      return metricsStatus(metricResults)
  }
}

const RETRYABLE_STATUSES: Set<VoiceRunStatus> = new Set([
  'error',
  'timeout',
  'disconnected',
  'participant_left',
])

async function runSingleVoiceEval<S extends StateSchema>(
  evalCase: VoiceEvalCase<S>,
  options: VoiceEvalOptions<S> & { room: VoiceRoomConfig },
  suiteMetrics: Metric<VoiceRunResult<S>>[],
  dirName: string,
  repeat?: { index: number; total: number },
  appContext?: LiveVoiceAppContext<S>,
): Promise<VoiceEvalCaseResult<S>> {
  const maxAttempts = Math.max(1, (evalCase.retries ?? 0) + 1)
  let lastResult: VoiceEvalCaseResult<S> | undefined
  const caseDir = options.output ? join(options.output, dirName) : undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const writer = options.output ? createCaseWriter(options.output, evalCase, dirName) : undefined

    const startMs = Date.now()
    const run = await runVoiceCase(evalCase, options, writer, caseDir, appContext)

    const merged = mergeMetrics(suiteMetrics, evalCase.metrics ?? [], evalCase.name, 'voice-eval')
    const metricResults = await runMetrics(run, merged)
    const status = mapVoiceStatus(run.status, metricResults)

    lastResult = {
      name: evalCase.name,
      status,
      metrics: metricResults,
      run,
      usage: run.usage,
      durationMs: Date.now() - startMs,
      error: run.error,
      attempts: attempt,
      ...(repeat && { repeatIndex: repeat.index, repeatTotal: repeat.total }),
    }

    writer?.writeResult(status, run, metricResults, attempt)

    assertJsonMetrics(lastResult.metrics)
    if (status === 'passed') return lastResult
    if (attempt < maxAttempts && RETRYABLE_STATUSES.has(run.status)) continue
    break
  }

  return lastResult!
}

// ---------------------------------------------------------------------------
// Case run helpers
// ---------------------------------------------------------------------------

function caseRunLabel<S extends StateSchema>(run: CaseRun<VoiceEvalCase<S>>): string {
  return run.repeatIndex != null
    ? `${run.item.name} [${run.repeatIndex}/${run.repeatTotal}]`
    : run.item.name
}

function caseRunDirName<S extends StateSchema>(
  run: CaseRun<VoiceEvalCase<S>>,
  index: number,
): string {
  return `${index + 1}-${sanitize(run.item.name).slice(0, 80)}`
}

// ---------------------------------------------------------------------------
// Resolve room config (shared between main + worker)
// ---------------------------------------------------------------------------

function resolveRoomConfig<S extends StateSchema>(
  options: VoiceEvalOptions<S>,
): VoiceEvalOptions<S> & { room: VoiceRoomConfig } {
  const { room } = options
  const url = room?.url ?? process.env.LIVEKIT_URL
  if (!url) {
    throw new Error(
      '[adk/voice-eval] LiveKit URL is required. Set LIVEKIT_URL or pass room.url in options.',
    )
  }
  return {
    ...options,
    room: {
      url,
      apiKey: room?.apiKey ?? process.env.LIVEKIT_API_KEY,
      apiSecret: room?.apiSecret ?? process.env.LIVEKIT_API_SECRET,
    },
  }
}

// ---------------------------------------------------------------------------
// Worker mode — runs inside the forked child process
// ---------------------------------------------------------------------------

/**
 * LiveKit's Realtime plugin writes the simulated caller's audio deltas without handling the write,
 * so a caller reply aborted mid-stream (talked over, or closed) rejects with no reason. Any other
 * unhandled rejection still fails the worker.
 */
function rethrowUnlessReasonless(reason: unknown): void {
  if (reason === undefined) return
  throw reason
}

async function runAsWorker<S extends StateSchema>(
  cases: VoiceEvalCase<S>[],
  options: VoiceEvalOptions<S>,
  appContext?: LiveVoiceAppContext<S>,
): Promise<never> {
  process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
    throw err
  })

  process.on('unhandledRejection', rethrowUnlessReasonless)

  process.on('uncaughtException', (err) => {
    if (err?.message?.includes('currentGeneration')) return
    console.error('[adk/voice-eval] Uncaught exception in worker:', err)
    process.exit(1)
  })

  const resolvedOptions = resolveRoomConfig(options)
  const suiteMetrics = (options.metrics ?? []) as Metric<VoiceRunResult<S>>[]
  const caseRuns = expandCaseRuns(cases, options.repeat)
  const caseIndex = getWorkerCaseIndex()

  if (caseIndex < 0 || caseIndex >= caseRuns.length) {
    console.error(
      `[adk/voice-eval] Worker received invalid case index ${caseIndex} (total: ${caseRuns.length})`,
    )
    process.exit(1)
  }

  const run = caseRuns[caseIndex]
  const repeat =
    run.repeatIndex != null ? { index: run.repeatIndex, total: run.repeatTotal! } : undefined
  const result = await runSingleVoiceEval(
    run.item,
    resolvedOptions,
    suiteMetrics,
    caseRunDirName(run, caseIndex),
    repeat,
    appContext,
  )

  await sendWorkerResult(caseIndex, serializeWorkerResult(result))
  process.exit(0)
  return undefined as never
}

/** Serializes a voice result before it crosses the worker IPC boundary. */
export function serializeWorkerResult<S extends StateSchema>(
  result: VoiceEvalCaseResult<S>,
): string {
  const { run, ...caseResult } = result
  const { session: _session, ...voiceRun } = run
  return stringifyEvidence({
    ...omitUndefinedProperties(caseResult),
    run: {
      ...omitUndefinedProperties(voiceRun),
      ...voiceEvidence(run),
    },
  })
}

/** Rebuilds a worker's result. The worker is a fork of this script, so it is not re-validated. */
function hydrateWorkerResult<S extends StateSchema>(raw: string): VoiceEvalCaseResult<S> {
  const result: SerializedVoiceResult = JSON.parse(raw)
  const session = new BaseSession('eval', { id: result.run.sessionId })
  for (const event of result.run.sessionEvents) session.pushEvent(event)
  return {
    ...result,
    run: { ...result.run, session: session as unknown as Session<S> },
  }
}

function workerError<S extends StateSchema>(
  name: string,
  err: unknown,
  repeat?: { index: number; total: number },
): VoiceEvalCaseResult<S> {
  const message = err instanceof Error ? err.message : String(err)
  return {
    name,
    status: 'error',
    metrics: {},
    run: {
      status: 'error',
      startedAtMs: Date.now(),
      session: createEvalSession() as unknown as Session<S>,
      events: [],
      voiceEvents: [],
      transcript: [],
      timing: emptyTiming(),
      recording: { path: '' },
      error: { message },
      durationMs: 0,
    },
    durationMs: 0,
    error: { message },
    ...(repeat && { repeatIndex: repeat.index, repeatTotal: repeat.total }),
  }
}

/** Runs one or more voice cases, using child workers when concurrency exceeds one. */
export async function evaluateVoice<S extends StateSchema = StateSchema>(
  caseOrCases: VoiceEvalCase<S> | VoiceEvalCase<S>[],
  options: VoiceEvalOptions<S>,
  appContext?: LiveVoiceAppContext<S>,
): Promise<VoiceEvalResult<S>> {
  const cases = Array.isArray(caseOrCases) ? caseOrCases : [caseOrCases]

  // ── Worker mode: run assigned case, send result, exit ──────────────
  if (isProcessWorker()) {
    await runAsWorker(cases, options, appContext)
    return undefined as never
  }

  const startTime = Date.now()
  const { caseRuns, runCase, concurrency } = prepareVoiceEvaluation(cases, options, appContext)
  const shouldStop = options.stopOnFirstFailure
    ? (result: VoiceEvalCaseResult<S>) => result.status !== 'passed'
    : undefined
  const results = await runWithPool(caseRuns, runCase, concurrency, shouldStop)
  return { summary: buildSummary(results), results, durationMs: Date.now() - startTime }
}

/** Prepares shared voice evaluation state for a mixed or voice-only run. */
export function prepareVoiceEvaluation<S extends StateSchema>(
  cases: VoiceEvalCase<S>[],
  options: VoiceEvalOptions<S>,
  appContext?: LiveVoiceAppContext<S>,
) {
  const resolvedOptions = resolveRoomConfig(options)
  const concurrency = Math.max(1, resolvedOptions.concurrency ?? 4)
  const suiteMetrics = (resolvedOptions.metrics ?? []) as Metric<VoiceRunResult<S>>[]

  if (resolvedOptions.output) {
    if (existsSync(resolvedOptions.output) && readdirSync(resolvedOptions.output).length > 0) {
      throw new Error(`Voice evaluation output directory must be empty: ${resolvedOptions.output}`)
    }
    mkdirSync(resolvedOptions.output, { recursive: true })
  }

  const caseRuns = expandCaseRuns(cases, resolvedOptions.repeat)

  const runMeta = caseRuns.map((r, index) => ({
    label: caseRunLabel(r),
    dirName: caseRunDirName(r, index),
  }))
  const caseStatuses = new Map<number, string>(caseRuns.map((_, i) => [i, 'pending']))
  const writeIndex = () => {
    const output = resolvedOptions.output
    if (!output) return
    const lines: string[] = [`# Voice Eval — ${new Date().toLocaleString()}`, '']
    const completed = [...caseStatuses.values()].filter(
      (status) => status !== 'pending' && status !== 'running...',
    )
    lines.push(`${completed.length}/${caseRuns.length} complete`)
    lines.push('')
    for (const [index, status] of caseStatuses) {
      const { label, dirName } = runMeta[index]
      lines.push(`- [${label}](./${dirName}/report.md) — ${status}`)
    }
    lines.push('')
    writeFileSync(join(output, 'index.md'), lines.join('\n'))
  }
  writeIndex()

  const useForkedWorkers = concurrency > 1
  let completedCount = 0
  const runCase = async (
    run: CaseRun<VoiceEvalCase<S>>,
    runIndex: number,
  ): Promise<VoiceEvalCaseResult<S>> => {
    if (useForkedWorkers && runIndex < concurrency) {
      const delay = runIndex * WORKER_STAGGER_MS
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    }

    caseStatuses.set(runIndex, 'running...')
    writeIndex()
    const repeat =
      run.repeatIndex != null ? { index: run.repeatIndex, total: run.repeatTotal! } : undefined
    const result = useForkedWorkers
      ? await forkCase(runIndex)
          .then((raw) => hydrateWorkerResult<S>(raw))
          .catch((err) => workerError<S>(run.item.name, err, repeat))
      : await runSingleVoiceEval(
          run.item,
          resolvedOptions,
          suiteMetrics,
          runMeta[runIndex].dirName,
          repeat,
          appContext,
        )

    caseStatuses.set(runIndex, `${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`)
    writeIndex()
    completedCount++
    resolvedOptions.onCase?.(result, completedCount, caseRuns.length)
    return result
  }
  return { caseRuns, runCase, concurrency }
}
