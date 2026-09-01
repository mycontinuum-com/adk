import { z } from 'zod'

import type { TestRunFn } from './test'

import { agent } from '../agents'
import { adk } from '../api'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { MockAdapter } from '../testing'
import { runTestLoop } from './test'

const app = adk()

function createTestHarness(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  }>,
) {
  const mockAdapter = new MockAdapter({ responses })
  const runner = new BaseRunner({
    adapters: { openai: mockAdapter },
  })

  const run: TestRunFn = (runnable, config) => {
    const session = (config.session ?? new BaseSession('test')) as BaseSession
    const inputNs = config.input as
      | { message?: string; state?: Record<string, unknown> }
      | undefined

    if (inputNs?.message) {
      session.input.message(inputNs.message)
    }

    if (inputNs?.state) {
      session.state.update(inputNs.state)
    }

    return runner.run(runnable, session, {
      hooks: config.hooks,
      timeout: config.timeout,
    })
  }

  return { run, mockAdapter }
}

describe('runTestLoop', () => {
  it('accepts input as string shorthand', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const { run } = createTestHarness([{ text: 'Done' }])

    const result = await runTestLoop(myAgent, run, { input: 'Start' })

    expect(result.status).toBe('completed')
  })

  describe('tool handlers', () => {
    it('resolves single tool yield with array handler', async () => {
      const askTool = app.tool({
        name: 'ask',
        description: 'Ask',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        finalize: (ctx) => ({ answer: ctx.input!.answer }),
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [askTool],
      })

      const { run } = createTestHarness([
        { toolCalls: [{ name: 'ask', args: { question: 'Color?' } }] },
        { text: 'Got it' },
      ])

      const result = await runTestLoop(myAgent, run, {
        input: {
          message: 'Start',
          toolHandlers: { ask: [{ answer: 'Blue' }] },
        },
      })

      expect(result.status).toBe('completed')
    })

    it('resolves tool yield with function handler', async () => {
      const askTool = app.tool({
        name: 'ask',
        description: 'Ask',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        finalize: (ctx) => ({ answer: ctx.input!.answer }),
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [askTool],
      })

      const { run } = createTestHarness([
        { toolCalls: [{ name: 'ask', args: { question: 'Color?' } }] },
        { text: 'Got it' },
      ])

      const result = await runTestLoop(myAgent, run, {
        input: {
          message: 'Start',
          toolHandlers: { ask: () => ({ answer: 'Red' }) },
        },
      })

      expect(result.status).toBe('completed')
    })

    it('consumes array handler sequentially', async () => {
      const askTool = app.tool({
        name: 'ask',
        description: 'Ask',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        finalize: (ctx) => ({ answer: ctx.input!.answer }),
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [askTool],
      })

      const { run } = createTestHarness([
        { toolCalls: [{ name: 'ask', args: { question: 'Q1' } }] },
        { toolCalls: [{ name: 'ask', args: { question: 'Q2' } }] },
        { text: 'Done' },
      ])

      const result = await runTestLoop(myAgent, run, {
        input: {
          message: 'Start',
          toolHandlers: { ask: [{ answer: 'A1' }, { answer: 'A2' }] },
        },
      })

      expect(result.status).toBe('completed')
    })

    it('resolves multi-tool yield', async () => {
      const confirm = app.tool({
        name: 'confirm',
        description: 'Confirm',
        schema: z.object({ action: z.string() }),
        yieldSchema: z.object({ ok: z.boolean() }),
        finalize: (ctx) => ({ ok: ctx.input!.ok }),
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [confirm],
      })

      const { run } = createTestHarness([
        {
          toolCalls: [
            { name: 'confirm', args: { action: 'A' } },
            { name: 'confirm', args: { action: 'B' } },
          ],
        },
        { text: 'Done' },
      ])

      const result = await runTestLoop(myAgent, run, {
        input: {
          message: 'Start',
          toolHandlers: { confirm: [{ ok: true }, { ok: false }] },
        },
      })

      expect(result.status).toBe('completed')
    })
  })

  describe('error handling', () => {
    it('throws when tool handler is missing', async () => {
      const askTool = app.tool({
        name: 'ask',
        description: 'Ask',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [askTool],
      })

      const { run } = createTestHarness([{ toolCalls: [{ name: 'ask', args: { question: 'Q' } }] }])

      await expect(
        runTestLoop(myAgent, run, {
          input: { message: 'Start', toolHandlers: {} },
        }),
      ).rejects.toThrow("No handler for tool 'ask'")
    })

    it('throws when array handler is exhausted', async () => {
      const askTool = app.tool({
        name: 'ask',
        description: 'Ask',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        finalize: (ctx) => ({ answer: ctx.input!.answer }),
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [askTool],
      })

      const { run } = createTestHarness([
        { toolCalls: [{ name: 'ask', args: { question: 'Q1' } }] },
        { toolCalls: [{ name: 'ask', args: { question: 'Q2' } }] },
      ])

      await expect(
        runTestLoop(myAgent, run, {
          input: {
            message: 'Start',
            toolHandlers: { ask: [{ answer: 'A1' }] },
          },
        }),
      ).rejects.toThrow("Tool 'ask' handler exhausted")
    })

    it('returns error when max iterations exceeded', async () => {
      const askTool = app.tool({
        name: 'ask',
        description: 'Ask',
        schema: z.object({ question: z.string() }),
        yieldSchema: z.object({ answer: z.string() }),
        finalize: (ctx) => ({ answer: ctx.input!.answer }),
      })

      const myAgent = agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [askTool],
      })

      const responses = Array.from({ length: 5 }, () => ({
        toolCalls: [{ name: 'ask', args: { question: 'Q' } }],
      }))
      const { run } = createTestHarness(responses)

      const result = await runTestLoop(myAgent, run, {
        input: {
          message: 'Start',
          toolHandlers: { ask: () => ({ answer: 'A' }) },
        },
        maxTurns: 3,
      })

      expect(result.status).toBe('error')
      if (result.status === 'error') {
        expect(result.error).toContain('Max iterations')
      }
    })
  })
})
