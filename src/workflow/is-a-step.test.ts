/**
 * Workflow.is-a-step — Workflow Is A Step
 *
 * App.run(app.step(...)) returns RunResult. No coined symbols exist on the surface.
 *
 * Evidence: unit + type-level + import-graph
 */
import { describe, it, expect } from 'vitest'

import type { Step } from '../types/runnables'
import type { RunResult } from '../types/runtime'

import { adk } from '../api/app'

describe('workflow.is-a-step', () => {
  it('app.run(app.step(...), input) returns RunResult', async () => {
    const app = adk()
    const wf: Step = app.step({
      name: 'workflow-as-step',
      execute: async (ctx) => {
        ctx.output({ done: true })
      },
    })

    const stream = app.run(wf, 'go')
    const result: RunResult = await stream

    expect(result.status).toBe('completed')
  })

  it('a workflow is kind "step", not a coined type', () => {
    const app = adk()
    const wf = app.step({ name: 'wf', execute: async () => {} })
    expect(wf.kind).toBe('step')
  })

  it('coined surface symbols are absent from app', async () => {
    const app = adk() as any
    // These must NOT exist
    expect(app.workflow).toBeUndefined()
    expect(app.runWorkflow).toBeUndefined()
    // WorkflowResult, WorkflowEvent, runWorkflow are not on app or as exports
    const coreModule = await import('../index')
    expect((coreModule as any).WorkflowResult).toBeUndefined()
    expect((coreModule as any).WorkflowEvent).toBeUndefined()
    expect((coreModule as any).runWorkflow).toBeUndefined()
    expect((coreModule as any).WorkflowContext).toBeUndefined()
    expect((coreModule as any).runWorkflowFile).toBeUndefined() // lives only in ./workflow
  })
})
