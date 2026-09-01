/**
 * Workflow.cc-compat-default-node-is-ask — Omitted Node Runner Defaults To No-Tools app.ask
 *
 * When `node` is OMITTED the loader binds agent() to the default node runner, which is app.ask — a
 * one-shot, NO-TOOLS, fresh-session LLM call; each agent() call runs isolated on its own
 * BaseSession, exposes no tools to the model, and returns the schema-validated value or text. No
 * coding agent and no workspace are involved; the default is not ctx.run (shared session) nor a
 * tool-equipped agent.
 *
 * Evidence: a no-tools CC fixture with `node` omitted, asserting each agent() resolved through a
 * spied app.ask on a fresh session, that the constructed default node exposes no tools, and that no
 * CodingAgentFactory was constructed.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as codingModule from '../agents/coding'
import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'
import { runWorkflowFile } from './index'

describe('workflow.cc-compat-default-node-is-ask', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-default-node-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('omitted node → each agent() routes through app.ask (no-tools, fresh session); no CodingAgentFactory', async () => {
    const mockAdapter = new MockAdapter({
      responses: [{ text: 'classification' }, { text: 'extraction' }],
    })

    // Capture the tools/sessions the inner runs were constructed with.
    const capturedTools: unknown[][] = []
    const capturedSessionIds: string[] = []
    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            capturedTools.push(ctx.agent.tools ?? [])
            capturedSessionIds.push(ctx.session.id)
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    const app = adk({
      name: 'default-node',
      adapters: { openai: captureAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })

    // Spy app.ask to prove the default binding IS app.ask.
    const askSpy = vi.spyOn(app, 'ask')

    // Spy the coding-agent factory constructors to prove NONE are constructed for the default path.
    const claudeFactorySpy = vi.spyOn(codingModule, 'createClaudeCodeFactory')
    const codingFactorySpy = vi.spyOn(codingModule, 'createCodingAgentFactory')

    const fixturePath = path.join(tmpDir, 'no-tools.fixture.js')
    await fs.writeFile(
      fixturePath,
      `
export const meta = { name: 'no-tools', description: 'reasoning/extraction only' }
const a = await agent('classify this')
const b = await agent('extract that')
return { a, b }
`,
    )

    const result = await runWorkflowFile(fixturePath, {
      app,
      models: { default: openai('gpt-4o-mini'), byTier: {} },
      // node: omitted intentionally → default app.ask
    })

    expect(result.status).toBe('completed')

    // app.ask was the default node runner — called once per agent() call.
    expect(askSpy).toHaveBeenCalledTimes(2)

    // Each inner run exposed NO tools to the model (app.ask is a no-tools call).
    expect(capturedTools).toHaveLength(2)
    expect(capturedTools[0]).toEqual([])
    expect(capturedTools[1]).toEqual([])

    // Each agent() ran on its OWN fresh BaseSession (isolation by default, not a shared ctx.run).
    expect(capturedSessionIds).toHaveLength(2)
    expect(capturedSessionIds[0]).not.toBe(capturedSessionIds[1])

    // No coding agent / workspace involved for the default path.
    expect(claudeFactorySpy).not.toHaveBeenCalled()
    expect(codingFactorySpy).not.toHaveBeenCalled()

    // The unwrapped text values flowed back into the body return.
    expect(result.output?.value).toEqual({ a: 'classification', b: 'extraction' })
  })
})
