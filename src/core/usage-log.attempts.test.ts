import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { ErrorHandler } from '../errors/types'
import type { MockResponseConfig } from '../testing/runTest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { configurePricing } from '../providers/pricing'
import { useTestPricing } from '../test-support/pricing-registry'
import { UsageReportingAdapter } from '../test-support/usage-adapter'
import { configureUsageLog } from './usage-log'

/** The input estimated for `Hello` and the `look` tool's schema, at about four characters a token. */
const ESTIMATED_INPUT = 33

let lines: Array<Record<string, unknown>> = []

beforeEach(async () => {
  await useTestPricing()
  lines = []
  configureUsageLog({ write: (line) => lines.push(JSON.parse(line)) })
})

afterEach(() => {
  configureUsageLog(false)
  configurePricing(false)
})

/** The usage fields of each line written, in order. */
function written() {
  return lines.map(({ operation, inputTokens, outputTokens, usageBasis, costUsd, costBasis }) => ({
    operation,
    inputTokens,
    outputTokens,
    usageBasis,
    costUsd,
    costBasis,
  }))
}

/**
 * An agent on an adapter that reports 1M gpt-4o-mini input tokens a step, priced at $0.15, that
 * retries a failed model call unless `errorHandlers` replaces that, and with `escalateAfterModel`
 * hands the run to an `escalation` agent after each model call.
 */
function agentAnswering(
  responses: MockResponseConfig[],
  options: { maxSteps?: number; escalateAfterModel?: boolean; errorHandlers?: ErrorHandler[] } = {},
) {
  const adapter = new UsageReportingAdapter()
  adapter.addResponses('agent:backend', responses)
  adapter.addResponses('agent:escalation', [{ text: 'Escalated' }])
  const app = adk({ adapters: { openai: adapter } })
  const escalation = app.agent({
    name: 'escalation',
    model: openai('gpt-4o-mini'),
    context: [app.context.history()],
  })
  const agent = app.agent({
    name: 'backend',
    model: openai('gpt-4o-mini'),
    context: [app.context.history()],
    tools: [
      app.tool({ name: 'look', description: 'Looks', schema: z.object({}), execute: () => 'seen' }),
    ],
    maxSteps: options.maxSteps,
    hooks: options.escalateAfterModel ? [{ afterModel: () => escalation }] : [],
    errorHandlers: options.errorHandlers ?? [
      { handle: (ctx) => (ctx.phase === 'model' ? { action: 'retry' } : { action: 'pass' }) },
    ],
  })
  return { app, agent }
}

const PRICED_STEP = {
  operation: 'backend',
  inputTokens: 1_000_000,
  outputTokens: 0,
  usageBasis: 'reported',
  costUsd: 0.15,
  costBasis: 'reported',
}

test(
  'a model call cut off by the run timeout writes a line at its estimated input',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { app, agent } = agentAnswering([{ delayMs: 10_000 }])

    await expect(app.run(agent, { input: 'Hello', timeout: 50 })).rejects.toThrow(
      'Timeout after 50ms',
    )

    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(written()).toEqual([
      {
        operation: 'backend',
        inputTokens: ESTIMATED_INPUT,
        outputTokens: 0,
        usageBasis: 'estimated',
        costUsd: 4.95e-6,
        costBasis: 'estimated',
      },
    ])
  },
)

test(
  'an attempt answered with an error status writes a line that spent nothing, and the retry its own',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const rateLimited = Object.assign(new Error('Rate limited'), { status: 429 })
    const { app, agent } = agentAnswering([{ error: rateLimited }, { text: 'Done' }])

    const result = await app.run(agent, { input: 'Hello' })

    expect(written()).toEqual([
      {
        operation: 'backend',
        inputTokens: 0,
        outputTokens: 0,
        usageBasis: 'reported',
        costUsd: 0,
        costBasis: 'reported',
      },
      PRICED_STEP,
    ])
    expect(result.usage?.modelCalls).toBe(2)
  },
)

test(
  'an attempt that failed without an answer writes a line at its estimated input',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { app, agent } = agentAnswering([
      { error: new Error('socket hang up') },
      { text: 'Done' },
    ])

    const result = await app.run(agent, { input: 'Hello' })

    expect(written()).toEqual([
      {
        operation: 'backend',
        inputTokens: ESTIMATED_INPUT,
        outputTokens: 0,
        usageBasis: 'estimated',
        costUsd: 4.95e-6,
        costBasis: 'estimated',
      },
      PRICED_STEP,
    ])
    expect(result.usage?.modelCalls).toBe(2)
  },
)

test(
  'the model call a step limit stops at still writes its line',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { app, agent } = agentAnswering([{ toolCalls: [{ name: 'look', args: {} }] }], {
      maxSteps: 1,
    })

    const result = await app.run(agent, { input: 'Hello' })

    expect(result.status).toBe('max_steps')
    expect(written()).toEqual([PRICED_STEP])
    expect(result.usage?.modelCalls).toBe(1)
  },
)

test(
  'a model call whose afterModel hook hands the run to another agent still writes its line',
  { meta: { fixture: 'agent-kit.usage-line' } },
  async () => {
    const { app, agent } = agentAnswering([{ text: 'Unsure' }], { escalateAfterModel: true })

    await app.run(agent, { input: 'Hello' })

    expect(written()).toEqual([PRICED_STEP, { ...PRICED_STEP, operation: 'escalation' }])
  },
)

test(
  'a failed attempt writes its line before an error handler runs, so a handler that throws cannot lose it',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { app, agent } = agentAnswering([{ error: new Error('socket hang up') }], {
      errorHandlers: [
        {
          handle: () => {
            throw new Error('The error handler failed')
          },
        },
      ],
    })

    await expect(app.run(agent, { input: 'Hello' })).rejects.toThrow('The error handler failed')

    expect(written()).toEqual([
      {
        operation: 'backend',
        inputTokens: ESTIMATED_INPUT,
        outputTokens: 0,
        usageBasis: 'estimated',
        costUsd: 4.95e-6,
        costBasis: 'estimated',
      },
    ])
  },
)
