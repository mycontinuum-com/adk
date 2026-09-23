import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Event } from '../../types/events'
import type { UsageSummary } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'
import type { Session } from '../../types/session'
import type { VoiceEvent } from '../../voice/types'
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
  type CaseRun,
} from '../suite-runner'
import { createCaseWriter } from './case-writer'
import { isProcessWorker, getWorkerCaseIndex, sendWorkerResult, forkCase } from './process-pool'
import { runVoiceCase } from './runner'

type SerializedVoiceRun = Omit<VoiceRunResult, 'session'>
type SerializedVoiceResult = Omit<VoiceEvalCaseResult, 'run'> & { run: SerializedVoiceRun }
const EVAL_STATUSES = new Set<EvalStatus>([
  'passed',
  'failed',
  'error',
  'terminated',
  'aborted',
  'timeout',
])

const VOICE_RUN_STATUSES = new Set<VoiceRunStatus>([
  'completed',
  'error',
  'timeout',
  'inactivity_timeout',
  'max_duration',
  'disconnected',
  'participant_left',
])

const EVENT_TYPES = new Set<Event['type']>([
  'system',
  'user',
  'assistant',
  'thought',
  'tool_call',
  'tool_yield',
  'tool_input',
  'tool_result',
  'state_change',
  'invocation_start',
  'invocation_end',
  'invocation_yield',
  'invocation_resume',
  'model_start',
  'model_end',
  'artifact_update',
  'annotation',
])

const WORKER_STAGGER_MS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isErrorDetails(value: unknown): value is { message: string; stack?: string } {
  return (
    isRecord(value) &&
    typeof value.message === 'string' &&
    (value.stack === undefined || typeof value.stack === 'string')
  )
}

function isMetricResult(value: unknown): value is MetricResult {
  return (
    isRecord(value) &&
    typeof value.passed === 'boolean' &&
    (value.score === undefined || isFiniteNumber(value.score)) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) &&
        value.evidence.every((entry) => typeof entry === 'string'))) &&
    (value.data === undefined || isRecord(value.data))
  )
}

function isMetricResults(value: unknown): value is Record<string, MetricResult> {
  return isRecord(value) && Object.values(value).every(isMetricResult)
}

function isEvent(value: unknown): value is Event {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    EVENT_TYPES.has(value.type as Event['type']) &&
    isFiniteNumber(value.createdAt)
  )
}

function isVoiceEvent(value: unknown): value is VoiceEvent & { createdAt: number } {
  return isRecord(value) && typeof value.type === 'string' && isFiniteNumber(value.createdAt)
}

function isTranscriptEntry(
  value: unknown,
): value is { role: 'assistant' | 'user'; text: string; turnIndex: number } {
  return (
    isRecord(value) &&
    (value.role === 'assistant' || value.role === 'user') &&
    typeof value.text === 'string' &&
    isFiniteNumber(value.turnIndex) &&
    (value.startMs === undefined || isFiniteNumber(value.startMs)) &&
    (value.endMs === undefined || isFiniteNumber(value.endMs))
  )
}

function isTimingEntry(value: unknown): value is { ms: number; afterTurnIndex: number } {
  return (
    isRecord(value) &&
    isFiniteNumber(value.ms) &&
    isFiniteNumber(value.afterTurnIndex) &&
    (value.speaker === undefined || value.speaker === 'agent' || value.speaker === 'user')
  )
}

function isVoiceTiming(value: unknown): value is VoiceRunResult['timing'] {
  return (
    isRecord(value) &&
    (value.timeToFirstSpeechMs === undefined || isFiniteNumber(value.timeToFirstSpeechMs)) &&
    Array.isArray(value.responseTimes) &&
    value.responseTimes.every(isTimingEntry) &&
    Array.isArray(value.silenceGaps) &&
    value.silenceGaps.every(isTimingEntry) &&
    isRecord(value.interruptions) &&
    isFiniteNumber(value.interruptions.count) &&
    isFiniteNumber(value.interruptions.byAgent) &&
    isFiniteNumber(value.interruptions.byUser) &&
    isFiniteNumber(value.vadResolutionMs)
  )
}

function isCostEstimate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.inputCost) &&
    isFiniteNumber(value.outputCost) &&
    isFiniteNumber(value.totalCost) &&
    value.currency === 'USD'
  )
}

function isModelUsageEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.provider === undefined || typeof value.provider === 'string') &&
    (value.reportedCostUSD === undefined || isFiniteNumber(value.reportedCostUSD)) &&
    typeof value.modelName === 'string' &&
    isFiniteNumber(value.calls) &&
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.cachedTokens) &&
    (value.cacheWriteTokens === undefined || isFiniteNumber(value.cacheWriteTokens)) &&
    isFiniteNumber(value.reasoningTokens) &&
    isFiniteNumber(value.audioInputTokens) &&
    isFiniteNumber(value.audioOutputTokens) &&
    (value.cost === undefined || isCostEstimate(value.cost))
  )
}

function isUsageSummary(value: unknown): value is UsageSummary {
  return (
    isRecord(value) &&
    (value.reportedCostUSD === undefined || isFiniteNumber(value.reportedCostUSD)) &&
    Array.isArray(value.models) &&
    value.models.every(isModelUsageEntry) &&
    isFiniteNumber(value.totalInputTokens) &&
    isFiniteNumber(value.totalOutputTokens) &&
    isFiniteNumber(value.totalCachedTokens) &&
    (value.totalCacheWriteTokens === undefined || isFiniteNumber(value.totalCacheWriteTokens)) &&
    isFiniteNumber(value.totalReasoningTokens) &&
    isFiniteNumber(value.totalAudioInputTokens) &&
    isFiniteNumber(value.totalAudioOutputTokens) &&
    isFiniteNumber(value.modelCalls) &&
    (value.cost === undefined || isCostEstimate(value.cost))
  )
}

function isSerializedVoiceResult(value: unknown): value is SerializedVoiceResult {
  if (!isRecord(value) || !isRecord(value.run)) return false
  const run = value.run
  return (
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    EVAL_STATUSES.has(value.status as EvalStatus) &&
    isMetricResults(value.metrics) &&
    isFiniteNumber(value.durationMs) &&
    (value.usage === undefined || isUsageSummary(value.usage)) &&
    (value.error === undefined || isErrorDetails(value.error)) &&
    (value.attempts === undefined || isFiniteNumber(value.attempts)) &&
    (value.repeatIndex === undefined || isFiniteNumber(value.repeatIndex)) &&
    (value.repeatTotal === undefined || isFiniteNumber(value.repeatTotal)) &&
    typeof run.status === 'string' &&
    VOICE_RUN_STATUSES.has(run.status as VoiceRunStatus) &&
    isFiniteNumber(run.startedAtMs) &&
    Array.isArray(run.events) &&
    run.events.every(isEvent) &&
    Array.isArray(run.voiceEvents) &&
    run.voiceEvents.every(isVoiceEvent) &&
    Array.isArray(run.transcript) &&
    run.transcript.every(isTranscriptEntry) &&
    isVoiceTiming(run.timing) &&
    isRecord(run.recording) &&
    typeof run.recording.path === 'string' &&
    (run.usage === undefined || isUsageSummary(run.usage)) &&
    (run.error === undefined || isErrorDetails(run.error)) &&
    isFiniteNumber(run.durationMs)
  )
}

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
    caseRunDirName(run, caseIndex),
    repeat,
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

function hydrateWorkerResult<S extends StateSchema>(raw: unknown): VoiceEvalCaseResult<S> {
  if (typeof raw !== 'string') {
    throw new Error('Voice worker returned an invalid evaluation result')
  }
  let result: unknown
  try {
    result = JSON.parse(raw)
  } catch {
    throw new Error('Voice worker returned an invalid evaluation result')
  }
  if (!isSerializedVoiceResult(result))
    throw new Error('Voice worker returned an invalid evaluation result')
  const session = createEvalSession() as BaseSession
  for (const event of result.run.events) session.pushEvent(event)
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

/** Runs one or more voice cases, using child workers when concurrency exceeds one. */
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

  const startTime = Date.now()
  const { caseRuns, runCase, concurrency } = prepareVoiceEvaluation(cases, options)
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
        )

    caseStatuses.set(runIndex, `${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`)
    writeIndex()
    completedCount++
    resolvedOptions.onCase?.(result, completedCount, caseRuns.length)
    return result
  }
  return { caseRuns, runCase, concurrency }
}
