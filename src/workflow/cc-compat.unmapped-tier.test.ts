/**
 * Workflow.cc-compat-unmapped-tier — Unmapped Tier Fails Fast With No Substitution
 *
 * A CC file with agent({ model: 'haiku' }) and a loader whose map defines only opus+sonnet+default:
 * the run fails fast with a clear error NAMING the unmapped tier ('haiku') and the tiers that ARE
 * defined, before any agent executes; the loader does NOT fall back to the default and does NOT
 * substitute another provider. (An omitted model uses the default; a present-but-unmapped tier is
 * an error — the two are distinct.)
 *
 * Evidence: a descriptive unmapped-tier error naming the tier, that no agent run started, and
 * (contrast) a fixture omitting model resolves to the default without error.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NodeRunner } from './types'

import { adk } from '../api/app'
import { runWorkflowFile } from './index'

const MODELS = {
  default: { provider: 'openai' as const, name: 'gpt-4o' },
  byTier: {
    opus: { provider: 'openai' as const, name: 'gpt-4o' },
    sonnet: { provider: 'openai' as const, name: 'gpt-4o-mini' },
  },
}

const OK_RUNNER: NodeRunner = async () => 'ok'

describe('workflow.cc-compat-unmapped-tier', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-unmapped-tier-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('an unmapped tier (haiku) fails fast naming the tier AND the defined tiers; no agent run started', async () => {
    const app = adk()
    // The node runner must NEVER be called — the unmapped tier fails before dispatch.
    const nodeSpy = vi.fn<NodeRunner>(async () => 'should-not-run')

    const fixturePath = path.join(tmpDir, 'unmapped.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'unmapped', description: 'selects an undefined tier' }
const r = await agent('do something', { model: 'haiku' })
return { r }
`,
    )

    let errorMessage = ''
    await runWorkflowFile(fixturePath, { app, models: MODELS, node: nodeSpy }).catch((e: Error) => {
      errorMessage = e.message
    })

    // Names the unmapped tier and at least one of the defined tiers; no silent substitution.
    expect(errorMessage).toMatch(/haiku/)
    expect(errorMessage).toMatch(/opus|sonnet/)
    // No agent run was dispatched.
    expect(nodeSpy).not.toHaveBeenCalled()
  })

  it('a phases[].model unmapped tier also fails fast naming it (the phase-tier path)', async () => {
    const app = adk()
    const nodeSpy = vi.fn<NodeRunner>(async () => 'x')
    const fixturePath = path.join(tmpDir, 'phase-tier.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = {
  name: 'phase-tier',
  description: 'a phase declares an undefined tier',
  phases: [{ title: 'Plan', detail: 'plan', model: 'gemini-ultra' }]
}
const r = await agent('go')
return { r }
`,
    )

    await expect(
      runWorkflowFile(fixturePath, { app, models: MODELS, node: nodeSpy }),
    ).rejects.toThrow(/gemini-ultra/)
    expect(nodeSpy).not.toHaveBeenCalled()
  })

  it('contrast: an OMITTED model resolves to the default without error', async () => {
    const app = adk()
    const fixturePath = path.join(tmpDir, 'omitted.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'omitted', description: 'no model → default' }
const r = await agent('do something')
return { r }
`,
    )

    const result = await runWorkflowFile(fixturePath, { app, models: MODELS, node: OK_RUNNER })
    expect(result.status).toBe('completed')
    expect(result.output?.value).toEqual({ r: 'ok' })
  })
})
