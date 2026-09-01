/**
 * Workflow.coding-node-missing-workspace — Coding Node Missing Workspace Fails Before Any Agent
 * Runs
 *
 * When workspace provisioning fails or yields no path, the run is rejected as a validation failure
 * that NAMES the missing/unprovisionable workspace and stops BEFORE any coding agent is constructed
 * or executed: CodingAgentFactory.create and coder.run are never called, and no provider/harness
 * call is made. The native and loader entry points fail identically.
 *
 * Evidence: vitest asserting a descriptive missing-workspace error for both entry points and that
 * create/run spies recorded zero calls.
 */
import { describe, it, expect, vi } from 'vitest'

import { createCodingAgentFactory, runCodingNode, type CodingAgentFactory } from '../agents/coding'
import {
  createWorkspaceProvisioner,
  UnknownIsolationStrategyError,
  WorkspaceProvisionError,
  type WorkspaceProvisioner,
} from '../agents/coding/workspace-provisioner'

/** A factory whose create/run are spied so we can assert they are NEVER reached. */
function spyFactory(): {
  factory: CodingAgentFactory
  createSpy: ReturnType<typeof vi.fn>
  runSpy: ReturnType<typeof vi.fn>
} {
  const runSpy = vi.fn<(...args: unknown[]) => unknown>(() =>
    Promise.resolve({ status: 'completed', sessionId: 'x', output: { items: [] } }),
  )
  const createSpy = vi.fn<(...args: unknown[]) => unknown>()
  const factory = createCodingAgentFactory({
    build: () => ({ name: 'spy', run: runSpy }) as never,
  })
  const wrapped: CodingAgentFactory = {
    create: (o) => {
      createSpy(o)
      return factory.create(o)
    },
  }
  return { factory: wrapped, createSpy, runSpy }
}

describe('workflow.coding-node-missing-workspace', () => {
  it('native: a failing provision rejects before create/run, naming the workspace', async () => {
    const { factory, createSpy, runSpy } = spyFactory()

    // Provisioner that always fails (base path missing / cannot provision).
    const failing: WorkspaceProvisioner = {
      provision: async (_base, isolation) => {
        throw new WorkspaceProvisionError(
          `workspace could not be provisioned: base path missing (isolation '${isolation}')`,
          isolation,
        )
      },
    }

    await expect(
      runCodingNode({
        factory,
        provisioner: failing,
        base: '/does/not/exist',
        isolation: 'worktree',
        task: 'implement',
      }),
    ).rejects.toThrow(/workspace could not be provisioned/)

    expect(createSpy).not.toHaveBeenCalled()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('native: an empty base path fails preflight via the default provisioner, no agent constructed', async () => {
    const { factory, createSpy, runSpy } = spyFactory()
    const provisioner = createWorkspaceProvisioner()

    await expect(
      runCodingNode({
        factory,
        provisioner,
        base: '', // missing base
        isolation: 'session',
        task: 'implement',
      }),
    ).rejects.toThrow(/workspace could not be provisioned/)

    expect(createSpy).not.toHaveBeenCalled()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('native: an unknown isolation strategy is rejected before provisioning and before any agent', async () => {
    const { factory, createSpy, runSpy } = spyFactory()
    const provisioner = createWorkspaceProvisioner()

    await expect(
      runCodingNode({
        factory,
        provisioner,
        base: '/repo',
        isolation: 'container', // not a known strategy
        task: 'implement',
      }),
    ).rejects.toThrow(UnknownIsolationStrategyError)

    expect(createSpy).not.toHaveBeenCalled()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('loader: an unprovisionable workspace fails before any agent, identically to native', async () => {
    // The loader runs a coding CC fixture whose node runner provisions a workspace via runCodingNode.
    // With provisioning arranged to fail, the rejection NAMES the workspace and stops BEFORE any agent
    // is constructed/run — the SAME missing-workspace behavior as the native cases above.
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const pathMod = await import('node:path')
    const { runWorkflowFile } = await import('./index')
    const { adk } = await import('../api/app')

    const app = adk()
    const { factory, createSpy, runSpy } = spyFactory()

    const failing: WorkspaceProvisioner = {
      provision: async (_base, isolation) => {
        throw new WorkspaceProvisionError(
          `workspace could not be provisioned (loader): base path missing (isolation '${isolation}')`,
          isolation,
        )
      },
    }

    const codingRunner = async (prompt: string) => {
      const { outcome } = await runCodingNode({
        factory,
        provisioner: failing,
        base: '/does/not/exist',
        isolation: 'session',
        task: prompt,
      })
      return outcome
    }

    const tmpDir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'adk-loader-missing-ws-'))
    const fixturePath = pathMod.join(tmpDir, 'coding.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'coding-missing-ws', description: 'build attractor with no workspace' }
const r = await agent('create a file and run tests')
return { r }
`,
    )

    await expect(
      runWorkflowFile(fixturePath, {
        app,
        models: { default: { provider: 'openai' as const, name: 'gpt-4o' }, byTier: {} },
        node: codingRunner,
      }),
    ).rejects.toThrow(/workspace could not be provisioned/)

    // No coding agent was constructed or run (fail-before-construct), identical to native.
    expect(createSpy).not.toHaveBeenCalled()
    expect(runSpy).not.toHaveBeenCalled()

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})
