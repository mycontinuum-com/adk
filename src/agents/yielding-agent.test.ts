import { z } from 'zod'

import type { InvocationYieldEvent } from '../types'

import { adk } from '../api'
import { runTest, user, model, testAgent, setupAdkMatchers } from '../testing'

await setupAdkMatchers()
const app = adk()

describe('Yielding agents (agent.yields = true)', () => {
  test('agent with yields: true yields on terminal model output', async () => {
    const { status, result } = await runTest(testAgent({ yields: true }), [
      user('Hello'),
      model({ text: 'Hi there!' }),
    ])

    expect(status).toBe('yielded_message')
    expect(result.status).toBe('yielded_message')
    if (result.status === 'yielded_message') {
      expect(result.yieldedInvocationId).toBeDefined()
    }
  })

  test('agent without yields completes normally on terminal output', async () => {
    const { status } = await runTest(testAgent(), [user('Hello'), model({ text: 'Hi there!' })])

    expect(status).toBe('completed')
  })

  test('yields: false explicitly disables yielding', async () => {
    const { status } = await runTest(testAgent({ yields: false }), [
      user('Hello'),
      model({ text: 'Done.' }),
    ])

    expect(status).toBe('completed')
  })

  test('yielded agent can be resumed with new user message', async () => {
    const { status, events } = await runTest(testAgent({ yields: true }), [
      user('Hello'),
      model({ text: 'Hi there!' }),
      user('How are you?'),
      model({ text: 'I am fine.' }),
    ])

    // After providing a second user message, the agent yields again
    expect(status).toBe('yielded_message')
    expect(events).toHaveAssistantText('I am fine.')
  })

  test('multi-turn yielding conversation', async () => {
    const { status, events } = await runTest(testAgent({ yields: true }), [
      user('Turn 1'),
      model({ text: 'Response 1' }),
      user('Turn 2'),
      model({ text: 'Response 2' }),
      user('Turn 3'),
      model({ text: 'Response 3' }),
    ])

    expect(status).toBe('yielded_message')
    expect(events).toHaveAssistantText('Response 3')
  })

  test('invocation_yield event has awaitingInput: true for message yields', async () => {
    const { events } = await runTest(testAgent({ yields: true }), [
      user('Hello'),
      model({ text: 'Hi there!' }),
    ])

    const yieldEvents = [...events].filter(
      (e): e is InvocationYieldEvent => e.type === 'invocation_yield',
    )
    expect(yieldEvents.length).toBeGreaterThan(0)
    expect(yieldEvents[0]!.awaitingInput).toBe(true)
    expect(yieldEvents[0]!.yieldedToolIds).toEqual([])
  })

  test('when no more user messages are available, loop breaks', async () => {
    // Only one user message provided, agent yields after first response
    // but there's no second message, so runTest breaks out of the loop
    const { status } = await runTest(testAgent({ yields: true }), [
      user('Hello'),
      model({ text: 'Hi!' }),
    ])

    expect(status).toBe('yielded_message')
  })
})

describe('ctx.output() overrides yields', () => {
  test('tool returning ctx.output() completes even when yields is true', async () => {
    const finishTool = app.tool({
      name: 'finish',
      description: 'Finish with output',
      schema: z.object({ result: z.string() }),
      execute: (ctx) => ctx.output({ answer: ctx.args.result }),
    })

    const { status, output } = await runTest(testAgent({ yields: true, tools: [finishTool] }), [
      user('Finish it'),
      model({ toolCalls: [{ name: 'finish', args: { result: 'done' } }] }),
    ])

    expect(status).toBe('completed')
    expect(output).toEqual({ answer: 'done' })
  })
})

describe('maxTurns enforcement', () => {
  test('maxTurns: 1 allows one turn then returns max_turns', async () => {
    const { status } = await runTest(testAgent({ yields: true, maxTurns: 1 }), [
      user('Turn 1'),
      model({ text: 'Response 1' }),
      // First turn yields, resume happens, but maxTurns is hit
      user('Turn 2'),
      model({ text: 'Response 2' }),
    ])

    expect(status).toBe('max_turns')
  })

  test('maxTurns: 2 allows two turns then returns max_turns', async () => {
    const { status, events } = await runTest(testAgent({ yields: true, maxTurns: 2 }), [
      user('Turn 1'),
      model({ text: 'Response 1' }),
      user('Turn 2'),
      model({ text: 'Response 2' }),
      user('Turn 3'),
      model({ text: 'Response 3' }),
    ])

    expect(status).toBe('max_turns')
    // Should have processed turn 1 and turn 2 but not turn 3
    expect(events).toHaveAssistantText('Response 2')
  })

  test('maxTurns without yields has no effect', async () => {
    // yields is not set (defaults to false), so maxTurns is irrelevant
    const { status } = await runTest(testAgent({ maxTurns: 1 }), [
      user('Hello'),
      model({ text: 'Done.' }),
    ])

    expect(status).toBe('completed')
  })

  test('default maxTurns is 100', async () => {
    // Just verify the agent doesn't immediately hit max_turns
    const { status } = await runTest(testAgent({ yields: true }), [
      user('Hello'),
      model({ text: 'Hi' }),
    ])

    expect(status).toBe('yielded_message')
  })
})

describe('yielding with tool calls', () => {
  test('non-terminal model step with tool calls proceeds normally', async () => {
    const greetTool = app.tool({
      name: 'greet',
      description: 'Greet',
      schema: z.object({ name: z.string() }),
      execute: (ctx) => ({ greeting: `Hello ${ctx.args.name}` }),
    })

    const { status, events } = await runTest(testAgent({ yields: true, tools: [greetTool] }), [
      user('Greet Alice'),
      model({ toolCalls: [{ name: 'greet', args: { name: 'Alice' } }] }),
      model({ text: 'Greeted Alice!' }),
    ])

    // After tool call completes, the terminal text output causes a yield
    expect(status).toBe('yielded_message')
    expect(events).toHaveAssistantText('Greeted Alice!')
  })
})
