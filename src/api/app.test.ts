import { z } from 'zod'

import type { Hook } from '../hook/types'

import { agent } from '../agents'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { inMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter } from '../testing'
import { adk } from './app'

const app = adk()
const service = sessionService(inMemoryStore())

function createRunner(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  }>,
  options?: { hooks?: Hook[] },
) {
  const mockAdapter = new MockAdapter({ responses })
  return new BaseRunner({
    sessionService: service,
    adapters: { openai: mockAdapter },
    hooks: options?.hooks,
  })
}

describe('yield/resume', () => {
  it('tool yield and resume via session.input.tool()', async () => {
    const askTool = app.tool({
      name: 'ask',
      description: 'Ask',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
      finalize: (ctx) => ({
        question: ctx.args.question,
        answer: ctx.input!.answer,
      }),
    })

    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [askTool],
    })

    const runner = createRunner([
      { toolCalls: [{ name: 'ask', args: { question: 'Color?' } }] },
      { text: 'Thanks!' },
    ])

    const session = new BaseSession('test')
    session.input.message('Ask me something')

    const result1 = await runner.run(myAgent, session)
    expect(result1.status).toBe('yielded_tool')

    const callId = result1.status === 'yielded_tool' ? result1.yieldedTools[0].callId : ''

    session.input.tool({ callId, input: { answer: 'Blue' } })
    const result2 = await runner.run(myAgent, session)

    expect(result2.status).toBe('completed')
    const toolResults = [...session.events].filter((e) => e.type === 'tool_result')
    expect(
      toolResults.some(
        (r) => r.type === 'tool_result' && (r.result as { answer: string })?.answer === 'Blue',
      ),
    ).toBe(true)
  })

  it('multi-tool yield and resume', async () => {
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

    const runner = createRunner([
      {
        toolCalls: [
          { name: 'confirm', args: { action: 'A' } },
          { name: 'confirm', args: { action: 'B' } },
        ],
      },
      { text: 'Done' },
    ])

    const session = new BaseSession('test')
    session.input.message('Do two things')

    const result1 = await runner.run(myAgent, session)
    expect(result1.status).toBe('yielded_tool')

    const calls = result1.status === 'yielded_tool' ? result1.yieldedTools : []
    expect(calls.length).toBe(2)

    for (const call of calls) {
      session.input.tool({ callId: call.callId, input: { ok: true } })
    }

    const result2 = await runner.run(myAgent, session)
    expect(result2.status).toBe('completed')
  })
})

describe('RunOptions.state', () => {
  it('applies session-scope state before execution', async () => {
    let capturedMode: unknown

    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [
        {
          beforeAgent: (ctx) => {
            capturedMode = ctx.state.mode
          },
        },
      ],
    })

    const runner = createRunner([{ text: 'OK' }])

    const session = new BaseSession('test')
    session.input.message('Hello')

    session.state.update({ mode: 'debug' })
    await runner.run(myAgent, session)

    expect(capturedMode).toBe('debug')
    expect(session.state.mode).toBe('debug')
  })
})

describe('RunConfig.hooks (call-site)', () => {
  it('call-site hooks fire during execution', async () => {
    const called: string[] = []

    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const runner = createRunner([{ text: 'Hello' }])
    const session = new BaseSession('test')
    session.input.message('Hi')

    await runner.run(myAgent, session, {
      hooks: [
        {
          beforeAgent: () => {
            called.push('beforeAgent')
          },
          afterAgent: () => {
            called.push('afterAgent')
          },
        },
      ],
    })

    expect(called).toContain('beforeAgent')
    expect(called).toContain('afterAgent')
  })

  it('call-site hooks compose as innermost layer', async () => {
    const order: string[] = []

    const agentHook: Hook = {
      beforeAgent: () => {
        order.push('agent')
      },
    }

    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [agentHook],
    })

    const runnerHook: Hook = {
      beforeAgent: () => {
        order.push('runner')
      },
    }

    const runner = createRunner([{ text: 'Hello' }], { hooks: [runnerHook] })
    const session = new BaseSession('test')
    session.input.message('Hi')

    await runner.run(myAgent, session, {
      hooks: [
        {
          beforeAgent: () => {
            order.push('callsite')
          },
        },
      ],
    })

    expect(order).toEqual(['runner', 'agent', 'callsite'])
  })

  it('call-site onEvent receives stream events', async () => {
    const eventTypes: string[] = []

    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const runner = createRunner([{ text: 'Hello' }])
    const session = new BaseSession('test')
    session.input.message('Hi')

    await runner.run(myAgent, session, {
      hooks: [
        {
          onEvent: (e) => eventTypes.push(e.type),
        },
      ],
    })

    expect(eventTypes).toContain('assistant')
    expect(eventTypes).toContain('invocation_start')
  })

  it('call-site hook can short-circuit agent', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const mockAdapter = new MockAdapter({
      responses: [{ text: 'Should not reach' }],
    })
    const runner = new BaseRunner({
      sessionService: service,
      adapters: { openai: mockAdapter },
    })

    const session = new BaseSession('test')
    session.input.message('Hi')

    const result = await runner.run(myAgent, session, {
      hooks: [
        {
          beforeAgent: () => 'Blocked by call-site hook',
        },
      ],
    })

    expect(result.status).toBe('completed')
    expect(result.output.text).toBe('Blocked by call-site hook')
    expect(mockAdapter.stepCalls.length).toBe(0)
  })
})

describe('abort', () => {
  it('StreamResult has abort method', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
    })

    const runner = createRunner([{ text: 'Hello' }])
    const session = new BaseSession('test')
    session.input.message('Hi')

    const run = runner.run(myAgent, session)
    expect(typeof run.abort).toBe('function')

    await run
  })
})
