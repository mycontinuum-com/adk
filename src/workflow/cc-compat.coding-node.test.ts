/**
 * Workflow.cc-compat-coding-node-runner — CC Agent Binds To Coding Node Over A Workspace
 *
 * With `node` set to a coding node runner: each agent() call is dispatched to the coding node
 * runner, which constructs a CodingAgent over the provisioned workspace via the CodingAgentFactory
 * + WorkspaceProvisioner seam (file mutations land in the workspace, not the host); the call
 * resolves to the schema-validated object (or text) on success and null on failure; it is NOT
 * dispatched to a no-tools app.ask. The same agent() under the default config routes to app.ask
 * instead. The LLM-vs-coding split is realized by the `node` config alone, with the body
 * unchanged.
 *
 * Evidence: a coding-shaped CC fixture run through runWorkflowFile with a fake CodingAgentFactory,
 * asserting create({ workspace, signal }) was invoked per agent() and the returned value flows
 * back, contrasted with a default-config run that routes the same agent() to a spied app.ask.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodingAgentFactory } from '../agents/coding'
import type { WorkspaceProvisioner } from '../agents/coding/workspace-provisioner'
import type { NodeRunner } from './types'

import { runCodingNode } from '../agents/coding'
import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'
import { runWorkflowFile } from './index'

const CODING_FIXTURE = `
export const meta = { name: 'coding-node', description: 'build attractor: create files + run commands' }
const r = await agent('create a file under code/ and run the tests')
return { files: r ? r.files : null }
`

describe('workflow.cc-compat-coding-node-runner', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-coding-node-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('with a coding node: agent() constructs a CodingAgent over the provisioned workspace per call', async () => {
    const app = adk()

    // A fake provisioner (no Docker/Modal) and a fake CodingAgentFactory whose create() is spied.
    let disposed = 0
    const provisioner: WorkspaceProvisioner = {
      provision: async () => ({
        path: path.join(tmpDir, 'workspace'),
        dispose: async () => {
          disposed++
        },
      }),
    }
    const createSpy = vi.fn<(o: { workspace: string; signal?: AbortSignal }) => unknown>()
    const factory: CodingAgentFactory = {
      create: (o) => {
        createSpy(o)
        return {
          workspace: o.workspace,
          run: async (task: string | { task: string }) => {
            const taskStr = typeof task === 'string' ? task : task.task
            // Simulate a workspace mutation landing in the provisioned dir.
            await fs.mkdir(o.workspace, { recursive: true })
            await fs.writeFile(path.join(o.workspace, 'created.ts'), `// ${taskStr}`)
            return {
              workspace: o.workspace,
              task: taskStr,
              delta: { diff: 'created.ts', commandResult: 'tests passed' },
              result: { status: 'completed' as const, sessionId: 's', output: { items: [] } },
            }
          },
        }
      },
    }

    // The coding node runner: each agent() runs a CodingAgent over a freshly provisioned workspace.
    const codingRunner: NodeRunner = async (prompt) => {
      const { outcome } = await runCodingNode({
        factory,
        provisioner,
        base: tmpDir,
        isolation: 'session',
        task: prompt,
      })
      // Return the schema-shaped value the body expects (unwrapped, not a RunResult).
      return { files: [path.basename(`${outcome.workspace}/created.ts`)] }
    }

    const fixturePath = path.join(tmpDir, 'coding.fixture.js')
    await fs.writeFile(fixturePath, CODING_FIXTURE)

    const result = await runWorkflowFile(fixturePath, {
      app,
      models: { default: { provider: 'openai' as const, name: 'gpt-4o' }, byTier: {} },
      node: codingRunner,
    })

    expect(result.status).toBe('completed')
    // The coding factory constructed a CodingAgent over the provisioned workspace, once per agent().
    expect(createSpy).toHaveBeenCalledTimes(1)
    const createArg = createSpy.mock.calls[0][0]
    expect(createArg.workspace).toBe(path.join(tmpDir, 'workspace'))
    // The workspace was disposed after the run.
    expect(disposed).toBe(1)
    // The file mutation landed in the workspace (not the host repo).
    const written = await fs.readFile(path.join(tmpDir, 'workspace', 'created.ts'), 'utf8')
    expect(written).toContain('create a file')
    // The unwrapped value flowed back into the body return.
    expect((result.output.value as { files: string[] }).files).toEqual(['created.ts'])
  })

  it('the SAME agent() under the default (omitted node) config routes to app.ask, not a coding agent', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'plain-llm-answer' }] })
    const app = adk({
      name: 'default-contrast',
      adapters: { openai: mockAdapter },
      defaultModel: openai('gpt-4o-mini'),
    })
    const askSpy = vi.spyOn(app, 'ask')

    const fixturePath = path.join(tmpDir, 'coding-default.fixture.js')
    await fs.writeFile(fixturePath, CODING_FIXTURE)

    const result = await runWorkflowFile(fixturePath, {
      app,
      models: { default: openai('gpt-4o-mini'), byTier: {} },
      // node omitted → default app.ask
    })

    expect(result.status).toBe('completed')
    // The identical agent() body routed to app.ask under the default config.
    expect(askSpy).toHaveBeenCalledTimes(1)
    // r is a plain LLM string ('plain-llm-answer'), NOT a coding node's { files } object — so r.files
    // is undefined. This is the contrast: a no-tools app.ask answer has no workspace-mutation shape.
    expect((result.output.value as { files: unknown }).files).toBeUndefined()
  })
})
