/**
 * Workflow.coding-node-delta-scored — Coding Node Scored On Delta
 *
 * The agent is constructed through CodingAgentFactory.create({ workspace, signal }) (not a direct
 * constructor) in the order provision → construct → run; the workspace is disposed after the run;
 * the score derives from the ENVIRONMENT DELTA (diff + command/test result), NEVER the agent's
 * self-reported summary — so a passing self-report over a FAILING delta still yields a failing
 * score.
 *
 * Evidence: vitest with a fake CodingAgentFactory + fake provisioner + ./eval metric.
 */
import { describe, it, expect, vi } from 'vitest'

import type { CodingResult } from '../agents/coding'
import type {
  ProvisionedWorkspace,
  WorkspaceProvisioner,
} from '../agents/coding/workspace-provisioner'

import { createCodingAgentFactory, runCodingNode, type CodingAgentFactory } from '../agents/coding'
import { codingDeltaMetric } from '../eval/metrics/coding'

/** Build a fake shipped CodingAgent whose run() resolves a CodingResult with the given fields. */
function fakeAgent(opts: {
  summary: string
  modifiedFiles: string[]
  status?: CodingResult['status']
  onRun?: () => void
}) {
  return {
    name: 'fake',
    description: 'fake',
    schema: undefined as never,
    run: (_task: string | { task: string }) => {
      opts.onRun?.()
      const result: CodingResult = {
        status: opts.status ?? 'completed',
        sessionId: 'fake-session',
        output: { text: opts.summary, value: { modifiedFiles: opts.modifiedFiles }, items: [] },
      }
      // CodingHandle is a PromiseLike<CodingResult>; a resolved promise satisfies the await path.
      return Promise.resolve(result) as unknown as ReturnType<
        import('../agents/coding').CodingAgent['run']
      >
    },
    execute: vi.fn<(...args: unknown[]) => unknown>(),
    asTool: vi.fn<(...args: unknown[]) => unknown>(),
  } as unknown as import('../agents/coding').CodingAgent
}

/** A provisioner that records provision/dispose calls and returns a fixed path. */
function recordingProvisioner(path: string): {
  provisioner: WorkspaceProvisioner
  provisionSpy: ReturnType<typeof vi.fn>
  disposeSpy: ReturnType<typeof vi.fn>
} {
  const disposeSpy = vi.fn<() => void>()
  const provisionSpy = vi.fn<(base: string, isolation: string) => Promise<ProvisionedWorkspace>>(
    async (_base: string, isolation: string): Promise<ProvisionedWorkspace> => ({
      path,
      isolation: isolation as ProvisionedWorkspace['isolation'],
      dispose: disposeSpy,
    }),
  )
  return { provisioner: { provision: provisionSpy }, provisionSpy, disposeSpy }
}

describe('workflow.coding-node-delta-scored', () => {
  it('provision → create → run order; create({workspace,signal}); dispose after run', async () => {
    const order: string[] = []
    const { provisioner, provisionSpy, disposeSpy } = recordingProvisioner('/fake/ws')
    provisionSpy.mockImplementation(async (_b: string, iso: string) => {
      order.push('provision')
      return {
        path: '/fake/ws',
        isolation: iso as ProvisionedWorkspace['isolation'],
        dispose: () => {
          order.push('dispose')
          disposeSpy()
        },
      }
    })

    const createSpy = vi.fn<(...args: unknown[]) => unknown>()
    // Wrap a factory so we can spy on create({ workspace, signal }) and assert call order.
    const inner = createCodingAgentFactory({
      build: () =>
        fakeAgent({
          summary: 'agent says done',
          modifiedFiles: ['a.ts'],
          onRun: () => order.push('run'),
        }),
      delta: (result) => ({
        diff: (result.output.value?.modifiedFiles ?? []).join(','),
        commandResult: 'tests: PASS',
      }),
    })
    const factory: CodingAgentFactory = {
      create: (o) => {
        order.push('create')
        createSpy(o)
        return inner.create(o)
      },
    }

    const { outcome, score } = await runCodingNode({
      factory,
      provisioner,
      base: '/base',
      isolation: 'sandbox',
      task: 'implement the failing requirement',
      metric: codingDeltaMetric(),
    })

    expect(order).toEqual(['provision', 'create', 'run', 'dispose'])
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/fake/ws' }))
    expect(outcome.workspace).toBe('/fake/ws')
    expect(score.passed).toBe(true)
  })

  it('score from delta, NOT self-report: passing summary over FAILING delta scores failing', async () => {
    const { provisioner } = recordingProvisioner('/fake/ws')

    // The agent claims success but produced NO files and the command result FAILs.
    const factory = createCodingAgentFactory({
      build: () =>
        fakeAgent({ summary: 'All done — tests pass!', modifiedFiles: [], status: 'completed' }),
      delta: () => ({ diff: '', commandResult: 'tests: FAIL' }),
    })

    const { outcome, score } = await runCodingNode({
      factory,
      provisioner,
      base: '/base',
      isolation: 'session',
      task: 'implement',
      metric: codingDeltaMetric(),
    })

    // The self-report is a passing claim...
    expect(outcome.summary).toContain('done')
    // ...but the DELTA fails, so the score fails. The summary is NOT consulted.
    expect(score.passed).toBe(false)
  })

  it('positive pair: a real delta (files + passing command) scores passing', async () => {
    const { provisioner } = recordingProvisioner('/fake/ws')
    const factory = createCodingAgentFactory({
      build: () => fakeAgent({ summary: 'changed two files', modifiedFiles: ['x.ts', 'y.ts'] }),
      delta: (r) => ({
        diff: (r.output.value?.modifiedFiles ?? []).map((f) => `modified ${f}`).join('\n'),
        commandResult: 'tests: PASS',
      }),
    })

    const { score } = await runCodingNode({
      factory,
      provisioner,
      base: '/base',
      isolation: 'worktree',
      task: 'implement',
    })

    expect(score.passed).toBe(true)
  })
})
