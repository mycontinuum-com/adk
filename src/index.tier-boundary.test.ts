/**
 * Index.tier-boundary — The Core Barrel Carries No Experimental Or Private Vocabulary
 *
 * Experimental surfaces ship only behind their subpaths (/agents/coding,
 * /agents/coding/claude-code, /workflow), and the gateway/process stores, artifacts services,
 * channels, and knowledge module are internal. None of their runtime exports may arrive through the
 * Core entry — an Experimental symbol reaching the Core door wears no stability badge, which is how
 * three whole surfaces shipped unbadged before this gate existed. Generalizes the workflow-only
 * assertion in workflow/core-no-loader-symbols.test.ts to every fenced module.
 *
 * Evidence: import-graph/build
 */
import { describe, expect, it } from 'vitest'

const FENCED_MODULES = [
  // Experimental: reachable only via their subpath exports.
  './agents/coding/index',
  './workflow/index',
  // Internal: no public surface at all.
  './knowledge/index',
  './gateway/index',
  './artifacts/index',
  './channels/index',
]

describe('index.tier-boundary', () => {
  it('the core barrel exports no runtime symbol of any fenced module', async () => {
    const core = (await import('./index')) as Record<string, unknown>
    const coreNames = new Set(Object.keys(core))
    for (const modulePath of FENCED_MODULES) {
      const fenced = (await import(modulePath)) as Record<string, unknown>
      for (const name of Object.keys(fenced)) {
        if (name === 'default') continue
        expect(
          coreNames.has(name),
          `${modulePath} runtime export "${name}" leaks from the core barrel`,
        ).toBe(false)
      }
    }
  })
})
