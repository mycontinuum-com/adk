import type { Metric, MetricResult } from './metrics/types'
import type { EvalStatus, EvalSummary } from './types'

export async function runSequential<TCase, TResult>(
  cases: TCase[],
  runCase: (c: TCase, index: number) => Promise<TResult>,
  shouldStop?: (r: TResult) => boolean,
): Promise<TResult[]> {
  const results: TResult[] = []

  for (let i = 0; i < cases.length; i++) {
    const result = await runCase(cases[i], i)
    results.push(result)
    if (shouldStop?.(result)) break
  }

  return results
}

export async function runWithPool<TCase, TResult>(
  cases: TCase[],
  runCase: (c: TCase, index: number) => Promise<TResult>,
  concurrency: number,
  shouldStop?: (r: TResult) => boolean,
): Promise<TResult[]> {
  const results: TResult[] = Array.from({ length: cases.length })
  let nextIndex = 0
  let stopped = false

  const claimNext = (): number => nextIndex++

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = claimNext()
      if (index >= cases.length) break

      const result = await runCase(cases[index], index)
      if (stopped) break
      results[index] = result

      if (shouldStop?.(result)) {
        stopped = true
      }
    }
  }

  const workerCount = concurrency === Infinity ? cases.length : Math.min(concurrency, cases.length)

  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results.filter(Boolean)
}

export async function runMetrics<TRun>(
  run: TRun,
  metrics?: Metric<TRun>[],
): Promise<Record<string, MetricResult>> {
  const results: Record<string, MetricResult> = {}
  if (!metrics || metrics.length === 0) return results

  for (const metric of metrics) {
    try {
      results[metric.name] = await metric.evaluate(run)
    } catch (error) {
      results[metric.name] = {
        passed: false,
        evidence: [
          `Metric evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      }
    }
  }

  return results
}

export function mergeMetrics<TRun>(
  suiteMetrics: Metric<TRun>[],
  caseMetrics: Metric<TRun>[],
  caseName: string,
  label = 'eval',
): Metric<TRun>[] {
  const suiteNames = new Set(suiteMetrics.map((m) => m.name))
  for (const m of caseMetrics) {
    if (suiteNames.has(m.name)) {
      console.warn(
        `[adk:${label}] Metric "${m.name}" on case "${caseName}" shadows a suite-level metric`,
      )
    }
  }
  return [...suiteMetrics, ...caseMetrics]
}

export function buildSummary(results: { status: EvalStatus }[]): EvalSummary {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    errors: results.filter((r) => r.status === 'error').length,
    terminated: results.filter((r) => r.status === 'terminated').length,
    aborted: results.filter((r) => r.status === 'aborted').length,
    timedOut: results.filter((r) => r.status === 'timeout').length,
  }
}

// ---------------------------------------------------------------------------
// Case repeat expansion (shared by simulator + voice evaluate)
// ---------------------------------------------------------------------------

export interface CaseRun<T> {
  item: T
  repeatIndex?: number
  repeatTotal?: number
}

/**
 * Expand a list of cases into repeated runs. `repeat` values ≤ 1 produce one run per case with no
 * repeat metadata.
 */
export function expandCaseRuns<T>(cases: T[], repeat?: number): CaseRun<T>[] {
  const n = Math.max(1, repeat ?? 1)
  const runs: CaseRun<T>[] = []
  for (const item of cases) {
    if (n > 1) {
      for (let i = 1; i <= n; i++) {
        runs.push({ item, repeatIndex: i, repeatTotal: n })
      }
    } else {
      runs.push({ item })
    }
  }
  return runs
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  makeError?: (ms: number) => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(makeError ? makeError(ms) : new Error(`Timed out after ${ms}ms`)),
      ms,
    )
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
