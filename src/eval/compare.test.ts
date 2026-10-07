import type { Event } from '../types/events'
import type { ComparedRun } from './compare'

import { compareRuns, fisherExact, formatComparison } from './compare'

let nextId = 0
const returned = (name: string, result: unknown): Event => ({
  id: `e${(nextId += 1)}`,
  type: 'tool_result',
  createdAt: nextId,
  invocationId: 'i',
  agentName: 'agent',
  callId: `c${nextId}`,
  name,
  result,
})

/** `total` runs of a case, the first `passed` of them passing, each returning `results` from `tool`. */
function runs(name: string, passed: number, total: number, results: unknown[] = []): ComparedRun[] {
  return Array.from({ length: total }, (_, index) => ({
    name,
    status: index < passed ? 'passed' : 'failed',
    events: results.map((result) => returned('tool', result)),
  }))
}

describe('fisherExact', () => {
  it('matches the published two-sided value of the tea-tasting table', () => {
    expect(fisherExact({ passed: 3, runs: 4 }, { passed: 1, runs: 4 })).toBeCloseTo(0.4857, 4)
  })

  it('separates five failures from five passes, and not four passes from five', () => {
    expect(fisherExact({ passed: 0, runs: 5 }, { passed: 5, runs: 5 })).toBeCloseTo(2 / 252, 6)
    expect(fisherExact({ passed: 4, runs: 5 }, { passed: 5, runs: 5 })).toBe(1)
  })

  it('gives 1 when either side has no runs or every run agrees', () => {
    expect(fisherExact({ passed: 0, runs: 0 }, { passed: 3, runs: 5 })).toBe(1)
    expect(fisherExact({ passed: 5, runs: 5 }, { passed: 9, runs: 9 })).toBe(1)
  })
})

describe('compareRuns', () => {
  const comparison = compareRuns(
    [
      ...runs('broken', 10, 10),
      ...runs('fixed', 0, 10),
      ...runs('flaky', 4, 5),
      ...runs('steady', 5, 5),
      ...runs('dropped', 5, 5),
    ],
    [
      ...runs('broken', 0, 5),
      ...runs('fixed', 5, 5),
      ...runs('flaky', 5, 5),
      ...runs('steady', 5, 5),
      ...runs('fresh', 1, 1),
    ],
  )

  it('calls a change only when the run counts support it', () => {
    expect(comparison.cases.map((item) => [item.name, item.change])).toEqual([
      ['broken', 'regressed'],
      ['fixed', 'improved'],
      ['flaky', 'unclear'],
      ['steady', 'unchanged'],
    ])
    expect(comparison.added).toEqual(['fresh'])
    expect(comparison.removed).toEqual(['dropped'])
  })

  it('compares the pass rate over the shared cases only', () => {
    expect(comparison.overall.baseline).toEqual({ passed: 19, runs: 30 })
    expect(comparison.overall.current).toEqual({ passed: 15, runs: 20 })
  })

  it('renders regressions first, says what an unclear change needs, and counts a long list', () => {
    const text = formatComparison(comparison, ['run-a'])
    expect(text).toContain('**Cases:** 1 regressed, 1 improved, 1 unclear, 1 unchanged')
    expect(text.indexOf('### Regressed')).toBeLessThan(text.indexOf('### Improved'))
    expect(text).toContain('| broken | 10/10 (100.0%) | 0/5 (0.0%) | <0.001 |')
    expect(text).toContain('higher `--repeat`')
    expect(text).toContain('None: no tool result is on one side only by more than chance.')
    expect(text).toContain('**Not in the baseline:** fresh')
    expect(text).toContain('**Only in the baseline:** dropped')
    const subset = compareRuns(
      Array.from({ length: 7 }, (_, at) => runs(`case-${at}`, 1, 1)).flat(),
      runs('case-0', 1, 1),
    )
    expect(formatComparison(subset, ['a'])).toContain('**Only in the baseline:** 6 cases')
  })
})

describe('tool results that changed', () => {
  it('lists a result that passing runs returned and no baseline run did, and the one it replaced', () => {
    const { toolResults } = compareRuns(
      [...runs('advice', 5, 5, ['the medicine line']), ...runs('other', 5, 5, ['a question'])],
      [...runs('advice', 5, 5, ['the seriousness line']), ...runs('other', 5, 5, ['a question'])],
    )
    expect(toolResults).toEqual({
      appeared: [
        {
          tool: 'tool',
          result: '"the seriousness line"',
          cases: ['advice'],
          returned: 5,
          of: 5,
          never: 5,
          p: expect.closeTo(2 / 252, 6),
        },
      ],
      vanished: [
        {
          tool: 'tool',
          result: '"the medicine line"',
          cases: ['advice'],
          returned: 5,
          of: 5,
          never: 5,
          p: expect.closeTo(2 / 252, 6),
        },
      ],
    })
  })

  it('counts a run once however often it returned the result, over every case that returned it', () => {
    const { toolResults } = compareRuns(
      [...runs('one', 5, 5), ...runs('two', 5, 5)],
      [...runs('one', 5, 5, ['new', 'new']), ...runs('two', 5, 5, ['new'])],
    )
    expect(toolResults.appeared).toMatchObject([
      { result: '"new"', cases: ['one', 'two'], returned: 10, of: 10, never: 10 },
    ])
  })

  it('leaves out a result too few runs returned, one both sides returned, and unshared cases', () => {
    const varying = (count: number) =>
      Array.from({ length: count }, (_, at) => runs('summary', 1, 1, [`wording ${at}`])).flat()
    expect(
      compareRuns(
        [
          ...varying(5),
          ...runs('advice', 3, 3, ['the medicine line']),
          ...runs('old', 5, 5, ['x']),
        ],
        [
          ...varying(5).toReversed(),
          ...runs('advice', 3, 3, ['another line']),
          ...runs('new', 5, 5, ['y']),
        ],
      ).toolResults,
    ).toEqual({ appeared: [], vanished: [] })
  })
})
