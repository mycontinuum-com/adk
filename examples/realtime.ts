/**
 * Realtime Text-Mode Example
 *
 * Demonstrates realtime (voice-capable) agents with different providers:
 *
 * - OpenAI: gpt-realtime-1.5 (requires OPENAI_API_KEY)
 * - Gemini: gemini-2.5-flash-native-audio via Google AI (requires GEMINI_API_KEY)
 * - Gemini: gemini-live-2.5-flash-native-audio via Vertex AI (requires gcloud auth)
 *
 * Run: npx tsx examples/realtime.ts
 */

import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { gemini } from '@animahealth/adk/gemini'
import { openai } from '@animahealth/adk/openai'

type Provider = 'openai' | 'gemini' | 'gemini-vertex'

const PROVIDER: Provider = 'gemini'

const VERTEX_PROJECT = 'your-gcp-project'
const VERTEX_LOCATION = 'europe-west1'

function getModel(provider: Provider) {
  switch (provider) {
    case 'openai':
      return openai.realtime('gpt-realtime-1.5')

    case 'gemini':
      return gemini.realtime('gemini-2.5-flash-native-audio-preview-12-2025')

    case 'gemini-vertex':
      return gemini.realtime('gemini-live-2.5-flash-native-audio', {
        vertex: {
          project: VERTEX_PROJECT,
          location: VERTEX_LOCATION,
        },
      })
  }
}

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

const assistant = app.agent({
  name: 'realtime_assistant',
  model: getModel(PROVIDER),
  context: [
    app.context.system(`You are a helpful assistant named Andy.
You can help with calculations using the calculate tool.
Start by saying: "Hi, I'm Andy. How can I help you today?"`),
    app.context.history(),
  ],
  tools: [calculate],
})

app.cli(assistant)
