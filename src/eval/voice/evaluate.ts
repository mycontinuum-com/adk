import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'
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
import { createEvalSession } from '../session'
import {
  runSequential,
  runWithPool,
  runMetrics,
  mergeMetrics,
  buildSummary,
  expandCaseRuns,
  type CaseRun,
} from '../suite-runner'
import { createCaseWriter } from './case-writer'
import { isProcessWorker, getWorkerCaseIndex, sendWorkerResult, forkCase } from './process-pool'
import { runVoiceCase } from './runner'

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
    case 'participant_left': {
      const results = Object.values(metricResults)
      if (results.length === 0) return 'terminated'
      return results.every((r) => r.passed) ? 'passed' : 'failed'
    }
    default:
      return Object.values(metricResults).every((r) => r.passed) ? 'passed' : 'failed'
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
): Promise<VoiceEvalCaseResult<S>> {
  const maxAttempts = Math.max(1, (evalCase.retries ?? 0) + 1)
  let lastResult: VoiceEvalCaseResult<S> | undefined
  const caseDir = options.output ? join(options.output, dirName) : undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const writer = options.output ? createCaseWriter(options.output, evalCase, dirName) : undefined

    const startMs = Date.now()
    const run = await runVoiceCase(evalCase, options, writer, caseDir)

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

function caseRunDirName<S extends StateSchema>(run: CaseRun<VoiceEvalCase<S>>): string {
  return run.repeatIndex != null
    ? `${sanitize(run.item.name)}-run-${run.repeatIndex}`
    : sanitize(run.item.name)
}

// ---------------------------------------------------------------------------
// Resolve room config (shared between main + worker)
// ---------------------------------------------------------------------------

function resolveRoomConfig<S extends StateSchema>(
  options: VoiceEvalOptions<S>,
): VoiceEvalOptions<S> & { room: VoiceRoomConfig } {
  const url = options.room?.url ?? process.env.LIVEKIT_URL
  if (!url) {
    throw new Error(
      '[adk/voice-eval] LiveKit URL is required. Set LIVEKIT_URL or pass room.url in options.',
    )
  }
  return { ...options, room: { ...options.room, url } }
}

// ---------------------------------------------------------------------------
// Worker mode — runs inside the forked child process
// ---------------------------------------------------------------------------

async function runAsWorker<S extends StateSchema>(
  cases: VoiceEvalCase<S>[],
  options: VoiceEvalOptions<S>,
): Promise<never> {
  process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
    throw err
  })

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
    caseRunDirName(run),
    repeat,
  )

  // Strip non-serializable Session class before IPC send.
  await sendWorkerResult(caseIndex, {
    ...result,
    run: { ...result.run, session: null },
  })
  process.exit(0)
  return undefined as never
}

// ---------------------------------------------------------------------------
// Hydrate a worker result — reconstruct Session stub from events
// ---------------------------------------------------------------------------

function hydrateWorkerResult<S extends StateSchema>(raw: any): VoiceEvalCaseResult<S> {
  const session = createEvalSession() as BaseSession
  if (Array.isArray(raw.run?.events)) {
    for (const event of raw.run.events) session.pushEvent(event)
  }
  return {
    ...raw,
    run: { ...raw.run, session: session as unknown as Session<S> },
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
      timing: {
        responseTimes: [],
        silenceGaps: [],
        interruptions: { count: 0, byAgent: 0, byUser: 0 },
        vadResolutionMs: 0,
      },
      recording: { path: '' },
      error: { message },
      durationMs: 0,
    },
    durationMs: 0,
    error: { message },
    ...(repeat && { repeatIndex: repeat.index, repeatTotal: repeat.total }),
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function evaluateVoice<S extends StateSchema = StateSchema>(
  caseOrCases: VoiceEvalCase<S> | VoiceEvalCase<S>[],
  options: VoiceEvalOptions<S>,
): Promise<VoiceEvalResult<S>> {
  const cases = Array.isArray(caseOrCases) ? caseOrCases : [caseOrCases]

  // ── Worker mode: run assigned case, send result, exit ──────────────
  if (isProcessWorker()) {
    await runAsWorker(cases, options)
    return undefined as never
  }

  // ── Orchestrator (main process) ────────────────────────────────────
  const startTime = Date.now()
  const resolvedOptions = resolveRoomConfig(options)
  const concurrency = Math.max(1, resolvedOptions.concurrency ?? 4)
  const suiteMetrics = (resolvedOptions.metrics ?? []) as Metric<VoiceRunResult<S>>[]

  if (resolvedOptions.output) {
    rmSync(resolvedOptions.output, { recursive: true, force: true })
    mkdirSync(resolvedOptions.output, { recursive: true })
  }

  const caseRuns = expandCaseRuns(cases, resolvedOptions.repeat)

  // Pre-compute labels/dirNames so writeIndex doesn't need a linear search.
  const runMeta = caseRuns.map((r) => ({
    label: caseRunLabel(r),
    dirName: caseRunDirName(r),
  }))

  const caseStatuses = new Map<number, string>(caseRuns.map((_, i) => [i, 'pending']))

  const writeIndex = resolvedOptions.output
    ? () => {
        const lines: string[] = [`# Voice Eval — ${new Date().toLocaleString()}`, '']
        const completed = [...caseStatuses.values()].filter(
          (s) => s !== 'pending' && s !== 'running...',
        )
        lines.push(`${completed.length}/${caseRuns.length} complete`)
        lines.push('')
        for (const [i, st] of caseStatuses) {
          const { label, dirName } = runMeta[i]
          lines.push(`- [${label}](./${dirName}/report.md) — ${st}`)
        }
        lines.push('')
        writeFileSync(join(resolvedOptions.output!, 'index.md'), lines.join('\n'))
      }
    : undefined

  writeIndex?.()

  // ── runCase ────────────────────────────────────────────────────────
  // concurrency > 1 automatically forks each case into its own child
  // process so every WebRTC session gets its own event loop and native
  // thread pool. Stagger initial launches to avoid a connection storm.
  const useForkedWorkers = concurrency > 1
  const STAGGER_MS = 2_000
  let completedCount = 0

  const runCase = async (
    run: CaseRun<VoiceEvalCase<S>>,
    runIndex: number,
  ): Promise<VoiceEvalCaseResult<S>> => {
    if (useForkedWorkers && runIndex < concurrency) {
      const delay = runIndex * STAGGER_MS
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    }

    caseStatuses.set(runIndex, 'running...')
    writeIndex?.()

    const repeat =
      run.repeatIndex != null ? { index: run.repeatIndex, total: run.repeatTotal! } : undefined

    const result = useForkedWorkers
      ? await forkCase(runIndex).then(
          (raw) => hydrateWorkerResult<S>(raw),
          (err) => workerError<S>(run.item.name, err, repeat),
        )
      : await runSingleVoiceEval(
          run.item,
          resolvedOptions,
          suiteMetrics,
          runMeta[runIndex].dirName,
          repeat,
        )

    caseStatuses.set(runIndex, `${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`)
    writeIndex?.()

    completedCount++
    resolvedOptions.onCase?.(result, completedCount, caseRuns.length)
    return result
  }

  const shouldStop = resolvedOptions.stopOnFirstFailure
    ? (r: VoiceEvalCaseResult<S>) => r.status === 'failed' || r.status === 'error'
    : undefined

  const results =
    concurrency === 1
      ? await runSequential(caseRuns, runCase, shouldStop)
      : await runWithPool(caseRuns, runCase, concurrency, shouldStop)

  return {
    summary: buildSummary(results),
    results,
    durationMs: Date.now() - startTime,
  }
}
