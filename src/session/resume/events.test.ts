import { z } from 'zod'

import type { InvocationYieldEvent, InvocationResumeEvent } from '../../types'

import { loop } from '../../agents'
import { adk } from '../../api'
import { BaseRunner } from '../../core'
import { MockAdapter, createTestSession, testAgent, findEventsByType } from '../../testing'
import { buildInvocationTree, computeResumeContext } from './index'

const app = adk()

describe('Yield and Resume - Event Model', () => {
  let mockAdapter: MockAdapter
  let runner: BaseRunner

  const yieldingTool = app.tool({
    name: 'get_approval',
    description: 'Get approval',
    schema: z.object({ reason: z.string() }),
    yieldSchema: z.object({ approved: z.boolean() }),
    finalize: (ctx) => ctx.input,
  })

  beforeEach(() => {
    mockAdapter = new MockAdapter()
    runner = new BaseRunner({
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    })
  })

  test('emits invocation_yield event when tool yields', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }] }])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Need approval')
    await runner.run(myAgent, session)

    const yieldEvents = findEventsByType(
      session.events,
      'invocation_yield',
    ) as InvocationYieldEvent[]

    expect(yieldEvents).toHaveLength(1)
    expect(yieldEvents[0].yieldedToolIds).toHaveLength(1)
    expect(yieldEvents[0].yieldIndex).toBe(0)
  })

  test('emits invocation_resume event when resuming', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }] }])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Need approval')
    const result1 = await runner.run(myAgent, session)

    expect(result1.status).toBe('yielded_tool')
    if (result1.status !== 'yielded_tool') return

    session.input.tool({
      callId: result1.yieldedTools[0].callId,
      input: { approved: true },
    })

    mockAdapter.setResponses([{ text: 'Done' }])
    await runner.run(myAgent, session)

    const resumeEvents = findEventsByType(
      session.events,
      'invocation_resume',
    ) as InvocationResumeEvent[]

    expect(resumeEvents).toHaveLength(1)
    expect(resumeEvents[0].yieldIndex).toBe(0)
  })

  test('emits invocation_end only after full completion, not after yield', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }] }])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Need approval')
    await runner.run(myAgent, session)

    expect(findEventsByType(session.events, 'invocation_end')).toHaveLength(0)
    expect(findEventsByType(session.events, 'invocation_yield')).toHaveLength(1)
  })

  test('invocation tree builds with yielded state', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }] }])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Test')
    await runner.run(myAgent, session)

    const tree = buildInvocationTree(session.events)
    expect(tree).toHaveLength(1)
    expect(tree[0].state).toBe('yielded')
    expect(tree[0].yieldedToolIds).toHaveLength(1)
  })

  test('invocation tree tracks tool calls and input', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }] }])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Test')
    const result = await runner.run(myAgent, session)

    if (result.status !== 'yielded_tool') return
    session.input.tool({
      callId: result.yieldedTools[0].callId,
      input: { approved: true },
    })

    const tree = buildInvocationTree(session.events)
    expect(tree[0].toolCalls.size).toBe(1)
    const toolEntry = tree[0].toolCalls.get(result.yieldedTools[0].callId)
    expect(toolEntry?.input).toBeDefined()
  })
})

describe('Yield and Resume - Session Status', () => {
  let mockAdapter: MockAdapter
  let runner: BaseRunner

  const yieldingTool = app.tool({
    name: 'get_approval',
    description: 'Get approval',
    schema: z.object({ reason: z.string() }),
    yieldSchema: z.object({ approved: z.boolean() }),
    finalize: (ctx) => ctx.input,
  })

  beforeEach(() => {
    mockAdapter = new MockAdapter()
    runner = new BaseRunner({
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    })
  })

  test('session is awaiting_input when yields are unresolved', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }] }])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Test')
    await runner.run(myAgent, session)

    expect(session.status).toBe('awaiting_input')
    expect(session.yieldedTools).toHaveLength(1)
  })

  test('can resume when all yields are resolved', async () => {
    mockAdapter.setResponses([{ toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }] }])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Test')
    const result = await runner.run(myAgent, session)

    if (result.status !== 'yielded_tool') return
    session.input.tool({
      callId: result.yieldedTools[0].callId,
      input: { approved: true },
    })

    expect(session.yieldedTools).toHaveLength(0)
    const resumeContext = computeResumeContext(session.events, myAgent)
    expect(resumeContext).toBeDefined()
  })

  test('session is completed for fully completed session', async () => {
    mockAdapter.setResponses([{ text: 'Done' }])

    const myAgent = testAgent()
    const session = createTestSession('Test')
    await runner.run(myAgent, session)

    expect(session.status).toBe('completed')
  })

  test('session is awaiting_input when loop yields for new user message', async () => {
    mockAdapter.setResponses([{ text: 'Iteration 1' }])

    const loopAgent = loop({
      name: 'conversational_loop',
      runnable: testAgent(),
      maxIterations: 5,
      while: () => true,
      yields: true,
    })

    const session = createTestSession('Start conversation')
    const result = await runner.run(loopAgent, session)

    expect(result.status).toBe('yielded_message')
    if (result.status === 'yielded_message') {
      expect(result.yieldedInvocationId).toBeDefined()
    }
    expect(session.status).toBe('awaiting_input')
  })
})

describe('Yield and Resume - Multiple Yields', () => {
  let mockAdapter: MockAdapter
  let runner: BaseRunner

  const yieldingTool = app.tool({
    name: 'get_approval',
    description: 'Get approval',
    schema: z.object({ reason: z.string() }),
    yieldSchema: z.object({ approved: z.boolean() }),
    finalize: (ctx) => ctx.input,
  })

  beforeEach(() => {
    mockAdapter = new MockAdapter()
    runner = new BaseRunner({
      adapters: { openai: mockAdapter, gemini: mockAdapter },
    })
  })

  test('handles multiple yields in same step', async () => {
    mockAdapter.setResponses([
      {
        toolCalls: [
          { name: 'get_approval', args: { reason: 'first' } },
          { name: 'get_approval', args: { reason: 'second' } },
        ],
      },
    ])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Multiple approvals')
    const result = await runner.run(myAgent, session)

    expect(result.status).toBe('yielded_tool')
    if (result.status === 'yielded_tool') {
      expect(result.yieldedTools).toHaveLength(2)
    }
  })

  test('requires all yields to be resolved before resuming', async () => {
    mockAdapter.setResponses([
      {
        toolCalls: [
          { name: 'get_approval', args: { reason: 'first' } },
          { name: 'get_approval', args: { reason: 'second' } },
        ],
      },
    ])

    const myAgent = testAgent({ tools: [yieldingTool] })
    const session = createTestSession('Multiple')
    const result = await runner.run(myAgent, session)

    if (result.status !== 'yielded_tool') return

    session.input.tool({
      callId: result.yieldedTools[0].callId,
      input: { approved: true },
    })
    expect(session.status).toBe('awaiting_input')
    expect(session.yieldedTools).toHaveLength(1)

    session.input.tool({
      callId: result.yieldedTools[1].callId,
      input: { approved: true },
    })
    expect(session.yieldedTools).toHaveLength(0)
  })
})
