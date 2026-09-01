/**
 * Workflow.coding-node-isolation-strategies — Coding Node Isolation Strategies Provision And
 * Dispose
 *
 * WorkspaceProvisioner.provision(base, isolation) for session | worktree | sandbox each returns a
 * distinct { path, dispose } matching its kind; the coder runs against that path; dispose is
 * invoked exactly once after the run — including when the coder throws or the run is aborted, so no
 * workspace leaks. An unknown isolation string is rejected with a clear error BEFORE provisioning.
 *
 * Evidence: per-strategy assertions on provision arg, coder working dir, dispose-once on success +
 * throw; plus an unknown-strategy rejection.
 */
import { describe, it, expect, vi } from 'vitest'

import { createCodingAgentFactory, runCodingNode, type CodingAgentFactory } from '../agents/coding'
import {
  createWorkspaceProvisioner,
  ISOLATION_STRATEGIES,
  UnknownIsolationStrategyError,
  type IsolationStrategy,
  type ProvisionedWorkspace,
} from '../agents/coding/workspace-provisioner'

/** Per-strategy kind-tagged path so we can assert the path matches the requested kind. */
function kindPath(strategy: IsolationStrategy): string {
  return `/provisioned/${strategy}/ws`
}

/**
 * A provisioner with real per-strategy backends and a dispose spy per provision. Validation of the
 * isolation string is the default provisioner's job (it runs before the backend).
 */
function strategyProvisioner() {
  const disposeSpies = new Map<IsolationStrategy, ReturnType<typeof vi.fn>>()
  const provisionArgs: Array<{ base: string; isolation: string }> = []
  const backend =
    (strategy: IsolationStrategy) =>
    (base: string): ProvisionedWorkspace => {
      provisionArgs.push({ base, isolation: strategy })
      const dispose = vi.fn<() => void>()
      disposeSpies.set(strategy, dispose)
      return { path: kindPath(strategy), isolation: strategy, dispose }
    }
  const provisioner = createWorkspaceProvisioner({
    session: backend('session'),
    worktree: backend('worktree'),
    sandbox: backend('sandbox'),
  })
  return { provisioner, disposeSpies, provisionArgs }
}

/** A factory whose run records the workspace it was constructed over. */
function recordingFactory(opts: {
  seenWorkspace: (ws: string) => void
  throwOnRun?: boolean
}): CodingAgentFactory {
  return createCodingAgentFactory({
    build: ({ workspace }) =>
      ({
        name: 'rec',
        run: () => {
          opts.seenWorkspace(workspace)
          if (opts.throwOnRun) return Promise.reject(new Error('coder exploded'))
          return Promise.resolve({
            status: 'completed',
            sessionId: 'rec',
            output: { value: { modifiedFiles: ['f'] }, items: [] },
          })
        },
      }) as never,
    delta: () => ({ diff: 'd', commandResult: 'tests: PASS' }),
  })
}

describe('workflow.coding-node-isolation-strategies', () => {
  for (const strategy of ISOLATION_STRATEGIES) {
    it(`${strategy}: provisions a kind-matched path, runs there, disposes exactly once (success)`, async () => {
      const { provisioner, disposeSpies, provisionArgs } = strategyProvisioner()
      let workspaceSeenByCoder: string | undefined
      const factory = recordingFactory({ seenWorkspace: (ws) => (workspaceSeenByCoder = ws) })

      const { outcome } = await runCodingNode({
        factory,
        provisioner,
        base: '/base',
        isolation: strategy,
        task: 'task',
      })

      // provision called with the requested isolation arg.
      expect(provisionArgs).toContainEqual({ base: '/base', isolation: strategy })
      // path matches the requested kind.
      expect(outcome.workspace).toBe(kindPath(strategy))
      // the coder's working directory was the returned path.
      expect(workspaceSeenByCoder).toBe(kindPath(strategy))
      // dispose ran exactly once.
      expect(disposeSpies.get(strategy)).toHaveBeenCalledTimes(1)
    })

    it(`${strategy}: disposes exactly once even when the coder throws`, async () => {
      const { provisioner, disposeSpies } = strategyProvisioner()
      const factory = recordingFactory({ seenWorkspace: () => {}, throwOnRun: true })

      await expect(
        runCodingNode({ factory, provisioner, base: '/base', isolation: strategy, task: 'task' }),
      ).rejects.toThrow(/coder exploded/)

      expect(disposeSpies.get(strategy)).toHaveBeenCalledTimes(1)
    })
  }

  it('unknown isolation string is rejected BEFORE provisioning (no backend invoked)', async () => {
    const backend = vi.fn<(...args: unknown[]) => unknown>()
    const provisioner = createWorkspaceProvisioner({
      session: backend as never,
      worktree: backend as never,
      sandbox: backend as never,
    })

    await expect(provisioner.provision('/base', 'container')).rejects.toThrow(
      UnknownIsolationStrategyError,
    )
    await expect(provisioner.provision('/base', 'container')).rejects.toThrow(
      /unknown isolation strategy: 'container'/,
    )
    expect(backend).not.toHaveBeenCalled()
  })

  it('each strategy yields a DISTINCT path (no shared/default fallback)', async () => {
    const { provisioner } = strategyProvisioner()
    const session = await provisioner.provision('/base', 'session')
    const worktree = await provisioner.provision('/base', 'worktree')
    const sandbox = await provisioner.provision('/base', 'sandbox')
    const paths = new Set([session.path, worktree.path, sandbox.path])
    expect(paths.size).toBe(3)
    await session.dispose()
    await worktree.dispose()
    await sandbox.dispose()
  })
})
