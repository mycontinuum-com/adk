import type { AdkApp } from '../api'
import type { Simulator } from '../run/simulate'
import type { Runnable } from '../types/runnables'
import type { RunResult } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { Session } from '../types/session'
import type {
  EvalCase,
  EvalOptions,
  EvalCaseResult,
  EvalResult,
  EvalStatus,
  MetricResult,
} from './types'

import { interceptTools } from './interceptTools'
import { createEvalSession } from './session'
import {
  runSequential,
  runWithPool,
  runMetrics,
  mergeMetrics,
  buildSummary,
  withTimeout,
  expandCaseRuns,
  type CaseRun,
} from './suite-runner'

export function evaluate<S extends StateSchema = StateSchema>(
  app: AdkApp<S>,
  caseOrCases: EvalCase<S> | EvalCase<S>[],
  options?: EvalOptions<S>,
): Promise<EvalResult<S>> {
  const simulate: Simulator = (runnable, opts) => app.simulate(runnable, opts)
  const cases = Array.isArray(caseOrCases) ? caseOrCases : [caseOrCases]
  return runSuiteEval(simulate, cases as EvalCase[], options as EvalOptions) as Promise<
    EvalResult<S>
  >
}

function runResultFromError(
  runnable: Runnable<any>,
  session: Session,
  errorMessage: string,
): RunResult {
  return {
    runnable,
    session,
    state: session.state,
    iterations: 0,
    output: { text: undefined, value: undefined, items: [] },
    status: 'error',
    error: errorMessage,
  }
}

function mapRunStatus(runStatus: string, metricResults: Record<string, MetricResult>): EvalStatus {
  switch (runStatus) {
    case 'terminated':
      return 'terminated'
    case 'error':
      return 'error'
    case 'aborted':
      return 'aborted'
    default:
      return Object.values(metricResults).every((r) => r.passed) ? 'passed' : 'failed'
  }
}

class EvalTimeoutError extends Error {
  constructor(ms: number) {
    super(`Eval case timed out after ${ms}ms`)
    this.name = 'EvalTimeoutError'
  }
}

async function runSingleEval(
  simulate: Simulator,
  evalCase: EvalCase,
  options?: EvalOptions,
): Promise<EvalCaseResult> {
  const maxAttempts = Math.max(1, (evalCase.retries ?? 0) + 1)

  let lastResult: EvalCaseResult | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await runSingleAttempt(simulate, evalCase, options)
    lastResult.attempts = attempt

    if (lastResult.status === 'passed') {
      return lastResult
    }

    if (
      attempt < maxAttempts &&
      (lastResult.status === 'failed' ||
        lastResult.status === 'error' ||
        lastResult.status === 'timeout')
    ) {
      continue
    }
  }

  return lastResult!
}

async function runSingleAttempt(
  simulate: Simulator,
  evalCase: EvalCase,
  options?: EvalOptions,
): Promise<EvalCaseResult> {
  const startTime = Date.now()

  const runnable = evalCase.toolMocks
    ? interceptTools(evalCase.runnable, evalCase.toolMocks)
    : evalCase.runnable

  const session = createEvalSession()

  try {
    const simulatePromise = simulate(runnable, {
      session,
      input: evalCase.input,
      userAgent: evalCase.userAgent,
      toolAgents: evalCase.toolAgents,
      transform: evalCase.transform,
      maxTurns: evalCase.maxTurns,
      maxDuration: evalCase.maxDuration,
      stateMatches: evalCase.stateMatches,
      hooks: options?.hooks,
    })

    const result = evalCase.timeout
      ? await withTimeout(simulatePromise, evalCase.timeout, (ms) => new EvalTimeoutError(ms))
      : await simulatePromise

    const merged = mergeMetrics(options?.metrics ?? [], evalCase.metrics ?? [], evalCase.name)
    const metricResults = await runMetrics(result, merged)

    const status = mapRunStatus(result.status, metricResults)
    const events = result.session.events

    return {
      name: evalCase.name,
      status,
      metrics: metricResults,
      run: result,
      events,
      usage: result.usage,
      turns: events.filter((e) => e.type === 'user').length,
      durationMs: Date.now() - startTime,
      ...(result.status === 'terminated' && {
        terminationReason: result.terminationReason,
      }),
      ...(result.status === 'error' && {
        error: { message: result.error },
      }),
    }
  } catch (error) {
    const isTimeout = error instanceof EvalTimeoutError
    const run = runResultFromError(
      runnable,
      session,
      error instanceof Error ? error.message : String(error),
    )
    const events = run.session.events
    return {
      name: evalCase.name,
      status: isTimeout ? 'timeout' : 'error',
      metrics: {},
      run,
      events,
      usage: run.usage,
      turns: events.filter((e) => e.type === 'user').length,
      durationMs: Date.now() - startTime,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    }
  }
}

async function runSuiteEval(
  simulate: Simulator,
  cases: EvalCase[],
  options?: EvalOptions,
): Promise<EvalResult> {
  const startTime = Date.now()
  const concurrency = Math.max(1, options?.concurrency ?? 64)
  const caseRuns = expandCaseRuns(cases, options?.repeat)

  let completedCount = 0
  const runCase = async (run: CaseRun<EvalCase>): Promise<EvalCaseResult> => {
    const result = await runSingleEval(simulate, run.item, {
      hooks: options?.hooks,
      metrics: options?.metrics,
    })
    if (run.repeatIndex != null) {
      result.repeatIndex = run.repeatIndex
      result.repeatTotal = run.repeatTotal
    }
    completedCount++
    options?.onCase?.(result, completedCount, caseRuns.length)
    return result
  }

  const shouldStop = options?.stopOnFirstFailure
    ? (r: EvalCaseResult) => r.status === 'failed' || r.status === 'error'
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
