import type { CostAccount } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { AnyEvalCaseResult, BaseEvalCaseResult, BaseEvalResult, EvalResult } from './types'
import type { LiveVoiceEvalUsage } from './voice/types'

import { formatCost, formatCostAccount, sumCosts, usageCost } from '../providers/pricing'

export interface ReportOptions<
  S extends StateSchema = StateSchema,
  R extends BaseEvalResult<AnyEvalCaseResult<S>> = EvalResult<S>,
> {
  title?: string
  footer?: string | ((result: R) => string)
  sections?: Array<{
    title: string
    content: (result: R) => string
  }>
  renderCase?: (result: R['results'][number]) => string | undefined
}

export function generateReport<
  S extends StateSchema = StateSchema,
  R extends BaseEvalResult<AnyEvalCaseResult<S>> = EvalResult<S>,
>(result: R, options?: ReportOptions<S, R>): string {
  const title = options?.title ?? 'Eval Report'
  const lines: string[] = []

  lines.push(`# ${title}`)
  lines.push('')

  formatSummary(result, lines)
  lines.push('')

  formatMetrics(result, lines)
  lines.push('')

  if (options?.sections?.length) {
    for (const section of options.sections) {
      lines.push(`## ${section.title}`)
      lines.push('')
      lines.push(section.content(result))
      lines.push('')
    }
  }

  lines.push('## Cases')
  lines.push('')

  const sortedResults = [...result.results].toSorted((a, b) => a.name.localeCompare(b.name))

  if (options?.renderCase) {
    for (const r of sortedResults) {
      const block = options.renderCase(r)
      if (block !== undefined) {
        lines.push(block)
        lines.push('')
      }
    }
  } else {
    formatCases(sortedResults, lines)
    lines.push('')
  }

  const footer = typeof options?.footer === 'function' ? options.footer(result) : options?.footer
  if (footer !== undefined && footer !== '') {
    lines.push('---')
    lines.push('')
    lines.push(`_${footer}_`)
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

function formatSummary(result: BaseEvalResult<AnyEvalCaseResult>, lines: string[]): void {
  const { summary, durationMs } = result
  const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(3) : '0.000'

  lines.push(`**Pass Rate:** ${passRate}% (${summary.passed}/${summary.total})`)
  if (summary.failed > 0) lines.push(`**Failed:** ${summary.failed}`)
  if (summary.errors > 0) lines.push(`**Errors:** ${summary.errors}`)
  if (summary.terminated > 0) lines.push(`**Terminated:** ${summary.terminated}`)
  if (summary.aborted > 0) lines.push(`**Aborted:** ${summary.aborted}`)
  if (summary.timedOut > 0) lines.push(`**Timed Out:** ${summary.timedOut}`)
  lines.push(`**Duration:** ${(durationMs / 1000).toFixed(1)}s`)

  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  let hasUsage = false

  for (const r of result.results) {
    const u = r.usage
    if (u) {
      hasUsage = true
      totalInput += u.totalInputTokens
      totalOutput += u.totalOutputTokens
      if (u.cost) totalCost += u.cost.totalCost
    }
    for (const usage of metricUsage(r)) {
      hasUsage = true
      totalInput += usage.totalInputTokens
      totalOutput += usage.totalOutputTokens
    }
  }

  if (hasUsage) {
    lines.push(
      `**Tokens:** ${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`,
    )
  }

  const cost = suiteCost(result.results)
  if (cost.backend || cost.judge) {
    const partial = cost.known
      ? ` (${formatCost(cost.known.totalCost)} known across ${cost.known.caseCount} of ${result.results.length} cases)`
      : ''
    const components = COST_COMPONENTS.flatMap(([key, label]) => {
      const account = cost[key]
      return account ? [`${label} ${formatCostAccount(account)}`] : []
    })
    lines.push(`**Cost:** ${formatCostAccount(cost.total)}${partial} — ${components.join(', ')}`)
  } else if (hasUsage && totalCost > 0) {
    lines.push(`**Cost:** $${totalCost.toFixed(2)}`)
  }
}

/** What a suite spent, as `result.json` records it under `cost` and `report.md` prints it. */
export interface SuiteCost {
  /** Every case's own spend plus its judge spend. */
  total: CostAccount
  /** Set when `total` is unavailable: the sum over the cases whose whole cost is known. */
  known?: { totalCost: number; caseCount: number }
  /** GPT Live cases' backend, voice and simulated caller spend. */
  backend?: CostAccount
  voice?: CostAccount
  caller?: CostAccount
  /** With GPT Live cases: the other cases' own spend. */
  otherCases?: CostAccount
  /** Without GPT Live cases: every case's own spend. */
  cases?: CostAccount
  /** Model calls the cases' metrics made, such as judge calls. Set when a metric reported usage. */
  judge?: CostAccount
}

const COST_COMPONENTS = [
  ['backend', 'backend'],
  ['voice', 'voice'],
  ['caller', 'caller'],
  ['otherCases', 'other cases'],
  ['cases', 'cases'],
  ['judge', 'judge'],
] as const satisfies ReadonlyArray<readonly [keyof SuiteCost, string]>

export function suiteCost(results: readonly AnyEvalCaseResult[]): SuiteCost {
  const live = results.flatMap((r) => {
    const usage = liveUsageOf(r)
    return usage ? [usage] : []
  })
  const others = results.filter((r) => !liveUsageOf(r))
  const judged = results.flatMap((r) => {
    const cost = caseJudgeCost(r)
    return cost ? [cost] : []
  })
  const caseTotals = results.map((r) =>
    sumCosts([liveUsageOf(r)?.total ?? caseCost(r), caseJudgeCost(r) ?? FREE]),
  )
  const total = sumCosts(caseTotals)
  const known = caseTotals.flatMap((cost) => (cost.basis === 'unavailable' ? [] : [cost.totalCost]))
  return {
    total,
    ...(total.basis === 'unavailable' && {
      known: { totalCost: known.reduce((sum, cost) => sum + cost, 0), caseCount: known.length },
    }),
    ...(live.length
      ? {
          backend: sumCosts(live.map((usage) => usage.backend.cost)),
          voice: sumCosts(live.map((usage) => usage.voice.cost)),
          caller: sumCosts(live.map((usage) => usage.caller.cost)),
          ...(others.length > 0 && { otherCases: sumCosts(others.map(caseCost)) }),
        }
      : { cases: sumCosts(results.map(caseCost)) }),
    ...(judged.length > 0 && { judge: sumCosts(judged) }),
  }
}

const FREE: CostAccount = { basis: 'reported', totalCost: 0, currency: 'USD' }

function metricUsage(result: BaseEvalCaseResult) {
  return Object.values(result.metrics).flatMap((metric) => (metric.usage ? [metric.usage] : []))
}

/**
 * Cost the case's metrics spent, such as judge calls, or `undefined` when no metric reported usage.
 * A judge call that failed reports its usage too, so a metric error does not hide this figure.
 */
export function caseJudgeCost(result: BaseEvalCaseResult): CostAccount | undefined {
  const usage = metricUsage(result)
  return usage.length ? sumCosts(usage.map(usageCost)) : undefined
}

function liveUsageOf(result: AnyEvalCaseResult): LiveVoiceEvalUsage | undefined {
  return 'liveUsage' in result.run ? result.run.liveUsage : undefined
}

/**
 * Cost of a non-Live case's own run. A run that errored, timed out or was aborted may have stopped
 * with a billed model call unrecorded. A metric error leaves the run's recorded usage complete.
 */
function caseCost(result: BaseEvalCaseResult): CostAccount {
  const interrupted =
    result.error !== undefined || result.status === 'timeout' || result.status === 'aborted'
  return interrupted ? { basis: 'unavailable' } : usageCost(result.usage)
}

function formatMetrics(result: BaseEvalResult, lines: string[]): void {
  const metricNames = new Set<string>()
  for (const r of result.results) {
    for (const name of Object.keys(r.metrics)) {
      metricNames.add(name)
    }
  }

  const sortedNames = [...metricNames].toSorted()

  if (sortedNames.length === 0) {
    lines.push('## Metrics')
    lines.push('')
    lines.push('No metrics.')
    return
  }

  lines.push('## Metrics')
  lines.push('')

  for (const name of sortedNames) {
    let n = 0
    let passed = 0
    const scores: number[] = []

    for (const r of result.results) {
      const m = r.metrics[name]
      if (!m) continue
      n++
      if (m.passed) passed++
      if (typeof m.score === 'number' && m.score >= 0 && m.score <= 1) {
        scores.push(m.score)
      }
    }

    const passRate = n > 0 ? ((passed / n) * 100).toFixed(3) : '0.000'
    const parts = [`${passRate}% pass`, `n=${n}`]
    if (scores.length > 0) {
      const mean = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)
      parts.push(`mean=${mean}`)
    }

    lines.push(`**${name}:** ${parts.join(', ')}`)
  }
}

function formatCases(results: BaseEvalCaseResult[], lines: string[]): void {
  const groups = groupRepeatedCases(results)

  if (groups.type === 'repeated') {
    formatRepeatedCases(groups.groups, lines)
    return
  }

  const failures = results.filter((r) => r.status !== 'passed')

  if (failures.length === 0) {
    lines.push(`All ${results.length} cases passed.`)
    return
  }

  for (const r of failures) {
    formatSingleFailure(r, lines)
  }
}

interface RepeatedGroup {
  baseName: string
  results: BaseEvalCaseResult[]
}

function groupRepeatedCases(
  results: BaseEvalCaseResult[],
): { type: 'flat' } | { type: 'repeated'; groups: RepeatedGroup[] } {
  const groups = new Map<string, BaseEvalCaseResult[]>()
  let hasRepeats = false

  for (const r of results) {
    if (r.repeatIndex != null) hasRepeats = true
    const existing = groups.get(r.name) ?? []
    existing.push(r)
    groups.set(r.name, existing)
  }

  if (!hasRepeats) return { type: 'flat' }

  const sorted = [...groups.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([baseName, caseResults]) => ({ baseName, results: caseResults }))

  return { type: 'repeated', groups: sorted }
}

function formatRepeatedCases(groups: RepeatedGroup[], lines: string[]): void {
  for (const group of groups) {
    const { baseName, results } = group
    const total = results.length
    const passed = results.filter((r) => r.status === 'passed').length
    const passRate = ((passed / total) * 100).toFixed(1)
    const durations = results.map((r) => r.durationMs)
    const meanDuration = Math.round(durations.reduce((a, b) => a + b, 0) / total)
    const minDuration = Math.min(...durations)
    const maxDuration = Math.max(...durations)

    const icon = passed === total ? 'PASS' : passed === 0 ? 'FAIL' : 'MIXED'
    lines.push(`### ${baseName} — ${icon} (${passed}/${total}, ${passRate}%)`)
    lines.push('')
    lines.push(`- **Duration:** mean=${meanDuration}ms, min=${minDuration}ms, max=${maxDuration}ms`)

    const metricNames = new Set<string>()
    for (const r of results) {
      for (const name of Object.keys(r.metrics)) metricNames.add(name)
    }

    for (const metricName of [...metricNames].toSorted()) {
      const metricResults = results.map((r) => r.metrics[metricName]).filter(Boolean)
      const metricPassed = metricResults.filter((m) => m.passed).length
      const metricTotal = metricResults.length
      lines.push(`- **${metricName}:** ${metricPassed}/${metricTotal} passed`)
    }

    const failures = results.filter((r) => r.status !== 'passed')
    if (failures.length > 0 && failures.length <= 5) {
      lines.push('')
      lines.push('**Failures:**')
      for (const r of failures) {
        const label = r.repeatIndex != null ? `run ${r.repeatIndex}` : r.name
        const details: string[] = []
        for (const [name, m] of Object.entries(r.metrics)) {
          if (!m.passed && m.evidence?.length) {
            details.push(`${name}: ${m.evidence.join(', ')}`)
          }
        }
        if (r.error) details.push(`error: ${r.error.message}`)
        if ('terminationReason' in r && r.terminationReason)
          details.push(`terminated: ${r.terminationReason}`)
        lines.push(`- ${label} (${r.status}): ${details.join('; ') || 'no details'}`)
      }
    } else if (failures.length > 5) {
      lines.push('')
      lines.push(`**Failures:** ${failures.length} runs failed (showing first 5)`)
      for (const r of failures.slice(0, 5)) {
        const label = r.repeatIndex != null ? `run ${r.repeatIndex}` : r.name
        lines.push(`- ${label} (${r.status})`)
      }
    }

    lines.push('')
  }
}

function formatSingleFailure(r: BaseEvalCaseResult, lines: string[]): void {
  lines.push(`### ${r.name} — ${r.status} (${r.durationMs}ms)`)
  lines.push('')
  for (const [name, m] of Object.entries(r.metrics)) {
    if (!m.passed && m.evidence?.length) {
      lines.push(`- **${name}:** ${m.evidence.join(', ')}`)
    }
  }
  if (r.error) {
    lines.push(`- **error:** ${r.error.message}`)
  }
  if ('terminationReason' in r && r.terminationReason) {
    lines.push(`- **terminated:** ${r.terminationReason}`)
  }
  if (r.attempts && r.attempts > 1) {
    lines.push(`- **attempts:** ${r.attempts}`)
  }
  lines.push('')
}
