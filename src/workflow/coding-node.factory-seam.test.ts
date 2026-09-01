/**
 * Workflow.coding-node-factory-seam — Coding Node Factory Seam Reconciles And Swaps
 *
 * The node never calls a coding-agent constructor directly — construction goes through
 * CodingAgentFactory.create({ workspace, signal }), in the order provision → construct → run. The
 * seam invokes the shipped createClaudeCodeAgent({ workspace }).run(task) path while presenting the
 * proposal's { workspace, task } outcome shape, with the shipped CodingAgent interface used
 * unchanged. Swapping to a second factory drives the identical node body.
 *
 * Evidence: spies on create / createClaudeCodeAgent / .run asserting call order and factory-routed
 * construction; a second run against a stub factory.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'

import type { SDKMessage, SDKResultMessage } from '../agents/coding/claude-code'

import {
  createCodingAgentFactory,
  createClaudeCodeFactory,
  runCodingNode,
  type CodingAgentFactory,
  type CodingNodeResult,
} from '../agents/coding'
import * as claudeCodeModule from '../agents/coding/claude-code'
import { createWorkspaceProvisioner } from '../agents/coding/workspace-provisioner'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SEAM_DIR = `${HERE}../agents/coding`

/** Minimal mock SDK: yields a single successful result message. */
function mockSdk() {
  return {
    // eslint-disable-next-line require-yield
    async *query(_params: { prompt: string }): AsyncGenerator<SDKMessage> {
      const result: SDKResultMessage = {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        session_id: 'sdk-session',
      }
      yield result
    },
  }
}

const provisioner = createWorkspaceProvisioner()

describe('workflow.coding-node-factory-seam', () => {
  it('construction routes through factory.create over the shipped createClaudeCodeAgent path', async () => {
    const order: string[] = []
    const runSpy = vi.fn<(...args: unknown[]) => unknown>()

    // Spy on the shipped createClaudeCodeAgent to prove the seam constructs via it (not a shadow).
    const createClaudeCodeSpy = vi
      .spyOn(claudeCodeModule, 'createClaudeCodeAgent')
      .mockImplementation((opts) => {
        const agent = claudeCodeModule.createClaudeCodeAgentWithSDK(mockSdk(), opts)
        const realRun = agent.run.bind(agent)
        agent.run = ((task: string | { task: string }) => {
          order.push('run')
          runSpy(task)
          return realRun(task)
        }) as typeof agent.run
        return agent
      })

    // The factory's build uses the shipped createClaudeCodeAgent (spied above).
    const inner = createClaudeCodeFactory({
      delta: () => ({ diff: 'changed', commandResult: 'tests: PASS' }),
    })

    const createSpy = vi.fn<(...args: unknown[]) => unknown>()
    const factory: CodingAgentFactory = {
      create: (o) => {
        order.push('create')
        createSpy(o)
        return inner.create(o)
      },
    }

    // Provision happens before create — record it.
    const recordingProvisioner = {
      provision: async (base: string, iso: string) => {
        order.push('provision')
        return provisioner.provision(base, iso)
      },
    }

    const { outcome } = await runCodingNode({
      factory,
      provisioner: recordingProvisioner,
      base: '/repo',
      isolation: 'session',
      task: 'implement the failing test',
    })

    expect(order).toEqual(['provision', 'create', 'run'])
    expect(createSpy).toHaveBeenCalledOnce()
    expect(createClaudeCodeSpy).toHaveBeenCalledOnce()
    // The shipped createClaudeCodeAgent was constructed with the provisioned workspace path.
    expect(createClaudeCodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: outcome.workspace }),
    )
    expect(runSpy).toHaveBeenCalledOnce()
    // Outcome carries the proposal's { workspace, task } shape with the delta.
    expect(outcome.task).toBe('implement the failing test')
    expect(outcome.delta).toEqual({ diff: 'changed', commandResult: 'tests: PASS' })

    createClaudeCodeSpy.mockRestore()
  })

  it('swapping to a second (stub) factory drives the identical node body unchanged', async () => {
    // A reusable node-body invocation — byte-for-byte identical between the two factories.
    const runNode = (factory: CodingAgentFactory): Promise<CodingNodeResult> =>
      runCodingNode({
        factory,
        provisioner,
        base: '/repo',
        isolation: 'worktree',
        task: 'implement',
      })

    // Factory 1 — a stub coding agent.
    const create1 = vi.fn<(...args: unknown[]) => unknown>()
    const factory1: CodingAgentFactory = createCodingAgentFactory({
      build: () =>
        ({
          name: 's1',
          run: () =>
            Promise.resolve({
              status: 'completed',
              sessionId: 's1',
              output: { value: { modifiedFiles: ['f1'] }, items: [] },
            }),
        }) as never,
      delta: () => ({ diff: 'factory1', commandResult: 'tests: PASS' }),
    })
    const wrapped1: CodingAgentFactory = {
      create: (o) => {
        create1(o)
        return factory1.create(o)
      },
    }

    // Factory 2 — a different stub. Same node body.
    const create2 = vi.fn<(...args: unknown[]) => unknown>()
    const factory2: CodingAgentFactory = createCodingAgentFactory({
      build: () =>
        ({
          name: 's2',
          run: () =>
            Promise.resolve({
              status: 'completed',
              sessionId: 's2',
              output: { value: { modifiedFiles: ['f2'] }, items: [] },
            }),
        }) as never,
      delta: () => ({ diff: 'factory2', commandResult: 'tests: PASS' }),
    })
    const wrapped2: CodingAgentFactory = {
      create: (o) => {
        create2(o)
        return factory2.create(o)
      },
    }

    const r1 = await runNode(wrapped1)
    const r2 = await runNode(wrapped2)

    expect(create1).toHaveBeenCalledOnce()
    expect(create2).toHaveBeenCalledOnce()
    expect(r1.outcome.delta.diff).toBe('factory1')
    expect(r2.outcome.delta.diff).toBe('factory2')
    // Both scored passing through the SAME runCodingNode body, no node-body edits between runs.
    expect(r1.score.passed).toBe(true)
    expect(r2.score.passed).toBe(true)
  })

  it('the seam keeps the Claude Agent SDK lazy: no static import of the harness specifier', () => {
    // The seam modules (factory + orchestrator) must NOT statically import
    // '@anthropic-ai/claude-agent-sdk'. The harness is reachable ONLY via the shipped agent's
    // runtime dynamic import, which fires only when run() actually executes a coding node.
    const factorySrc = readFileSync(`${SEAM_DIR}/factory.ts`, 'utf8')
    const orchestratorSrc = readFileSync(`${SEAM_DIR}/coding-node.ts`, 'utf8')
    const importLine = /^\s*import[^\n]*['"]@anthropic-ai\/claude-agent-sdk['"]/m
    expect(importLine.test(factorySrc)).toBe(false)
    expect(importLine.test(orchestratorSrc)).toBe(false)
    // The shipped agent still references the specifier (its dynamic, lazy load) — so the boundary is
    // real, not just absent everywhere.
    const shippedAgentSrc = readFileSync(`${SEAM_DIR}/claude-code/agent.ts`, 'utf8')
    expect(shippedAgentSrc.includes('@anthropic-ai/claude-agent-sdk')).toBe(true)
  })
})
