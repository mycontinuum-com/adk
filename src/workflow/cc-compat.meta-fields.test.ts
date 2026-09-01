/**
 * Workflow.cc-compat-meta-fields-surfaced — Required Meta Fields Parsed And Surfaced
 *
 * All required fields are parsed and surfaced for display/index — name, description, optional
 * whenToUse, and the phases array with each { title, detail, model? } intact — WITHOUT executing
 * the body. Parsed against the REAL build-agents.workflow.js meta (which carries whenToUse and a
 * phases[].model tier).
 *
 * Evidence: the parsed meta exposes whenToUse and phases[].model (not just name/description) read
 * statically from the real build-agents.workflow.js meta.
 */
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseWorkflowMeta } from './index'

const BUILD_AGENTS_WORKFLOW = path.resolve(
  __dirname,
  '../../../../../apps/serenity/agents/workflows/build-agents.workflow.js',
)

describe('workflow.cc-compat-meta-fields-surfaced', () => {
  // The subject file is the monorepo's real attractor, outside this package. Outside the monorepo
  // (the exported public repo) it does not exist and this case skips cleanly; inside, an accidental
  // skip cannot go quiet — the scenario is gate-bound (intent/workflows/validation.toml), so a
  // missing witness reds the gate.
  it.skipIf(!existsSync(BUILD_AGENTS_WORKFLOW))(
    'statically surfaces name/description/whenToUse and phases[].{title,detail,model} from the real attractor',
    () => {
      const source = readFileSync(BUILD_AGENTS_WORKFLOW, 'utf8')
      const meta = parseWorkflowMeta(source)

      expect(meta.name).toBe('serenity-agents-mvp-build')
      expect(meta.description).toMatch(/Clean-rebuild/)

      // whenToUse is surfaced (not dropped).
      expect(meta.whenToUse).toBeDefined()
      expect(meta.whenToUse).toMatch(/Serenity Agents MVP/)

      // phases are surfaced with title/detail intact.
      expect(meta.phases).toBeDefined()
      const phases = meta.phases!
      expect(phases.length).toBeGreaterThanOrEqual(7)
      expect(phases[0].title).toBe('Plan & DoD')
      expect(phases[0].detail).toMatch(/coverage ledger/)

      // phases[].model tiers are surfaced (the 'opus' tier on Plan & DoD and Completion).
      const planPhase = phases.find((p) => p.title === 'Plan & DoD')
      expect(planPhase?.model).toBe('opus')
      const completionPhase = phases.find((p) => p.title === 'Completion')
      expect(completionPhase?.model).toBe('opus')

      // A phase without a model omits it (rather than fabricating one).
      const foundationPhase = phases.find((p) => p.title === 'Foundation')
      expect(foundationPhase).toBeDefined()
      expect(foundationPhase?.model).toBeUndefined()
    },
  )

  it('an unknown extra meta key does not corrupt the parse (literal-meta contract)', () => {
    const source = `
export const meta = {
  name: 'extra-key',
  description: 'has an unknown field',
  whenToUse: 'whenever',
  phases: [{ title: 'Plan', detail: 'plan', model: 'sonnet' }],
  customField: { nested: true }
}
return { ok: true }
`
    const meta = parseWorkflowMeta(source)
    expect(meta.name).toBe('extra-key')
    expect(meta.whenToUse).toBe('whenever')
    expect(meta.phases?.[0].model).toBe('sonnet')
  })
})
