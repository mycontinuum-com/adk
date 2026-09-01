/**
 * Voice Agent Example
 *
 * Demonstrates a LiveKit-powered voice agent with:
 *
 * - Output tool for structured session completion
 * - Lifecycle hooks for inactivity, expiry, and disconnect
 * - Multi-stage inactivity escalation
 *
 * Prerequisites: npm install @livekit/agents @livekit/agents-plugin-openai
 *
 * Environment: OPENAI_API_KEY - OpenAI API key LIVEKIT_URL - LiveKit server URL LIVEKIT_API_KEY -
 * LiveKit API key LIVEKIT_API_SECRET - LiveKit API secret
 *
 * Run: npx tsx examples/voice.ts dev
 */

import dotenv from 'dotenv'

dotenv.config({ path: `${__dirname}/.env.voice` })

import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk()

const lookupOrder = app.tool({
  name: 'lookupOrder',
  description: 'Look up an order by its ID and return its status',
  schema: z.object({
    orderId: z.string().describe('The order ID to look up'),
  }),
  execute: async (ctx) => {
    return {
      orderId: ctx.args.orderId,
      status: 'shipped',
      estimatedDelivery: '2026-03-02',
    }
  },
})

const endCall = app.tool({
  name: 'end_call',
  description: 'End the call. Collect a summary of the conversation.',
  schema: z.object({
    summary: z.string().describe('Brief summary of the call'),
    resolved: z.boolean().describe('Whether the caller issue was resolved'),
  }),
  execute: async (ctx) => {
    return { summary: ctx.args.summary, resolved: ctx.args.resolved }
  },
})

const agent = app.agent({
  name: 'support',
  model: openai.realtime('gpt-realtime-1.5', { voice: 'ballad' }),
  // model: gemini.realtime('gemini-live-2.5-flash-native-audio', {
  //   vertex: {
  //     project: 'your-gcp-project',
  //     location: 'europe-west1',
  //   },
  // }),
  context: [
    app.context.system(`You are a friendly customer support agent.
You help callers check on their orders and answer questions.
Start by greeting the caller warmly and asking how you can help.
When the conversation is complete, use the ${endCall.name} tool.`),
    app.context.history(),
  ],
  tools: [lookupOrder],
  output: endCall,
  timeouts: {
    inactivity: 15_000,
    expiry: 300_000,
  },
})

const terminationHooks = app.hook.voice({
  onInactivity: async (ctx) => {
    const prompts = [
      'Gently ask if the caller is still there.',
      'Remind them you are available to help.',
      'Let them know you will need to end the call shortly.',
    ]

    if (ctx.inactivityCount < prompts.length) {
      const reply = await ctx.voice.generateReply({
        instructions: prompts[ctx.inactivityCount],
      })
      await reply.waitForPlayout()
      return false
    }
  },

  onExpiry: async (ctx) => {
    const reply = await ctx.voice.generateReply({
      instructions: 'You have reached the time limit. Apologise briefly, then end the call',
    })
    await reply.waitForPlayout()
  },
})

const handler = app.handler.voice({
  name: 'support-curie',
  agent,
  sound: {
    noiseCancellation: 'general',
  },
  hooks: [app.hook.voiceLogging({ level: 'debug' }), terminationHooks],
})

export default handler
handler.start(__filename)
