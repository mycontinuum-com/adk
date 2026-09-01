import { z } from 'zod'

import type { Hook } from '../hook/types'
import type { SimulateRunFn } from './simulate'

import { agent } from '../agents'
import { adk } from '../api'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { MockAdapter } from '../testing'
import { runSimulateLoop } from './simulate'

const app = adk()

function createHarness(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  }>,
) {
  const mockAdapter = new MockAdapter({ responses })
  const runner = new BaseRunner({
    adapters: { openai: mockAdapter },
  })

  const run: SimulateRunFn = (runnable, config) => {
    const session = (config.session ?? new BaseSession('test')) as BaseSession
    const inputNs = config.input as
      | { message?: string; state?: Record<string, unknown> }
      | undefined

    if (inputNs?.message) {
      session.input.message(typeof inputNs.message === 'string' ? inputNs.message : inputNs.message)
    }

    if (inputNs?.state) {
      session.state.update(inputNs.state)
    }

    return runner.run(runnable, session, {
      hooks: config.hooks,
      timeout: config.timeout,
    })
  }

  return { run }
}

const shortCircuit = (response: string): Hook => ({
  beforeAgent: () => response,
})

describe('runSimulateLoop', () => {
  it('completes when main agent completes without yielding', async () => {
    const myAgent = agent({
      name: 'main',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const userAgent = agent({
      name: 'user-agent',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('sim response')],
    })

    const { run } = createHarness([{ text: 'Done' }])

    const result = await runSimulateLoop(myAgent, run, {
      input: { message: 'Hello' },
      userAgent,
    })

    expect(result.status).toBe('completed')
  })

  it('accepts input as string shorthand', async () => {
    const myAgent = agent({
      name: 'main',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const userAgent = agent({
      name: 'user-agent',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('sim response')],
    })

    const { run } = createHarness([{ text: 'Done' }])

    const result = await runSimulateLoop(myAgent, run, {
      input: 'Hello',
      userAgent,
    })

    expect(result.status).toBe('completed')
  })

  it('routes tool yields to specialist agents', async () => {
    const askTool = app.tool({
      name: 'ask',
      description: 'Ask',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
      finalize: (ctx) => ({ answer: ctx.input!.answer }),
    })

    const myAgent = agent({
      name: 'main',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [askTool],
    })

    const answerAgent = agent({
      name: 'answerer',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('Blue')],
    })

    const userAgent = agent({
      name: 'user-agent',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('sim response')],
    })

    const { run } = createHarness([
      { toolCalls: [{ name: 'ask', args: { question: 'Color?' } }] },
      { text: 'Thanks' },
    ])

    const result = await runSimulateLoop(myAgent, run, {
      input: { message: 'Start' },
      userAgent,
      toolAgents: { ask: answerAgent },
    })

    expect(result.status).toBe('completed')
  })

  it('throws when tool agent is missing', async () => {
    const askTool = app.tool({
      name: 'ask',
      description: 'Ask',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
    })

    const myAgent = agent({
      name: 'main',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [askTool],
    })

    const userAgent = agent({
      name: 'user-agent',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('sim response')],
    })

    const { run } = createHarness([{ toolCalls: [{ name: 'ask', args: { question: 'Q' } }] }])

    await expect(
      runSimulateLoop(myAgent, run, {
        input: { message: 'Start' },
        userAgent,
        toolAgents: {},
      }),
    ).rejects.toThrow("No agent for tool 'ask'")
  })

  it('respects maxTurns', async () => {
    const askTool = app.tool({
      name: 'ask',
      description: 'Ask',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
      finalize: (ctx) => ({ answer: ctx.input!.answer }),
    })

    const myAgent = agent({
      name: 'main',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [askTool],
    })

    const answerAgent = agent({
      name: 'answerer',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('answer')],
    })

    const userAgent = agent({
      name: 'user-agent',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('sim response')],
    })

    const responses = Array.from({ length: 20 }, () => ({
      toolCalls: [{ name: 'ask', args: { question: 'Q' } }],
    }))
    const { run } = createHarness(responses)

    const result = await runSimulateLoop(myAgent, run, {
      input: { message: 'Start' },
      userAgent,
      toolAgents: { ask: answerAgent },
      maxTurns: 3,
    })

    expect(result.status).toBe('terminated')
    if (result.status === 'terminated') {
      expect(result.terminationReason).toBe('maxTurns')
    }
  })

  it('applies custom transform', async () => {
    const askTool = app.tool({
      name: 'ask',
      description: 'Ask',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
      finalize: (ctx) => ({ answer: ctx.input!.answer }),
    })

    const myAgent = agent({
      name: 'main',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [askTool],
    })

    const answerAgent = agent({
      name: 'answerer',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('transformed-answer')],
    })

    const userAgent = agent({
      name: 'user-agent',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [shortCircuit('sim response')],
    })

    let prepareInputCalled = false
    let processOutputCalled = false

    const { run } = createHarness([
      { toolCalls: [{ name: 'ask', args: { question: 'Q' } }] },
      { text: 'Done' },
    ])

    const result = await runSimulateLoop(myAgent, run, {
      input: { message: 'Start' },
      userAgent,
      toolAgents: { ask: answerAgent },
      transform: {
        prepareInput: (_session, ctx) => {
          prepareInputCalled = true
          return `Transformed: ${ctx.toolName}`
        },
        processOutput: (output) => {
          processOutputCalled = true
          return output
        },
      },
    })

    expect(result.status).toBe('completed')
    expect(prepareInputCalled).toBe(true)
    expect(processOutputCalled).toBe(true)
  })
})
