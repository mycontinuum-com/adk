/**
 * Voice Eval Example
 *
 * Evaluates the support voice agent by having a simulated user call in and ask about an order,
 * measuring response timing.
 *
 * Prerequisites: npm install @livekit/agents @livekit/rtc-node livekit-server-sdk
 *
 * Environment (see .env.voice): OPENAI_API_KEY - OpenAI API key LIVEKIT_URL - LiveKit server URL
 * LIVEKIT_API_KEY - LiveKit API key LIVEKIT_API_SECRET - LiveKit API secret
 *
 * Run: pnpm exec tsx examples/voice-eval.ts list pnpm exec tsx examples/voice-eval.ts run --case
 * text/smoke pnpm exec tsx examples/voice-eval.ts run
 */

import dotenv from 'dotenv'

dotenv.config({ path: `${__dirname}/.env.voice`, quiet: true })

import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { voiceTimingMetric } from '@animahealth/adk/eval'
import type { VoiceEvalCase } from '@animahealth/adk/eval'
import { openai } from '@animahealth/adk/openai'

const app = adk()

// ── Agent under test ────────────────────────────────────────────────

const lookupOrder = app.tool({
  name: 'lookupOrder',
  description: 'Look up an order by its ID and return its status',
  schema: z.object({
    orderId: z.string().describe('The order ID to look up'),
  }),
  execute: async (ctx) => ({
    orderId: ctx.args.orderId,
    status: 'shipped',
    estimatedDelivery: '2026-03-10',
  }),
})

const endCall = app.tool({
  name: 'endCall',
  description: 'End the call. Collect a summary of the conversation.',
  schema: z.object({
    summary: z.string().describe('Brief summary of the call'),
    resolved: z.boolean().describe('Whether the caller issue was resolved'),
  }),
  execute: async (ctx) => {
    return ctx.end()
  },
})

const agent = app.agent({
  name: 'support',
  model: openai.realtime('gpt-realtime-2025-08-28', { voice: 'ballad' }),
  context: [
    app.context.system(`You are a friendly customer support agent. Always speak English.
You help callers check on their orders and answer questions.
Start by greeting the caller warmly and asking how you can help.
When the conversation is complete, use the end_call tool.`),
    app.context.history(),
  ],
  tools: [lookupOrder],
  output: endCall,
})

// ── Simulated users ─────────────────────────────────────────────────

const orderCaller = app.agent({
  name: 'order-caller',
  model: openai.realtime('gpt-realtime-2025-08-28', { voice: 'shimmer' }),
  context: [
    app.context.system(`You are a customer calling support. Always speak English.
Your goal: check the status of order #12345.
Be natural and conversational. When you get the answer, say thanks and goodbye.`),
  ],
  tools: [],
})

const confusedCaller = app.agent({
  name: 'confused-caller',
  model: openai.realtime('gpt-realtime-2025-08-28', { voice: 'shimmer' }),
  context: [
    app.context.system(`You are a confused customer calling support. Always speak English.
You don't remember your order number. You think it might start with "99" but you're not sure.
Ask the agent for help figuring it out. Be a little rambly and unsure.
If the agent can't find it, accept that and say goodbye.`),
  ],
  tools: [],
})

const impatientCaller = app.agent({
  name: 'impatient-caller',
  model: openai.realtime('gpt-realtime-2025-08-28', { voice: 'ash' }),
  context: [
    app.context.system(`You are an impatient customer calling support. Always speak English.
You want to know where order #67890 is. You're frustrated because it's late.
Be short and direct. If the agent gives you an answer, grudgingly accept it and hang up.`),
  ],
  tools: [],
})

// ── Eval cases ──────────────────────────────────────────────────────

const cases: VoiceEvalCase[] = [
  {
    name: 'order-lookup-happy-path',
    description: 'User asks about order status, agent looks it up and resolves',
    agent,
    userAgent: orderCaller,
    timeout: 120_000,
    toolMocks: {
      lookupOrder: {
        execute: async () => ({
          orderId: '12345',
          status: 'shipped',
          estimatedDelivery: '2026-03-10',
        }),
      },
      endCall,
    },
    metrics: [
      {
        name: 'used_lookup_tool',
        evaluate: (run) => ({
          passed: run.events.some((e) => e.type === 'tool_call' && e.name === 'lookupOrder'),
          evidence: ['Agent should call lookupOrder for the order'],
        }),
      },
      {
        name: 'min_turns',
        evaluate: (run) => ({
          passed: run.transcript.length >= 3,
          evidence: [`${run.transcript.length} transcript entries`],
        }),
      },
    ],
  },
  {
    name: 'confused-caller-no-order-id',
    description: 'Caller does not know their order number, agent handles gracefully',
    agent,
    userAgent: confusedCaller,
    timeout: 300_000,
    toolMocks: {
      lookupOrder: {
        execute: async () => ({ error: 'Order not found' }),
      },
      endCall,
    },
    metrics: [
      {
        name: 'min_turns',
        evaluate: (run) => ({
          passed: run.transcript.length >= 4,
          evidence: [`${run.transcript.length} transcript entries`],
        }),
      },
    ],
  },
  {
    name: 'impatient-caller-late-order',
    description: 'Frustrated caller asks about a late order, agent de-escalates',
    agent,
    userAgent: impatientCaller,
    timeout: 120_000,
    toolMocks: {
      lookupOrder: {
        execute: async () => ({
          orderId: '67890',
          status: 'delayed',
          estimatedDelivery: '2026-03-15',
        }),
      },
      endCall,
    },
    metrics: [
      {
        name: 'used_lookup_tool',
        evaluate: (run) => ({
          passed: run.events.some((e) => e.type === 'tool_call' && e.name === 'lookupOrder'),
          evidence: ['Agent should look up the order'],
        }),
      },
      {
        name: 'min_turns',
        evaluate: (run) => ({
          passed: run.transcript.length >= 3,
          evidence: [`${run.transcript.length} transcript entries`],
        }),
      },
    ],
  },
]

const textCase = app.evaluate.case({
  name: 'text/smoke',
  description: 'Check the text execution path without a model call',
  runnable: app.step({
    name: 'smoke',
    execute: (ctx) => ctx.output('Text evaluation is working'),
  }),
  metrics: [
    {
      name: 'recorded_events',
      evaluate: (run) => ({ passed: run.session.events.length > 0 }),
    },
  ],
})

async function main() {
  process.exitCode = await app.evaluate.cli([textCase, ...cases], {
    concurrency: 4,
    voice: {
      hooks: [
        {
          onEnter: async (ctx) => {
            const reply = await ctx.voice.generateReply({ toolChoice: 'none' })
            await reply.waitForPlayout()
          },
        },
      ],
      metrics: [
        voiceTimingMetric({
          name: 'response_latency_p95',
          measure: 'response_latency_p95',
          assertion: (ms) => ms < 3000,
        }),
        voiceTimingMetric({
          name: 'time_to_first_speech',
          measure: 'time_to_first_speech',
          assertion: (ms) => ms < 2000,
        }),
      ],
    },
  })
}

void main()
