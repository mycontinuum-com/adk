/**
 * Interactive Chat Assistant (Vertex AI / Gemini)
 *
 * A conversational assistant with tools, demonstrating the loop primitive for multi-turn
 * conversations.
 *
 * Run: npx tsx examples/assistant-vertex.ts
 */

import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { gemini } from '@animahealth/adk/gemini'

const app = adk()

const calculate = app.tool({
  name: 'calculate',
  description: 'Evaluate a mathematical expression',
  schema: z.object({
    expression: z.string().describe('The math expression to evaluate'),
  }),
  execute: (ctx) => {
    try {
      const result = Function(`"use strict"; return (${ctx.args.expression})`)()
      return { result }
    } catch {
      return { error: 'Invalid expression' }
    }
  },
})

const getCurrentTime = app.tool({
  name: 'get_current_time',
  description: 'Get the current date and time',
  schema: z.object({}),
  execute: () => {
    return {
      timestamp: new Date().toISOString(),
      readable: new Date().toLocaleString('en-GB', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    }
  },
})

const assistant = app.agent({
  name: 'assistant',
  model: gemini('gemini-2.0-flash', {
    vertex: {
      project: 'your-gcp-project',
      location: 'europe-west1',
    },
  }),
  context: [
    app.context.system(`You are a friendly and helpful AI assistant for Anima.

Your capabilities:
- Answer questions on any topic
- Help with calculations using the calculate tool
- Tell the current time using the get_current_time tool
- Remember context from earlier in the conversation

Be concise but thorough. Use tools when they would help answer the question.
Say "goodbye" to end the conversation.`),
    app.context.history(),
  ],
  tools: [calculate, getCurrentTime],
})

const EXIT_PHRASES = ['goodbye', 'exit', 'quit', 'bye']

const chat = app.loop({
  name: 'chat',
  runnable: assistant,
  maxIterations: 100,
  yields: true,
  while: (ctx) => {
    const lastUser = [...ctx.session.events].toReversed().find((e) => e.type === 'user')

    if (lastUser?.type === 'user') {
      const text = lastUser.text.toLowerCase()
      if (EXIT_PHRASES.some((phrase) => text.includes(phrase))) {
        return false
      }
    }

    return true
  },
})

app.cli(chat)
