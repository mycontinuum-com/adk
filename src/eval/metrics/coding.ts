/**
 * Coding-node delta metric (registered through ./eval).
 *
 * Scores a coding-node run on its ENVIRONMENT DELTA — the workspace diff plus the command/test
 * result — and NEVER on the coding agent's self-reported summary. This is the inference-eval
 * coupling for coding nodes: a passing self-report over a failing delta still scores as failing.
 *
 * The metric's `evaluate` receives ONLY `{ diff, commandResult }`. A summary is structurally absent
 * from its input, so it cannot accidentally be scored. Custom metrics register the same way (a `{
 * name, evaluate }` over the delta), proving eval-metric extensibility for any non-default scorer.
 *
 * @module
 */

import type { Metric, MetricResult } from './types'

/** The environment delta a coding-node metric scores. No summary field — by construction. */
export interface CodingDelta {
  /** Workspace diff after the run. Empty string when nothing changed. */
  diff: string
  /** Verification command/test output. */
  commandResult: string
}

/** A metric over a {@link CodingDelta}. The run shape is the delta itself, not a session. */
export type CodingDeltaMetric = Metric<CodingDelta>

/** Configuration for {@link codingDeltaMetric}. */
export interface CodingDeltaMetricConfig {
  /** Metric name (defaults to `coding-delta`). */
  name?: string
  /**
   * Predicate over the delta deciding pass/fail. Defaults to: a non-empty diff AND a command result
   * that does not contain `FAIL` (case-sensitive token, matching common test reporters).
   */
  passed?: (delta: CodingDelta) => boolean
  /** Optional numeric score derived from the delta. */
  score?: (delta: CodingDelta) => number
}

/** Default pass predicate: files changed AND the command result reports no failure. */
function defaultPassed(delta: CodingDelta): boolean {
  return delta.diff.trim() !== '' && !/\bFAIL/i.test(delta.commandResult)
}

/**
 * Create a coding-node delta metric registered through ./eval.
 *
 * The returned metric's `evaluate(delta)` reads ONLY `delta.diff` and `delta.commandResult`. It is
 * structurally impossible for the metric to read an agent summary, because the summary is not part
 * of the input type — the coding-node orchestrator hands the metric the delta, not the outcome.
 *
 * @example
 *   ;```typescript
 *   import { codingDeltaMetric } from '@animahealth/adk/eval'
 *
 *   const metric = codingDeltaMetric()
 *   const result = await metric.evaluate({ diff: '...', commandResult: 'tests: PASS' })
 *   ```
 */
export function codingDeltaMetric(config: CodingDeltaMetricConfig = {}): CodingDeltaMetric {
  const name = config.name ?? 'coding-delta'
  const passedFn = config.passed ?? defaultPassed
  const scoreFn = config.score

  return {
    name,
    evaluate: (delta: CodingDelta): MetricResult => {
      const passed = passedFn(delta)
      const result: MetricResult = {
        passed,
        evidence: [
          `diff: ${delta.diff.trim() === '' ? '(empty)' : `${delta.diff.length} chars`}`,
          `commandResult: ${delta.commandResult}`,
        ],
      }
      if (scoreFn) result.score = scoreFn(delta)
      return result
    },
  }
}
