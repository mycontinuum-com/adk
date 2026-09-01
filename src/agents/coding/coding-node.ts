/**
 * Coding-node orchestrator.
 *
 * A coding node is ordinary code in an app.step body, but the provision → construct → run → dispose
 * lifecycle and the delta-scoring contract are easy to get wrong, so this module provides a single
 * `runCodingNode` that gets them right and is shared by the native step body and the CC-loader's
 * coding NodeRunner.
 *
 * Contract:
 *
 * 1. PREFLIGHT — provision the workspace FIRST. If provisioning fails or yields no path, the run is
 *    rejected as a validation failure BEFORE any CodingAgent is constructed or run.
 * 2. CONSTRUCT — build the CodingNode through `CodingAgentFactory.create({ workspace, signal })`,
 *    never a direct constructor.
 * 3. RUN — execute the coder against the provisioned workspace; the factory-passed `signal` cancels
 *    the in-flight coder.
 * 4. DISPOSE — tear down the workspace exactly once in a `finally`, including on throw/abort, so no
 *    workspace leaks.
 * 5. SCORE — score the ENVIRONMENT DELTA (diff + command/test result) via a `./eval` metric, never the
 *    agent's self-reported summary.
 *
 * @module
 */

import type { Metric, MetricResult } from '../../eval/metrics/types'
import type { CodingAgentFactory, CodingNodeOutcome } from './factory'
import type { CodingTask } from './types'

import { codingDeltaMetric, type CodingDelta } from '../../eval/metrics/coding'
import {
  WorkspaceProvisionError,
  type IsolationStrategy,
  type ProvisionedWorkspace,
  type WorkspaceProvisioner,
} from './workspace-provisioner'

/** Options for {@link runCodingNode}. */
export interface RunCodingNodeOptions {
  /** The factory that constructs a CodingNode over the provisioned workspace. */
  factory: CodingAgentFactory
  /** The provisioner that materializes the workspace. */
  provisioner: WorkspaceProvisioner
  /** Base path to provision under (repo root / parent dir). */
  base: string
  /** Isolation strategy. */
  isolation: IsolationStrategy | string
  /** The task for the coder. */
  task: string | CodingTask
  /** Abort signal; threaded into the coder. Aborting cancels the in-flight run. */
  signal?: AbortSignal
  /**
   * The eval metric that scores the environment delta. Defaults to {@link codingDeltaMetric}. It
   * receives ONLY `{ diff, commandResult }` — never the agent summary.
   */
  metric?: Metric<CodingDelta>
}

/** Result of a coding-node run: the normalized outcome plus the delta-derived score. */
export interface CodingNodeResult {
  /** The normalized outcome (delta + raw CodingResult). */
  outcome: CodingNodeOutcome
  /** The score, derived from the environment delta via the eval metric. */
  score: MetricResult
}

/**
 * Run a coding node end to end: provision → construct → run → dispose, then score the delta.
 *
 * Missing/unprovisionable workspace is a PREFLIGHT failure: it throws before `factory.create` is
 * called, so no coding agent (and no provider/harness) is touched. `dispose` runs exactly once even
 * when the coder throws or the run is aborted.
 *
 * @example
 *   ;```typescript
 *   const { outcome, score } = await runCodingNode({
 *     factory,
 *     provisioner,
 *     base: '/repo',
 *     isolation: 'worktree',
 *     task: 'Implement the failing requirement; run the unit tests.',
 *     signal: ctx.signal,
 *   })
 *   // score reflects outcome.delta (diff + command result), NOT outcome.summary
 *   ```
 */
export async function runCodingNode(options: RunCodingNodeOptions): Promise<CodingNodeResult> {
  const { factory, provisioner, base, isolation, task, signal } = options
  const metric = options.metric ?? codingDeltaMetric()

  // ── 1. PREFLIGHT: provision the workspace before any agent is constructed. ──────────────────
  // Provisioning errors (UnknownIsolationStrategyError / WorkspaceProvisionError) propagate
  // unchanged — they already name the offending strategy/base — and surface BEFORE factory.create,
  // so no coding agent (and no provider/harness) is touched on a preflight failure.
  const ws: ProvisionedWorkspace = await provisioner.provision(base, isolation)
  if (!ws || !ws.path || ws.path.trim() === '') {
    throw new WorkspaceProvisionError(
      `workspace could not be provisioned: no path for isolation '${isolation}'`,
      String(isolation),
    )
  }

  // ── 2-4. CONSTRUCT → RUN → DISPOSE (dispose exactly once, even on throw/abort). ──────────────
  let disposed = false
  const disposeOnce = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await ws.dispose()
  }

  let outcome: CodingNodeOutcome
  try {
    const node = factory.create({ workspace: ws.path, signal })
    outcome = await node.run(task)
  } finally {
    await disposeOnce()
  }

  // ── 5. SCORE the environment DELTA (diff + command result), never the summary. ───────────────
  const score = await metric.evaluate({
    diff: outcome.delta.diff,
    commandResult: outcome.delta.commandResult,
  })

  return { outcome, score }
}
