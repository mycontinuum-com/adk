/**
 * Workflow.meta-pure-literal — Meta Pure Literal
 *
 * The literal meta is accepted and is readable for display/index WITHOUT executing the body; the
 * computed meta is rejected with a clear validation error.
 *
 * Evidence: acceptance of the literal and rejection of the computed form.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NodeRunner } from './types'

import { adk } from '../api/app'
import { parseWorkflowMeta, runWorkflowFile } from './index'

const MODELS = { default: { provider: 'openai' as const, name: 'gpt-4o' }, byTier: {} }
const OK: NodeRunner = async () => 'ok'

describe('workflow.meta-pure-literal', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-meta-literal-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('parseWorkflowMeta reads a pure-literal meta WITHOUT executing the body', () => {
    // The body contains a top-level statement that, if executed, would throw — proving the parser
    // does not run it.
    const source = `
export const meta = { name: 'literal', description: 'a pure literal' }
throw new Error('the body must NOT run during static meta read')
`
    const meta = parseWorkflowMeta(source)
    expect(meta.name).toBe('literal')
    expect(meta.description).toBe('a pure literal')
  })

  it('parseWorkflowMeta rejects a computed meta (identifier reference) with a clear error', () => {
    const source = `
const name = 'computed'
export const meta = { name, description: 'computed desc' }
`
    expect(() => parseWorkflowMeta(source)).toThrow(/meta|literal|computed/i)
  })

  it('runWorkflowFile accepts a literal meta and rejects a computed meta before running the body', async () => {
    const app = adk()

    const literalFixture = path.join(tmpDir, 'literal.fixture.js')
    await fs.writeFile(
      literalFixture,
      `
export const meta = { name: 'literal-run', description: 'literal' }
return { ok: true }
`,
    )
    const literalResult = await runWorkflowFile(literalFixture, { app, models: MODELS, node: OK })
    expect(literalResult.status).toBe('completed')
    expect(literalResult.output?.value).toEqual({ ok: true })

    const computedFixture = path.join(tmpDir, 'computed.fixture.js')
    await fs.writeFile(
      computedFixture,
      `
const dynamicName = 'computed'
export const meta = { name: dynamicName, description: 'computed' }
return { ok: true }
`,
    )
    await expect(
      runWorkflowFile(computedFixture, { app, models: MODELS, node: OK }),
    ).rejects.toThrow(/meta|literal|computed/i)
  })
})
