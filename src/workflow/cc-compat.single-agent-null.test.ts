/**
 * Workflow.cc-compat-single-agent-null-on-failure — Bare agent Call Returns null On Failure
 *
 * The single, non-parallel agent() call resolves to null on failure (it does NOT throw out of the
 * body), so the CC guard/filter(Boolean) idiom downstream still works; a subsequent parallel is not
 * required for the null contract to hold. (Distinct from the per-thunk-null behavior of
 * parallel/fanout.)
 *
 * Evidence: a bare `await agent(...)` whose node fails returns null (not a thrown error) and body
 * code guarding the result runs normally.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NodeRunner } from './types'

import { adk } from '../api/app'
import { runWorkflowFile } from './index'

const MODELS = { default: { provider: 'openai' as const, name: 'gpt-4o' }, byTier: {} }

// The node fails (exhausts retries) → the loader-bound agent() returns null.
const FAILING_RUNNER: NodeRunner = async () => null
// A node that succeeds with a schema-shaped object.
const OK_RUNNER: NodeRunner = async () => ({ failures: ['boom'] })

describe('workflow.cc-compat-single-agent-null-on-failure', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-single-null-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('a bare sequential agent() that fails resolves to null; the downstream guard runs (no throw)', async () => {
    const app = adk()

    const fixturePath = path.join(tmpDir, 'single-null.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'single-null', description: 'guards a bare agent() result' }
const verify = await agent('verify', {
  schema: { type: 'object', additionalProperties: false, properties: { failures: { type: 'array', items: { type: 'string' } } }, required: ['failures'] }
})
// The exact build-cli idiom: if (verify.failures.length > 0) ... — guarded on null first.
if (!verify) {
  return { aborted: true }
}
return { failures: verify.failures }
`,
    )

    const result = await runWorkflowFile(fixturePath, { app, models: MODELS, node: FAILING_RUNNER })

    // The body completed (the null did NOT throw out of the body) and the guard branch ran.
    expect(result.status).toBe('completed')
    expect(result.output?.value).toEqual({ aborted: true })
  })

  it('a bare agent() that succeeds resolves to the unwrapped object (the guard falls through)', async () => {
    const app = adk()

    const fixturePath = path.join(tmpDir, 'single-ok.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'single-ok', description: 'dereferences a successful bare agent()' }
const verify = await agent('verify', {
  schema: { type: 'object', additionalProperties: false, properties: { failures: { type: 'array', items: { type: 'string' } } }, required: ['failures'] }
})
if (!verify) { return { aborted: true } }
return { failureCount: verify.failures.length }
`,
    )

    const result = await runWorkflowFile(fixturePath, { app, models: MODELS, node: OK_RUNNER })

    expect(result.status).toBe('completed')
    // verify.failures was directly readable (unwrapped) — the guard fell through.
    expect(result.output?.value).toEqual({ failureCount: 1 })
  })
})
