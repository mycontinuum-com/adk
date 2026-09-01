/**
 * Workflow.cc-compat-parallel-agent-unwrap-and-null — Loader Agent In Parallel Unwraps Value And
 * Maps Failure To Null
 *
 * The loader-bound agent() inside each parallel thunk resolves to the UNWRAPPED schema-validated
 * object on success (so r.files is directly readable, NOT a RunResult requiring
 * r.output.value.files) and to null on failure (so .filter(Boolean) drops exactly the failed node
 * without throwing the thunk); the surviving .map((r) => r.files) runs and yields the success
 * values. The parallel→fanout binding maps the per-thunk node failure to null rather than rejecting
 * the batch.
 *
 * Evidence: the parallel(...).filter(Boolean).map((r) => r.files) idiom against a one-failure
 * arrangement; result length == success count; each surviving element exposes r.files directly; the
 * failed node produced a null that .filter(Boolean) removed.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NodeRunner } from './types'

import { adk } from '../api/app'
import { runWorkflowFile } from './index'

// A node runner arranging ONE failure (the 'skills' impl) and the rest success. A loader-bound
// agent() resolves to null on failure, so the runner returns null for the failing node.
const ONE_FAILURE_RUNNER: NodeRunner = async (prompt) => {
  if (prompt.includes('skills')) return null // the failing node
  const key = prompt.replace('impl ', '')
  return { files: [`${key}.ts`] }
}

// The exact build-cli idiom: parallel(IMPLS.map(() => () => agent(...))).filter(Boolean).map(r => r.files)
const PARALLEL_IDIOM_FIXTURE = `
export const meta = { name: 'parallel-unwrap', description: 'the real attractor parallel idiom' }
const IMPLS = ['operator', 'skills', 'renderer']
const impls = await parallel(IMPLS.map((key) => () => agent(\`impl \${key}\`, {
  label: \`impl:\${key}\`,
  schema: { type: 'object', additionalProperties: false, properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
})))
const survivingFiles = impls.filter(Boolean).map((r) => r.files)
return { survivingFiles, rawLength: impls.length, nullCount: impls.filter((x) => x === null).length }
`

describe('workflow.cc-compat-parallel-agent-unwrap-and-null', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-parallel-unwrap-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('agent() in parallel unwraps the value (r.files readable) and the one failure becomes null that filter(Boolean) drops', async () => {
    const app = adk()

    const fixturePath = path.join(tmpDir, 'parallel.fixture.js')
    await fs.writeFile(fixturePath, PARALLEL_IDIOM_FIXTURE)

    const result = await runWorkflowFile(fixturePath, {
      app,
      models: { default: { provider: 'openai' as const, name: 'gpt-4o' }, byTier: {} },
      node: ONE_FAILURE_RUNNER,
    })

    expect(result.status).toBe('completed')
    const out = result.output?.value as {
      survivingFiles: string[][]
      rawLength: number
      nullCount: number
    }

    // The raw parallel result has length 3 with exactly one null at the failing node's slot.
    expect(out.rawLength).toBe(3)
    expect(out.nullCount).toBe(1)

    // .filter(Boolean) dropped exactly the failed node → 2 survivors, each exposing r.files DIRECTLY
    // (proving the value was unwrapped, not a RunResult requiring r.output.value.files).
    expect(out.survivingFiles).toHaveLength(2)
    expect(out.survivingFiles).toContainEqual(['operator.ts'])
    expect(out.survivingFiles).toContainEqual(['renderer.ts'])
  })
})
