/**
 * Workflow.cc-compat-feature-boundary — CC Compat Feature Boundary
 *
 * Each of the eight deferred CC features raises a clear `unsupported CC feature` error that NAMES
 * the specific triggering feature, before producing wrong behavior and without silently ignoring
 * it. The control fixture (only agent / parallel / phase / log + meta + JSON-Schema + opus/sonnet
 * tiers) runs to a RunResult. `budget` in particular is REJECTED, not approximated.
 *
 * Evidence: a parametrized vitest test over all eight deferred-feature fixtures + the clean
 * control.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NodeRunner } from './types'

import { adk } from '../api/app'
import { runWorkflowFile } from './index'

const MODELS = {
  default: { provider: 'openai' as const, name: 'gpt-4o' },
  byTier: { sonnet: { provider: 'openai' as const, name: 'gpt-4o-mini' } },
}

// A node runner that always succeeds — so the ONLY thing that can fail the deferred-feature fixtures
// is the deferred feature itself (not an unsatisfied schema or a missing model).
const ALWAYS_OK: NodeRunner = async () => ({ plan: 'ok' })

// The token the error MUST name for each deferred-feature fixture.
const DEFERRED_FEATURES: Array<{ token: string; fixture: string }> = [
  {
    token: 'pipeline',
    fixture: `
export const meta = { name: 'pipeline-test', description: 'test' }
const r = await pipeline(['a', 'b'])
`,
  },
  {
    token: 'args',
    fixture: `
export const meta = { name: 'args-test', description: 'test' }
const x = args.someArg
`,
  },
  {
    token: 'budget',
    fixture: `
export const meta = { name: 'budget-test', description: 'test' }
const remaining = budget.remaining
`,
  },
  {
    token: 'workflow',
    fixture: `
export const meta = { name: 'nested-workflow-test', description: 'test' }
const r = await workflow('./other.workflow.js')
`,
  },
  {
    token: 'isolation',
    fixture: `
export const meta = { name: 'isolation-test', description: 'test' }
const r = await agent('do something', { isolation: 'worktree' })
`,
  },
  {
    token: 'agentType',
    fixture: `
export const meta = { name: 'agentType-test', description: 'test' }
const r = await agent('do something', { agentType: 'coding' })
`,
  },
  {
    token: 'retries',
    fixture: `
export const meta = { name: 'retries-test', description: 'test' }
const r = await agent('do something', { retries: 3 })
`,
  },
  {
    token: 'timeoutMs',
    fixture: `
export const meta = { name: 'timeoutMs-test', description: 'test' }
const r = await agent('do something', { timeoutMs: 30000 })
`,
  },
]

const CONTROL_FIXTURE = `
export const meta = { name: 'control', description: 'only required subset' }
phase('Plan')
const r = await agent('plan this', { model: 'sonnet', schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } })
log('done')
return { r }
`

describe('workflow.cc-compat-feature-boundary', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-feature-boundary-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  for (const { token, fixture } of DEFERRED_FEATURES) {
    it(`deferred feature '${token}' raises an unsupported-feature error NAMING the feature`, async () => {
      const app = adk()
      const fixturePath = path.join(tmpDir, `deferred-${token}.fixture.js`)
      await fs.writeFile(fixturePath, fixture)

      let errorMessage = ''
      await runWorkflowFile(fixturePath, { app, models: MODELS, node: ALWAYS_OK }).catch(
        (e: Error) => {
          errorMessage = e.message
        },
      )

      // The error must name the SPECIFIC triggering feature and say it is unsupported/deferred —
      // not a generic failure, and not silently ignored.
      expect(errorMessage).toMatch(new RegExp(token, 'i'))
      expect(errorMessage).toMatch(/unsupported CC feature/i)
    })
  }

  it('budget is REJECTED (named), not approximated', async () => {
    const app = adk()
    const fixturePath = path.join(tmpDir, 'budget-reject.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'budget-reject', description: 'test' }
if (budget.remaining > 0) { log('has budget') }
`,
    )

    await expect(
      runWorkflowFile(fixturePath, { app, models: MODELS, node: ALWAYS_OK }),
    ).rejects.toThrow(/budget/i)
  })

  it('the required-subset control fixture runs to a completed RunResult', async () => {
    const app = adk()
    const fixturePath = path.join(tmpDir, 'control.fixture.js')
    await fs.writeFile(fixturePath, CONTROL_FIXTURE)

    const result = await runWorkflowFile(fixturePath, { app, models: MODELS, node: ALWAYS_OK })
    expect(result.status).toBe('completed')
  })
})
