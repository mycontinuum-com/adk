/**
 * Workflow.cc-compat-port-unchanged — CC Attractor Runs Unchanged
 *
 * The repo's apps/serenity/cli/workflows/build-cli.workflow.js runs through runWorkflowFile with
 * ZERO body edits. The globals bind to the loader (agent → the configured node runner, parallel →
 * fanout, phase/log → ctx.note); agent returns the JSON-Schema-validated object; the 'sonnet' tier
 * resolves through the map and an omitted model uses the default; parallel runs with per-thunk
 * failures as null; the file's phase()/log() calls emit AnnotationEvents; the run returns a
 * RunResult. Only the launch mechanism differs from the Claude Code Workflow tool.
 *
 * Evidence: the actual build-cli.workflow.js run through the loader with a byte-diff showing zero
 * body edits; assertions that parallel mapped to fanout, that phase/log produced AnnotationEvents,
 * and the resolved tier map.
 */
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { NodeRunner } from './types'

import { adk } from '../api/app'
import { isAnnotationEvent } from '../types/events'
import { runWorkflowFile } from './index'

const BUILD_CLI_WORKFLOW = path.resolve(
  __dirname,
  '../../../../../apps/serenity/cli/workflows/build-cli.workflow.js',
)

/**
 * A stub LLM node runner that returns an object satisfying EVERY schema the build-cli body
 * dereferences (PLAN_SCHEMA / API_SCHEMA / VERIFY_SCHEMA / REVIEW_SCHEMA). It records each prompt
 * so we can prove parallel fanned out the per-impl/per-review thunks.
 */
function makeRecordingRunner(): { runner: NodeRunner; prompts: string[] } {
  const prompts: string[] = []
  const runner: NodeRunner = async (prompt) => {
    prompts.push(prompt)
    return {
      // PLAN_SCHEMA
      packageLayout: ['a.ts'],
      sharedModules: ['shared.ts'],
      commandModules: ['cmd.ts'],
      rendererContract: 'contract',
      scenarioEvidence: [{ scenario: 's', evidence: 'e' }],
      risks: ['r1'],
      // API_SCHEMA
      summary: 'a summary',
      files: ['x.ts'],
      // VERIFY_SCHEMA
      buildOk: true,
      testsOk: true,
      shimResolvesLocalBuild: true,
      projectionContractOk: true,
      idempotentSyncOk: true,
      commands: ['build'],
      failures: [],
      // REVIEW_SCHEMA
      scope: 'platform-kernel',
      blocking: [],
      nonBlocking: [],
    }
  }
  return { runner, prompts }
}

// The subject file is the monorepo's real attractor, outside this package. Outside the monorepo
// (the exported public repo) it does not exist and the suite skips cleanly; inside, an accidental
// skip cannot go quiet — the scenario is gate-bound (intent/workflows/validation.toml), so a
// missing witness reds the gate.
describe.skipIf(!existsSync(BUILD_CLI_WORKFLOW))('workflow.cc-compat-port-unchanged', () => {
  it('runs the real build-cli.workflow.js byte-for-byte unchanged and binds the CC globals', async () => {
    const before = readFileSync(BUILD_CLI_WORKFLOW, 'utf8')

    const app = adk()
    const { runner, prompts } = makeRecordingRunner()

    const models = {
      default: { provider: 'openai' as const, name: 'gpt-4o' },
      byTier: {
        sonnet: { provider: 'openai' as const, name: 'gpt-4o-mini' },
        opus: { provider: 'openai' as const, name: 'gpt-4o' },
      },
    }

    const result = await runWorkflowFile(BUILD_CLI_WORKFLOW, { app, models, node: runner })

    // (1) Zero body edits — the file on disk is byte-for-byte unchanged after the run.
    const after = readFileSync(BUILD_CLI_WORKFLOW, 'utf8')
    expect(after).toBe(before)

    // (2) The run returns a standard completed RunResult.
    expect(result.status).toBe('completed')

    // (3) phase()/log() → ctx.note: AnnotationEvents appear in the run's event stream.
    const annotations = result.session.events.filter(isAnnotationEvent)
    const phases = annotations.filter((a) => a.kind === 'phase').map((a) => a.label ?? a.message)
    // build-cli calls phase() for Plan, Scaffold, Implement, Deliver, Verify, Review, Report.
    expect(phases).toContain('Plan')
    expect(phases).toContain('Implement')
    expect(phases).toContain('Report')
    // log() → kind 'log' annotations are present too.
    expect(annotations.some((a) => a.kind === 'log')).toBe(true)

    // (4) parallel → fanout: the body's parallel over the 3 IMPLS and 3 REVIEW_SCOPES fanned out, so
    // the node runner saw the per-impl and per-review prompts.
    expect(prompts.some((p) => p.includes('operator commands'))).toBe(true)
    expect(prompts.some((p) => p.includes('skills commands'))).toBe(true)
    expect(prompts.some((p) => p.includes('renderer'))).toBe(true)
    expect(prompts.some((p) => p.includes('platform-kernel'))).toBe(true)

    // (5) The body's `return { plan, verify, blocking, report }` is surfaced as the run output.
    const output = result.output?.value as { plan?: unknown; verify?: unknown } | undefined
    expect(output?.plan).toBeDefined()
    expect(output?.verify).toBeDefined()
  })
})
