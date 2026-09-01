import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk()

const calculator = app.tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  schema: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: (ctx) => {
    const sanitized = ctx.args.expression.replace(/[^\d\s+\-*/().eE%]/g, '')
    const result = Function(`"use strict"; return (${sanitized})`)()
    return { result }
  },
})

const assistant = app.agent({
  name: 'math_assistant',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(`You are helpful, use the calculator tool for arithmetic.`),
    app.context.history(),
  ],
  tools: [calculator],
})

async function main() {
  const result = await app.run(assistant, 'What is 134 divided by 4?')
  console.log(result.output.text)
}

main().catch(console.error)
