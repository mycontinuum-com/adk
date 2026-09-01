/**
 * Reusable Specs Example
 *
 * Demonstrates creating reusable tools and agents with the spec API. Specs can be shared across
 * multiple apps with compatible schemas.
 *
 * Run: npx tsx examples/spec.ts
 */

import { z } from 'zod'

import { adk, spec } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const calculator = spec.tool()({
  name: 'calculate',
  description: 'Evaluate a math expression',
  schema: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: (ctx) => {
    const result = Function(`"use strict"; return (${ctx.args.expression})`)()
    return { result }
  },
})

const Assistant = spec.agent()((app) => ({
  name: 'assistant',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system('You are a helpful assistant with a calculator.'),
    app.context.history(),
  ],
  tools: [app.use(calculator)],
}))

const app = adk()

const assistant = app.use(Assistant)

const chat = app.loop({
  name: 'chat',
  runnable: assistant,
  maxIterations: 100,
  yields: true,
  while: () => true,
})

app.cli(chat)
