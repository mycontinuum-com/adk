import { z } from 'zod'

import type { ToolResultEvent } from '../types'

import { adk } from '../api'
import { signalOutput, isOutputSignal, isControlSignal, CONTROL } from '../core/tools'
import { runTest, user, model, testAgent, setupAdkMatchers } from '../testing'

await setupAdkMatchers()
const app = adk()

describe('OutputSignal primitive', () => {
  test('signalOutput creates an OutputSignal', () => {
    const signal = signalOutput({ key: 'val' })
    expect(signal[CONTROL]).toBe('output')
    expect(signal.value).toEqual({ key: 'val' })
  })

  test('isOutputSignal identifies OutputSignal', () => {
    const signal = signalOutput(42)
    expect(isOutputSignal(signal)).toBe(true)
    expect(isControlSignal(signal)).toBe(true)
  })

  test('isOutputSignal rejects non-signals', () => {
    expect(isOutputSignal(null)).toBe(false)
    expect(isOutputSignal(undefined)).toBe(false)
    expect(isOutputSignal({ value: 42 })).toBe(false)
    expect(isOutputSignal('hello')).toBe(false)
  })

  test('signalOutput preserves undefined value', () => {
    const signal = signalOutput(undefined)
    expect(isOutputSignal(signal)).toBe(true)
    expect(signal.value).toBeUndefined()
  })
})

describe('ctx.output() in tool execution', () => {
  test('tool returning ctx.output() completes agent with output value', async () => {
    const outputTool = app.tool({
      name: 'finish',
      description: 'Finish with output',
      schema: z.object({ result: z.string() }),
      execute: (ctx) => ctx.output({ answer: ctx.args.result }),
    })

    const { status, output } = await runTest(testAgent({ tools: [outputTool] }), [
      user('Finish it'),
      model({ toolCalls: [{ name: 'finish', args: { result: 'done' } }] }),
    ])

    expect(status).toBe('completed')
    expect(output).toEqual({ answer: 'done' })
  })

  test('ctx.output() sets output flag on ToolResultEvent', async () => {
    const outputTool = app.tool({
      name: 'finish',
      description: 'Finish with output',
      schema: z.object({}),
      execute: (ctx) => ctx.output({ key: 'val' }),
    })

    const { events } = await runTest(testAgent({ tools: [outputTool] }), [
      user('Go'),
      model({ toolCalls: [{ name: 'finish', args: {} }] }),
    ])

    const toolResults = [...events].filter((e): e is ToolResultEvent => e.type === 'tool_result')
    const outputResult = toolResults.find((r) => r.name === 'finish')
    expect(outputResult).toBeDefined()
    expect(outputResult!.output).toBe(true)
    expect(outputResult!.result).toEqual({ key: 'val' })
  })

  test('ctx.output() takes priority over model assistant text', async () => {
    const outputTool = app.tool({
      name: 'finish',
      description: 'Finish with output',
      schema: z.object({}),
      execute: (ctx) => ctx.output({ explicit: true }),
    })

    const { output, result } = await runTest(testAgent({ tools: [outputTool] }), [
      user('Go'),
      model({ toolCalls: [{ name: 'finish', args: {} }] }),
    ])

    expect(output).toEqual({ explicit: true })
    expect(result.output.value).toEqual({ explicit: true })
  })

  test('agent without ctx.output() behaves as before', async () => {
    const normalTool = app.tool({
      name: 'greet',
      description: 'Greet',
      schema: z.object({ name: z.string() }),
      execute: (ctx) => ({ greeting: `Hello ${ctx.args.name}` }),
    })

    const { status, events } = await runTest(testAgent({ tools: [normalTool] }), [
      user('Greet Alice'),
      model({ toolCalls: [{ name: 'greet', args: { name: 'Alice' } }] }),
      model({ text: 'Hello Alice!' }),
    ])

    expect(status).toBe('completed')
    expect(events).toHaveAssistantText('Hello Alice!')

    const toolResults = [...events].filter((e): e is ToolResultEvent => e.type === 'tool_result')
    const greetResult = toolResults.find((r) => r.name === 'greet')
    expect(greetResult?.output).toBeUndefined()
  })

  test('ctx.output() with complex object value', async () => {
    const outputTool = app.tool({
      name: 'analyze',
      description: 'Analyze',
      schema: z.object({}),
      execute: (ctx) =>
        ctx.output({
          scores: [1, 2, 3],
          metadata: { model: 'gpt-4', confidence: 0.95 },
        }),
    })

    const { output } = await runTest(testAgent({ tools: [outputTool] }), [
      user('Analyze'),
      model({ toolCalls: [{ name: 'analyze', args: {} }] }),
    ])

    expect(output).toEqual({
      scores: [1, 2, 3],
      metadata: { model: 'gpt-4', confidence: 0.95 },
    })
  })
})

describe('ctx.output() in step execution', () => {
  test('step calling ctx.output() sets result output value', async () => {
    const outputStep = app.step({
      name: 'compute',
      execute: (ctx) => {
        ctx.output({ computed: 42 })
      },
    })

    const { status, output } = await runTest(outputStep, [])

    expect(status).toBe('completed')
    expect(output).toEqual({ computed: 42 })
  })

  test('step without ctx.output() has undefined output value', async () => {
    const plainStep = app.step({
      name: 'noop',
      execute: () => {},
    })

    const { status, output } = await runTest(plainStep, [])

    expect(status).toBe('completed')
    expect(output).toBeUndefined()
  })
})

describe('agent config passthrough', () => {
  test('yields field passes through agent factory', () => {
    const myAgent = app.agent({
      name: 'yielding',
      model: { provider: 'openai', name: 'gpt-4o' },
      context: [],
      yields: true,
      maxTurns: 5,
    })

    expect(myAgent.yields).toBe(true)
    expect(myAgent.maxTurns).toBe(5)
  })

  test('timeouts field passes through agent factory', () => {
    const myAgent = app.agent({
      name: 'timed',
      model: { provider: 'openai', name: 'gpt-4o' },
      context: [],
      timeouts: { inactivity: 30000, maxDuration: 300000 },
    })

    expect(myAgent.timeouts).toEqual({
      inactivity: 30000,
      maxDuration: 300000,
    })
  })
})
