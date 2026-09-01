import { z } from 'zod'

import type { LoopContext } from '../../types'

import { sequence, loop } from '../../agents'
import { adk } from '../../api'
import { runTest, user, model, input, testAgent, setupAdkMatchers } from '../../testing'

await setupAdkMatchers()
const app = adk()

describe('yield and resume testing', () => {
  const yieldingTool = app.tool({
    name: 'get_approval',
    description: 'Get user approval',
    schema: z.object({ reason: z.string() }),
    yieldSchema: z.object({ approved: z.boolean() }),
    finalize: (ctx) => ctx.input,
  })

  describe('tool yields', () => {
    test('yields when tool requires approval (without resume)', async () => {
      const { result } = await runTest(testAgent({ tools: [yieldingTool] }), [
        user('I need approval'),
        model({
          toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }],
        }),
      ])

      expect(result.status).toBe('yielded_tool')
      if (result.status === 'yielded_tool') {
        expect(result.yieldedTools).toHaveLength(1)
        expect(result.yieldedTools[0].name).toBe('get_approval')
      }
    })

    test('resumes after providing tool result', async () => {
      const { events, status } = await runTest(testAgent({ tools: [yieldingTool] }), [
        user('I need approval'),
        model({
          toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }],
        }),
        input({ get_approval: { approved: true } }),
        model({ text: 'Approval granted!' }),
      ])

      expect(events).toHaveAssistantText(/granted/)
      expect(status).toBe('completed')
    })

    test('yields with multiple pending calls', async () => {
      const { result } = await runTest(testAgent({ tools: [yieldingTool] }), [
        user('Double approval'),
        model({
          toolCalls: [
            { name: 'get_approval', args: { reason: 'first' } },
            { name: 'get_approval', args: { reason: 'second' } },
          ],
        }),
      ])

      expect(result.status).toBe('yielded_tool')
      if (result.status === 'yielded_tool') {
        expect(result.yieldedTools).toHaveLength(2)
      }
    })
  })

  describe('input yields (conversational loops)', () => {
    test('loop yields for input (single turn)', async () => {
      const chatAgent = testAgent({ name: 'chat' })

      const chat = loop({
        name: 'conversation',
        runnable: chatAgent,
        maxIterations: 10,
        yields: true,
        while: () => true,
      })

      const { result } = await runTest(chat, [user('Hello'), model({ text: 'Hi there!' })])

      expect(result.status).toBe('yielded_message')
    })

    test('multi-turn conversation with loop terminates on condition', async () => {
      const chatAgent = testAgent({ name: 'chat' })

      const chat = loop({
        name: 'conversation',
        runnable: chatAgent,
        maxIterations: 10,
        yields: true,
        while: (ctx: LoopContext) => {
          const lastAssistant = [...ctx.session.events]
            .toReversed()
            .find((e) => e.type === 'assistant')
          return !(lastAssistant?.type === 'assistant' && lastAssistant.text.includes('Goodbye'))
        },
      })

      const { events, status } = await runTest(chat, [
        user('Hello'),
        model({ text: 'Hi!' }),
        user('How are you?'),
        model({ text: 'I am well!' }),
        user('Bye'),
        model({ text: 'Goodbye!' }),
      ])

      expect(events).toHaveAssistantText(/Goodbye/)
      expect(status).toBe('completed')
    })
  })

  describe('yield propagation in compositions', () => {
    test('sequence resumes correctly after yield', async () => {
      const yieldingAgent = testAgent({
        name: 'yielding',
        tools: [yieldingTool],
      })
      const normalAgent = testAgent({ name: 'normal' })

      const pipeline = sequence({
        name: 'pipeline',
        runnables: [yieldingAgent, normalAgent],
      })

      const { events, status } = await runTest(pipeline, [
        user('Start'),
        model({
          toolCalls: [{ name: 'get_approval', args: { reason: 'seq' } }],
        }),
        input({ get_approval: { approved: true } }),
        model({ text: 'Step 1 done' }),
        model({ text: 'Step 2 done' }),
      ])

      expect(events).toHaveAssistantText('Step 2 done')
      expect(status).toBe('completed')
    })

    test('verifies yield events are emitted', async () => {
      const { events } = await runTest(testAgent({ tools: [yieldingTool] }), [
        user('Need approval'),
        model({
          toolCalls: [{ name: 'get_approval', args: { reason: 'test' } }],
        }),
      ])

      const yieldEvents = [...events].filter((e) => e.type === 'invocation_yield')
      expect(yieldEvents.length).toBeGreaterThan(0)
    })
  })
})
