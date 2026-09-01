/**
 * Workflow.core-no-loader-symbols — Core Carries No Loader Vocabulary
 *
 * RunWorkflowFile, TierModelMap, NodeRunner are exported ONLY from the loader subpath, NOT from the
 * core. The core's three additions are imported by the loader, not re-declared.
 *
 * Evidence: import-graph/build
 */
import { describe, it, expect } from 'vitest'

describe('workflow.core-no-loader-symbols', () => {
  it('core does not export runWorkflowFile, TierModelMap, or NodeRunner', async () => {
    const core = await import('../index')
    expect((core as any).runWorkflowFile).toBeUndefined()
    expect((core as any).TierModelMap).toBeUndefined()
    expect((core as any).NodeRunner).toBeUndefined()
  })

  it('loader subpath exports runWorkflowFile and TierModelMap type', async () => {
    const workflow = await import('./index')
    expect(typeof workflow.runWorkflowFile).toBe('function')
    // TierModelMap is a type-only export; we can't test it at runtime but we can assert
    // the module loads without error
    expect(workflow).toBeDefined()
  })

  it('loader does not re-declare fanout, isAnnotationEvent — they come from core', async () => {
    const workflow = await import('./index')
    // These must NOT be re-exported from the loader — they live in the core
    expect((workflow as any).fanout).toBeUndefined()
    expect((workflow as any).isAnnotationEvent).toBeUndefined()
    expect((workflow as any).AnnotationEvent).toBeUndefined()
  })

  it('app.ask is on AdkApp, not a top-level export from loader', async () => {
    const workflow = await import('./index')
    // ask is a method on AdkApp, not a standalone top-level export from the loader
    expect((workflow as any).ask).toBeUndefined()
  })
})
