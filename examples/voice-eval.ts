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
 * Run: npx tsx examples/voice-eval.ts
 */

import dotenv from 'dotenv'

dotenv.config({ path: `${__dirname}/.env.voice` })

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

// ── Run ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting voice evaluation...\n')
  const outputDir = `${__dirname}/voice-eval-results`
  const repeat = 1
  console.log(`Writing results to ${outputDir}\n`)
  for (const c of cases) {
    console.log(`* ${c.name}`)
  }
  console.log('')
  process.stdout.write(`  ${'░'.repeat(20)} 0% (0/${cases.length * repeat})`)

  const result = await app.evaluate.voice(cases, {
    output: outputDir,
    repeat,
    concurrency: 10,
    hooks: [
      {
        onEnter: async (ctx) => {
          const reply = await ctx.voice.generateReply({ toolChoice: 'none' })
          await reply.waitForPlayout()
        },
      },
    ],
    metrics: [
      // Suite-level: response latency p95 under 3 seconds
      voiceTimingMetric({
        name: 'response_latency_p95',
        measure: 'response_latency_p95',
        assertion: (ms) => ms < 3000,
      }),
      // Suite-level: agent speaks within 2 seconds
      voiceTimingMetric({
        name: 'time_to_first_speech',
        measure: 'time_to_first_speech',
        assertion: (ms) => ms < 2000,
      }),
    ],
    onCase: (caseResult, index, total) => {
      const filled = Math.round((index / total) * 20)
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)
      const pct = Math.round((index / total) * 100)
      const icon = caseResult.status === 'passed' ? '✓' : '✗'
      const dur = (caseResult.durationMs / 1000).toFixed(1)
      process.stdout.write(
        `\r  ${bar} ${pct}% (${index}/${total})  ${icon} ${caseResult.name} ${dur}s`,
      )
      if (index === total) process.stdout.write('\n\n')
    },
  })

  // Print summary
  const report = app.evaluate.report()
  console.log('\n' + report(result))

  // Exit with code based on pass/fail
  process.exit(result.summary.passed === result.summary.total ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
