/**
 * Workflow.cc-compat-globals-bound-before-body — Globals Bound Before Top-Level Body Runs
 *
 * Agent, parallel, phase, and log are already bound when the module's top-level body executes (the
 * shape of all three real attractors, which run `phase('Plan'); const plan = await agent(...)` at
 * module scope), so the top-level calls resolve to the loader bindings rather than throwing
 * ReferenceError; the body runs to completion and returns through app.run, and the top-level
 * phase() produced an AnnotationEvent.
 *
 * Evidence: a fixture invoking phase/agent at top level; no ReferenceError; phase event emitted.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NodeRunner } from './types'

import { adk } from '../api/app'
import { isAnnotationEvent } from '../types/events'
import { runWorkflowFile } from './index'

const MODELS = {
  default: { provider: 'openai' as const, name: 'gpt-4o' },
  byTier: { sonnet: { provider: 'openai' as const, name: 'gpt-4o-mini' } },
}

const OK: NodeRunner = async () => 'ok'

describe('workflow.cc-compat-globals-bound-before-body', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-globals-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('top-level phase() and agent() resolve to the loader bindings — no ReferenceError', async () => {
    const app = adk()
    const fixturePath = path.join(tmpDir, 'globals.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'globals-test', description: 'top-level orchestration' }
phase('LoadPhase')
const r = await agent('top-level agent call', { model: 'sonnet' })
return { r }
`,
    )

    // The body orchestrates at MODULE scope (not inside an exported function). If the globals were
    // bound after the body, this would throw `ReferenceError: agent is not defined`.
    const result = await runWorkflowFile(fixturePath, { app, models: MODELS, node: OK })

    expect(result.status).toBe('completed')

    // The top-level phase('LoadPhase') produced an AnnotationEvent.
    const phaseLabels = result.session.events
      .filter(isAnnotationEvent)
      .filter((a) => a.kind === 'phase')
      .map((a) => a.label ?? a.message)
    expect(phaseLabels).toContain('LoadPhase')

    // The top-level agent() resolved to the node runner and its value flowed into the body return.
    expect((result.output.value as { r?: unknown }).r).toBe('ok')
  })

  it('a ReferenceError would surface (no swallowing) if a global were genuinely missing', async () => {
    const app = adk()
    const fixturePath = path.join(tmpDir, 'undefined-global.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'undefined-global', description: 'references an unbound name' }
const r = await notAGlobal('x')
return { r }
`,
    )

    // notAGlobal is not a bound CC global; the loader does NOT mask this as success.
    await expect(runWorkflowFile(fixturePath, { app, models: MODELS, node: OK })).rejects.toThrow(
      /notAGlobal is not defined|ReferenceError/,
    )
  })
})
