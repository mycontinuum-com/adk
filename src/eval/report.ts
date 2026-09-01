import type { StateSchema } from '../types/schema'
import type { BaseEvalCaseResult, BaseEvalResult, EvalResult } from './types'

export interface ReportOptions<
  S extends StateSchema = StateSchema,
  R extends BaseEvalResult = EvalResult<S>,
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
  R extends BaseEvalResult = EvalResult<S>,
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

function formatSummary(result: BaseEvalResult, lines: string[]): void {
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
  }

  if (hasUsage) {
    lines.push(
      `**Tokens:** ${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`,
    )
    if (totalCost > 0) {
      lines.push(`**Cost:** $${totalCost.toFixed(2)}`)
    }
  }
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
