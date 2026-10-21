import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, test } from 'vitest'
import { z } from 'zod'

import type { ModelStartEvent } from '../types/events'
import type { ModelCallSource } from './model-calls'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'
import { installModelCallContext, observeModelCalls } from './model-calls'

installModelCallContext(new AsyncLocalStorage())

const questions = { urgent: { type: 'predicate', instructions: 'Is it urgent?' } } as const

function fixture() {
  const adapter = new MockAdapter({
    responses: [{ toolCalls: [{ name: 'check', args: {} }] }, { text: 'Done' }],
    decisions: { urgent: { type: 'predicate', probability: 0.1 } },
  })
  const app = adk({ adapters: { openai: adapter }, defaultModel: openai('gpt-4o-mini') })
  const agent = app.agent({
    name: 'backend',
    model: openai('gpt-4o-mini'),
    context: [app.context.history()],
    tools: [
      app.tool({
        name: 'check',
        description: 'Asks a decision from inside a run',
        schema: z.object({}),
        async execute() {
          await app.decide('From a tool', { questions })
          return 'checked'
        },
      }),
    ],
  })
  return { app, agent }
}

function recorder() {
  const seen: Array<[type: string, agentName: string, source: ModelCallSource]> = []
  return {
    seen,
    observe: (event: { type: string; agentName: string }, source: ModelCallSource) =>
      seen.push([event.type, event.agentName, source]),
  }
}

test('observes the model calls of runs and decisions started in scope, nested ones included', async () => {
  const { app, agent } = fixture()
  const { seen, observe } = recorder()
  await observeModelCalls(observe, async () => {
    await app.run(agent, { input: 'Hello' })
    await app.decide('From a hook', { questions })
  })
  expect(seen).toEqual([
    ['model_start', 'backend', 'run'],
    ['model_end', 'backend', 'run'],
    ['model_start', 'decide', 'decision'],
    ['model_end', 'decide', 'decision'],
    ['model_start', 'backend', 'run'],
    ['model_end', 'backend', 'run'],
    ['model_start', 'decide', 'decision'],
    ['model_end', 'decide', 'decision'],
  ])
})

test('records each call once when the scope is entered again, and nothing outside it', async () => {
  const { app } = fixture()
  const { seen, observe } = recorder()
  await app.decide('Before', { questions })
  await observeModelCalls(observe, () =>
    observeModelCalls(observe, () => app.decide('Inside', { questions })),
  )
  await app.decide('After', { questions })
  expect(seen).toEqual([
    ['model_start', 'decide', 'decision'],
    ['model_end', 'decide', 'decision'],
  ])
})

test('a decision records the model it asked and an estimate of its input', async () => {
  const { app } = fixture()
  const starts: NonNullable<ModelStartEvent['estimatedInput']>[] = []
  await observeModelCalls(
    (event) => {
      if (event.type === 'model_start' && event.estimatedInput) starts.push(event.estimatedInput)
    },
    () => app.decide('x'.repeat(400), { questions }),
  )
  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ provider: 'openai', modelName: 'gpt-4o-mini' })
  expect(starts[0]!.inputTokens).toBeGreaterThanOrEqual(100)
})
