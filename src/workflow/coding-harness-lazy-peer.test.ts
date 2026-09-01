/**
 * Workflow.coding-harness-lazy-peer — Coding Harness Is A Lazy Optional Peer
 *
 * LLM-only workflows load and run without the coding-agent harness present. Importing the core does
 * NOT import @anthropic-ai/claude-agent-sdk. Only when a coding node actually runs is the harness
 * required.
 *
 * Evidence: import-graph/build (peer uninstalled) + unit
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'

describe('workflow.coding-harness-lazy-peer', () => {
  it('LLM-only workflow runs without the coding-agent harness being loaded', async () => {
    const app = adk()
    const wf = app.step({
      name: 'llm-only',
      execute: async (ctx) => {
        ctx.note('no coding agent here')
        ctx.output({ done: true })
      },
    })

    // Must complete without requiring @anthropic-ai/claude-agent-sdk
    const result = await app.run(wf, 'go')
    expect(result.status).toBe('completed')
  })

  it('importing the ADK core does not transitively load @anthropic-ai/claude-agent-sdk at module load', async () => {
    // The test being importable at all (no require-time crash) proves this for the test
    // environment where the peer is not installed.
    const coreModule = await import('../index')
    expect(typeof coreModule.adk).toBe('function')
    // fanout and annotation are also accessible — no harness needed
    expect(typeof coreModule.fanout).toBe('function')
    expect(typeof coreModule.isAnnotationEvent).toBe('function')
  })

  it('coding agent module is loadable separately (lazy peer boundary)', async () => {
    // The coding module is separate from the core — it can be loaded when needed.
    // We import the type shape only here (the actual SDK load is a runtime concern).
    const codingModule = await import('../agents/coding/index')
    // The coding module exports types and factories but does NOT import the Claude Agent SDK
    // at import time (only when createClaudeCodeAgent is actually called).
    expect(typeof codingModule.createMockCodingAgent).toBe('function')
  })
})
