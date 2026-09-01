/**
 * Workflow.cc-compat-agent-options-and-phase — Agent label/phase Options Accepted And phase Option
 * Annotates Without Re-Emitting
 *
 * The loader ACCEPTS label and phase as part of the required agent option subset (NOT the
 * unsupported-feature error that isolation/agentType/retries/timeoutMs raise). The single
 * phase('Implement') global emits exactly ONE phase AnnotationEvent; the phase OPTION on each
 * agent() call annotates that node's own events/metadata with the phase grouping (and label with
 * the node id) WITHOUT emitting an additional phase marker per agent call. The count of
 * kind:'phase' AnnotationEvents equals the number of phase() global calls; label and phase are
 * carried as distinct fields.
 *
 * Evidence: an agent() carrying label and phase runs without error (contrasted with
 * isolation/retries raising the unsupported-feature error), the number of kind:'phase' events
 * equals the number of phase() globals, and each node's label/phase values surface distinctly.
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

const OK: NodeRunner = async () => ({ files: ['a.ts'] })

describe('workflow.cc-compat-agent-options-and-phase', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-agent-options-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('accepts label/phase; one phase() global = one phase event; per-agent phase does not re-emit a marker', async () => {
    const app = adk()
    // The exact shape of build-cli lines 127-146: one phase('Implement') global, then parallel over
    // agent(prompt, { label, phase: 'Implement', model, schema }).
    const fixturePath = path.join(tmpDir, 'agent-options.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'agent-options', description: 'label + phase options' }
phase('Implement')
const impls = await parallel([1, 2, 3].map((i) => () => agent(\`impl \${i}\`, {
  label: \`impl:\${i}\`,
  phase: 'Implement',
  model: 'sonnet',
  schema: { type: 'object', additionalProperties: false, properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
})))
return { count: impls.filter(Boolean).length }
`,
    )

    const result = await runWorkflowFile(fixturePath, { app, models: MODELS, node: OK })
    expect(result.status).toBe('completed')

    const annotations = result.session.events.filter(isAnnotationEvent)

    // Exactly ONE kind:'phase' event — from the single phase('Implement') global, NOT inflated by the
    // three per-agent { phase: 'Implement' } options.
    const phaseEvents = annotations.filter((a) => a.kind === 'phase')
    expect(phaseEvents).toHaveLength(1)
    expect(phaseEvents[0].label ?? phaseEvents[0].message).toBe('Implement')

    // The per-agent phase option annotated each node distinctly: label = node id, phase grouping
    // carried separately (here on data.phase). Three agent() calls → three node-level annotations.
    const nodeAnnotations = annotations.filter(
      (a) => a.kind !== 'phase' && a.label && a.label.startsWith('impl:'),
    )
    expect(nodeAnnotations).toHaveLength(3)
    for (const a of nodeAnnotations) {
      // label (node id) and phase grouping are DISTINCT fields, neither dropped nor conflated.
      expect(a.label).toMatch(/^impl:\d$/)
      expect((a.data as { phase?: string }).phase).toBe('Implement')
      expect(a.kind).not.toBe('phase') // a node annotation, not a second phase marker
    }
  })

  it('isolation/retries on the SAME call DO raise the unsupported-feature error (contrast)', async () => {
    const app = adk()
    const isolationFixture = path.join(tmpDir, 'isolation.fixture.js')
    await fs.writeFile(
      isolationFixture,
      `
export const meta = { name: 'iso', description: 'deferred option on agent' }
const r = await agent('x', { label: 'n', phase: 'P', isolation: 'worktree' })
return { r }
`,
    )
    await expect(
      runWorkflowFile(isolationFixture, { app, models: MODELS, node: OK }),
    ).rejects.toThrow(/isolation/i)

    const retriesFixture = path.join(tmpDir, 'retries.fixture.js')
    await fs.writeFile(
      retriesFixture,
      `
export const meta = { name: 'ret', description: 'deferred option on agent' }
const r = await agent('x', { label: 'n', phase: 'P', retries: 3 })
return { r }
`,
    )
    await expect(
      runWorkflowFile(retriesFixture, { app, models: MODELS, node: OK }),
    ).rejects.toThrow(/retries/i)
  })
})
