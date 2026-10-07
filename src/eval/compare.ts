import type { Event } from '../types/events'
import type { EvalStatus } from './types'

/** One run of a case as a comparison reads it, from this run or a saved one. */
export interface ComparedRun {
  name: string
  status: EvalStatus
  events: readonly Event[]
}

interface PassCount {
  passed: number
  runs: number
}

/**
 * How a case's pass rate moved against the baseline. `unclear` means the rates differ but the run
 * counts cannot separate the difference from chance.
 */
type Change = 'improved' | 'regressed' | 'unchanged' | 'unclear'

interface CaseComparison {
  name: string
  baseline: PassCount
  current: PassCount
  /** Two-sided Fisher exact p-value that both sides pass at the same rate. */
  p: number
  change: Change
}

/** A tool result that one side returned and the other never did, over the cases that returned it. */
interface ToolResultChange {
  tool: string
  result: string
  cases: string[]
  /** Runs that returned it, of those cases' runs on the side that did. */
  returned: number
  of: number
  /** Those cases' runs on the side that never returned it. */
  never: number
  p: number
}

export interface RunComparison {
  /** `p` below this is a change. */
  alpha: number
  /** Over the cases both sides ran. */
  overall: Omit<CaseComparison, 'name'>
  cases: CaseComparison[]
  /**
   * What the tools returned differently, whether or not a check noticed. A tool's result is the
   * code's doing, where a reply's wording is the model's and differs on every run.
   */
  toolResults: { appeared: ToolResultChange[]; vanished: ToolResultChange[] }
  /** Cases only the current run has, and cases only the baseline has. */
  added: string[]
  removed: string[]
}

const logFactorials = [0]
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++)
    logFactorials[i] = logFactorials[i - 1] + Math.log(i)
  return logFactorials[n]
}

/**
 * Two-sided Fisher exact test on two pass counts: the probability, if both sides passed at one
 * rate, of a split at least as uneven as this one.
 */
export function fisherExact(a: PassCount, b: PassCount): number {
  const passed = a.passed + b.passed
  const runs = a.runs + b.runs
  if (a.runs === 0 || b.runs === 0 || passed === 0 || passed === runs) return 1
  const logProbability = (k: number) =>
    logFactorial(a.runs) -
    logFactorial(k) -
    logFactorial(a.runs - k) +
    logFactorial(b.runs) -
    logFactorial(passed - k) -
    logFactorial(b.runs - passed + k) -
    (logFactorial(runs) - logFactorial(passed) - logFactorial(runs - passed))
  const observed = logProbability(a.passed)
  let p = 0
  for (let k = Math.max(0, passed - b.runs); k <= Math.min(a.runs, passed); k++) {
    const probability = logProbability(k)
    if (probability <= observed + 1e-9) p += Math.exp(probability)
  }
  // The summed tail of an even split can fall a rounding error short of 1.
  return p > 1 - 1e-9 ? 1 : p
}

function compare(baseline: PassCount, current: PassCount, alpha: number) {
  const p = fisherExact(baseline, current)
  const before = baseline.passed / baseline.runs
  const after = current.passed / current.runs
  const change: Change =
    before === after
      ? 'unchanged'
      : p >= alpha
        ? 'unclear'
        : after > before
          ? 'improved'
          : 'regressed'
  return { baseline, current, p, change }
}

function byCase(runs: readonly ComparedRun[]): Map<string, ComparedRun[]> {
  const cases = new Map<string, ComparedRun[]>()
  for (const run of runs) cases.set(run.name, [...(cases.get(run.name) ?? []), run])
  return cases
}

const passCount = (runs: readonly ComparedRun[]): PassCount => ({
  passed: runs.filter((run) => run.status === 'passed').length,
  runs: runs.length,
})

interface Returned {
  tool: string
  result: string
  /** Case → how many of its runs returned this. */
  cases: Map<string, number>
}

/** Every tool result the runs of the shared cases returned, keyed by tool and result. */
function toolResults(cases: Map<string, ComparedRun[]>, shared: readonly string[]) {
  const returned = new Map<string, Returned>()
  for (const name of shared) {
    for (const run of cases.get(name) ?? []) {
      const seen = new Set<string>()
      for (const event of run.events) {
        if (event.type !== 'tool_result') continue
        const result = JSON.stringify(event.error ?? event.result ?? null)
        const key = `${event.name} ${result}`
        if (seen.has(key)) continue
        seen.add(key)
        const entry = returned.get(key) ?? { tool: event.name, result, cases: new Map() }
        entry.cases.set(name, (entry.cases.get(name) ?? 0) + 1)
        returned.set(key, entry)
      }
    }
  }
  return returned
}

/** The results in `from` that `other` never returned, where chance does not explain the absence. */
function onlyIn(
  from: Map<string, Returned>,
  runsFrom: Map<string, ComparedRun[]>,
  other: Map<string, Returned>,
  runsOther: Map<string, ComparedRun[]>,
  alpha: number,
): ToolResultChange[] {
  const total = (runs: Map<string, ComparedRun[]>, cases: readonly string[]) =>
    cases.reduce((sum, name) => sum + (runs.get(name)?.length ?? 0), 0)
  return [...from]
    .filter(([key]) => !other.has(key))
    .map(([, entry]) => {
      const cases = [...entry.cases.keys()]
      const returned = [...entry.cases.values()].reduce((sum, count) => sum + count, 0)
      const of = total(runsFrom, cases)
      const never = total(runsOther, cases)
      const p = fisherExact({ passed: returned, runs: of }, { passed: 0, runs: never })
      return { tool: entry.tool, result: entry.result, cases, returned, of, never, p }
    })
    .filter((change) => change.p < alpha)
    .toSorted((a, b) => a.p - b.p)
}

/**
 * Compares a run with a baseline. Several baseline runs are pooled by concatenating their runs. A
 * case's verdict is a significance test on its own runs, with no correction for the number of
 * cases: at `alpha` 0.05, expect one false verdict in twenty cases whose behaviour did not change.
 */
export function compareRuns(
  baseline: readonly ComparedRun[],
  current: readonly ComparedRun[],
  alpha = 0.05,
): RunComparison {
  const before = byCase(baseline)
  const after = byCase(current)
  const shared = [...after.keys()].filter((name) => before.has(name))
  const counts = (cases: Map<string, ComparedRun[]>) =>
    passCount(shared.flatMap((name) => cases.get(name) ?? []))
  const returnedBefore = toolResults(before, shared)
  const returnedAfter = toolResults(after, shared)
  return {
    alpha,
    overall: shared.length
      ? compare(counts(before), counts(after), alpha)
      : { baseline: counts(before), current: counts(after), p: 1, change: 'unchanged' },
    cases: shared.map((name) => ({
      name,
      ...compare(passCount(before.get(name) ?? []), passCount(after.get(name) ?? []), alpha),
    })),
    toolResults: {
      appeared: onlyIn(returnedAfter, after, returnedBefore, before, alpha),
      vanished: onlyIn(returnedBefore, before, returnedAfter, after, alpha),
    },
    added: [...after.keys()].filter((name) => !before.has(name)),
    removed: [...before.keys()].filter((name) => !after.has(name)),
  }
}

const rate = (count: PassCount) =>
  `${count.passed}/${count.runs} (${count.runs ? ((count.passed / count.runs) * 100).toFixed(1) : '0.0'}%)`

const pValue = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3))

const cell = (text: string, limit = 240) =>
  (text.length > limit ? `${text.slice(0, limit - 1)}…` : text).replaceAll('|', '\\|')

function caseTable(rows: readonly CaseComparison[]): string[] {
  return [
    '| | Baseline | Current | p |',
    '| --- | --- | --- | --- |',
    ...rows
      .toSorted((a, b) => a.p - b.p || a.name.localeCompare(b.name))
      .map(
        (row) =>
          `| ${row.name} | ${rate(row.baseline)} | ${rate(row.current)} | ${pValue(row.p)} |`,
      ),
  ]
}

function toolResultTable(rows: readonly ToolResultChange[], never: string): string[] {
  return [
    `| Tool | Result | Returned in | ${never} | p | Cases |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.tool} | ${cell(row.result)} | ${row.returned}/${row.of} runs | 0/${row.never} runs | ${pValue(row.p)} | ${row.cases.join(', ')} |`,
    ),
  ]
}

/** The comparison as the report shows it: what moved first, then what cannot be told from chance. */
export function formatComparison(comparison: RunComparison, baselines: readonly string[]): string {
  const { overall, cases, alpha, toolResults: results } = comparison
  const by = (change: Change) => cases.filter((item) => item.change === change)
  const lines = [
    `Baseline: ${baselines.join(', ')}. A case is improved or regressed when a two-sided Fisher exact test on its own runs gives p < ${alpha}; with no correction for the number of cases, expect about one such verdict by chance in every ${Math.round(1 / alpha)} cases that did not change.`,
    '',
    `**Pass rate:** ${rate(overall.baseline)} → ${rate(overall.current)}, p=${pValue(overall.p)}, ${overall.change}`,
    `**Cases:** ${by('regressed').length} regressed, ${by('improved').length} improved, ${by('unclear').length} unclear, ${by('unchanged').length} unchanged`,
  ]
  if (by('regressed').length) lines.push('', '### Regressed', '', ...caseTable(by('regressed')))
  if (by('improved').length) lines.push('', '### Improved', '', ...caseTable(by('improved')))
  if (by('unclear').length) {
    lines.push(
      '',
      '### Unclear',
      '',
      'The rates differ, but these run counts cannot separate the difference from chance. Before acting on one, rerun that case and its baseline with a higher `--repeat`.',
      '',
      ...caseTable(by('unclear')),
    )
  }
  lines.push(
    '',
    '### Tool results that changed',
    '',
    results.appeared.length || results.vanished.length
      ? `What a tool returns is the code's doing, where a reply's wording is the model's. A result one side returned and the other never did, by more than chance (p < ${alpha}), is a change in behaviour whether or not a check failed.`
      : 'None: no tool result is on one side only by more than chance.',
  )
  if (results.appeared.length)
    lines.push('', '**New here:**', '', ...toolResultTable(results.appeared, 'Baseline'))
  if (results.vanished.length) {
    lines.push(
      '',
      "**No longer returned** (the baseline's count, then this run's):",
      '',
      ...toolResultTable(results.vanished, 'Here'),
    )
  }
  // A run of a few named cases leaves most of the baseline's cases out: count them, do not list them.
  const named = (names: readonly string[]) =>
    names.length > 5 ? `${names.length} cases` : names.join(', ')
  if (comparison.added.length) lines.push('', `**Not in the baseline:** ${named(comparison.added)}`)
  if (comparison.removed.length)
    lines.push('', `**Only in the baseline:** ${named(comparison.removed)}`)
  return lines.join('\n')
}
