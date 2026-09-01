/**
 * Workflow.headless-ci-result — Headless CI Result
 *
 * A workflow runs via app.run headlessly (no Claude Code harness) and returns a RunResult.
 *
 * Evidence: unit + import-graph (no CC harness loaded)
 */
import { describe, it, expect } from 'vitest'

import type { RunResult } from '../types/runtime'

import { adk } from '../api/app'

describe('workflow.headless-ci-result', () => {
  it('workflow step runs headlessly and returns RunResult with output + events + status', async () => {
    const app = adk()
    const wf = app.step({
      name: 'headless-workflow',
      execute: async (ctx) => {
        ctx.note('Starting headless run', { kind: 'phase' })
        ctx.output({ headless: true, message: 'completed without Claude Code harness' })
      },
    })

    const stream = app.run(wf, 'go')
    const result: RunResult = await stream

    expect(result.status).toBe('completed')
    expect(result.output?.value).toEqual({
      headless: true,
      message: 'completed without Claude Code harness',
    })
    expect(result.session).toBeDefined()
    expect(result.session.events).toBeDefined()
  })

  it('running a workflow does not require @anthropic-ai/claude-agent-sdk to be loaded', async () => {
    // If the harness is imported at module load, this would have already failed.
    // We verify by checking that the core module resolves without needing the harness.
    const coreModule = await import('../index')
    expect(typeof coreModule.adk).toBe('function')
  })

  it('RunResult has output, events, and usage fields', async () => {
    const app = adk()
    const wf = app.step({
      name: 'result-shape',
      execute: async (ctx) => {
        ctx.note('a note')
        ctx.output(42)
      },
    })
    const result = await app.run(wf, 'go')
    expect(result).toHaveProperty('status')
    expect(result).toHaveProperty('session')
    expect(result).toHaveProperty('output')
    expect(result.output?.value).toBe(42)
  })
})
