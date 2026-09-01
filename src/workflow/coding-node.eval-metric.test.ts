/**
 * Workflow.coding-node-eval-metric-registered — Coding Node Scored By A Registered Eval Metric
 *
 * A metric registered through ./eval is the scorer. It receives ONLY the environment delta (diff +
 * command/test result) as input; the agent's self-report is structurally absent from its input.
 * Mutating the agent's summary does NOT change the score; mutating the diff/command result does.
 *
 * Evidence: the registered metric is the scorer; its input payload contains the diff + command
 * result but NOT the agent summary; the produced score equals the delta-derived value and diverges
 * from what the self-report would have scored.
 */
import { describe, it, expect, vi } from 'vitest'

import type { Metric, MetricResult } from '../eval/metrics/types'

import { createCodingAgentFactory, runCodingNode, type CodingAgentFactory } from '../agents/coding'
import { createWorkspaceProvisioner } from '../agents/coding/workspace-provisioner'
import { codingDeltaMetric, type CodingDelta } from '../eval/metrics/coding'

const provisioner = createWorkspaceProvisioner()

/** A coding factory whose run reports a summary + a controllable delta. */
function factoryWith(summary: string, diff: string, commandResult: string): CodingAgentFactory {
  return createCodingAgentFactory({
    build: () =>
      ({
        name: 'f',
        run: () =>
          Promise.resolve({
            status: 'completed',
            sessionId: 'f',
            output: { text: summary, value: { modifiedFiles: diff ? ['x.ts'] : [] }, items: [] },
          }),
      }) as never,
    delta: () => ({ diff, commandResult }),
  })
}

describe('workflow.coding-node-eval-metric-registered', () => {
  it('the registered ./eval metric receives diff + commandResult, NOT the agent summary', async () => {
    // A custom metric registered through ./eval (a { name, evaluate } over the delta).
    const evaluateSpy = vi.fn<(d: CodingDelta) => MetricResult>((d) => ({
      passed: d.diff !== '' && !d.commandResult.includes('FAIL'),
      score: d.diff !== '' ? 1 : 0,
    }))
    const custom: Metric<CodingDelta> = { name: 'custom-delta', evaluate: evaluateSpy }

    const SELF_REPORT = 'I have successfully completed the task!'
    const factory = factoryWith(SELF_REPORT, 'some files changed', 'tests: PASS')

    const { score } = await runCodingNode({
      factory,
      provisioner,
      base: '/repo',
      isolation: 'session',
      task: 'implement',
      metric: custom,
    })

    expect(evaluateSpy).toHaveBeenCalledOnce()
    const input = evaluateSpy.mock.calls[0][0]
    expect(input).toHaveProperty('diff', 'some files changed')
    expect(input).toHaveProperty('commandResult', 'tests: PASS')
    // The summary is structurally absent from the metric's input.
    expect(input).not.toHaveProperty('summary')
    expect(Object.keys(input).toSorted()).toEqual(['commandResult', 'diff'])
    expect(score.passed).toBe(true)
  })

  it('mutating the SUMMARY does not change the score; mutating the DELTA does', async () => {
    const metric = codingDeltaMetric()

    // Same FAILING delta, two very different summaries — the score must be identical (delta wins).
    const failingDelta = { diff: '', commandResult: 'tests: FAIL' }
    const a = await runCodingNode({
      factory: createCodingAgentFactory({
        build: () =>
          ({
            name: 'a',
            run: () =>
              Promise.resolve({
                status: 'completed',
                sessionId: 'a',
                output: { text: 'Everything is great!', value: { modifiedFiles: [] }, items: [] },
              }),
          }) as never,
        delta: () => failingDelta,
      }),
      provisioner,
      base: '/repo',
      isolation: 'session',
      task: 'implement',
      metric,
    })
    const b = await runCodingNode({
      factory: createCodingAgentFactory({
        build: () =>
          ({
            name: 'b',
            run: () =>
              Promise.resolve({
                status: 'completed',
                sessionId: 'b',
                output: {
                  text: 'Total failure, I gave up.',
                  value: { modifiedFiles: [] },
                  items: [],
                },
              }),
          }) as never,
        delta: () => failingDelta,
      }),
      provisioner,
      base: '/repo',
      isolation: 'session',
      task: 'implement',
      metric,
    })
    // Different summaries, same failing delta → same failing score.
    expect(a.score.passed).toBe(false)
    expect(b.score.passed).toBe(false)

    // Now flip the DELTA to passing (summary unchanged-ish) → score flips to passing.
    const c = await runCodingNode({
      factory: createCodingAgentFactory({
        build: () =>
          ({
            name: 'c',
            run: () =>
              Promise.resolve({
                status: 'completed',
                sessionId: 'c',
                output: {
                  text: 'Everything is great!',
                  value: { modifiedFiles: ['x.ts'] },
                  items: [],
                },
              }),
          }) as never,
        delta: () => ({ diff: 'modified x.ts', commandResult: 'tests: PASS' }),
      }),
      provisioner,
      base: '/repo',
      isolation: 'session',
      task: 'implement',
      metric,
    })
    expect(c.score.passed).toBe(true)
  })
})
