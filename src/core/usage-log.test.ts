import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { configurePricing } from '../providers/pricing'
import { useTestPricing } from '../test-support/pricing-registry'
import { UsageReportingAdapter } from '../test-support/usage-adapter'
import { configureUsageLog } from './usage-log'

const ADK_VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version

const questions = { urgent: { type: 'predicate', instructions: 'Is it urgent?' } } as const

afterEach(() => {
  vi.restoreAllMocks()
  configureUsageLog(false)
  configurePricing(false)
})

/** Lines the usage log writes from here on, parsed. */
function captureLines(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = []
  configureUsageLog({ write: (line) => lines.push(JSON.parse(line)) })
  return lines
}

/** An app whose `backend` agent calls `check`, which runs `child` and asks once, then answers. */
function fixture() {
  const adapter = new UsageReportingAdapter({
    decisions: { urgent: { type: 'predicate', probability: 0.1 } },
  })
  adapter.addResponses('agent:backend', [
    { toolCalls: [{ name: 'check', args: {} }] },
    { text: 'Done' },
  ])
  const app = adk({ adapters: { openai: adapter }, defaultModel: openai('gpt-4o-mini') })
  const child = app.agent({
    name: 'child',
    model: openai('gpt-4o-mini'),
    context: [app.context.history()],
  })
  const backend = app.agent({
    name: 'backend',
    model: openai('gpt-4o-mini'),
    context: [app.context.history()],
    tools: [
      app.tool({
        name: 'check',
        description: 'Runs a nested agent and asks a question',
        schema: z.object({}),
        async execute(ctx) {
          await ctx.run(child)
          await app.ask('From a tool')
          return 'checked'
        },
      }),
    ],
  })
  const single = app.agent({
    name: 'single',
    model: openai('gpt-4o-mini'),
    context: [app.context.history()],
  })
  return { app, backend, single }
}

test(
  'a model call writes one provider.usage line with its tokens and its price',
  { meta: { fixture: 'agent-kit.usage-line' } },
  async () => {
    await useTestPricing()
    const lines = captureLines()
    const { app, single } = fixture()

    await app.run(single, { input: 'Hello' })

    expect(lines).toEqual([
      {
        ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        level: 'info',
        component: 'adk',
        event: 'provider.usage',
        operation: 'single',
        invocationId: expect.any(String),
        provider: 'openai',
        model: 'gpt-4o-mini',
        kind: 'tokens',
        inputTokens: 1_000_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        usageBasis: 'reported',
        costUsd: 0.15,
        costBasis: 'reported',
        durationMs: expect.any(Number),
        adkVersion: ADK_VERSION,
      },
    ])
  },
)

test(
  'a nested run and an ask inside a tool write one line per model call, and decide writes one',
  { meta: { fixture: 'agent-kit.usage-line' } },
  async () => {
    const lines = captureLines()
    const { app, backend } = fixture()

    await app.run(backend, { input: 'Hello' })
    await app.decide('Is this urgent?', { questions })

    expect(lines.map((line) => [line.operation, line.inputTokens, line.costBasis])).toEqual([
      ['backend', 1_000_000, 'unavailable'],
      ['child', 1_000_000, 'unavailable'],
      ['ask-ephemeral', 1_000_000, 'unavailable'],
      ['backend', 1_000_000, 'unavailable'],
      ['decide', 1_000_000, 'unavailable'],
    ])
  },
)

test(
  'a usage log turned off writes nothing',
  { meta: { fixture: 'agent-kit.usage-line' } },
  async () => {
    const lines = captureLines()
    const { app, single } = fixture()

    await app.run(single, { input: 'Logged' })
    configureUsageLog(false)
    await app.run(single, { input: 'Not logged' })

    expect(lines.map((line) => line.operation)).toEqual(['single'])
  },
)

test(
  'the usage log writes to standard error by default, leaving standard output to the host',
  { meta: { fixture: 'agent-kit.usage-line' } },
  async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write')
    configureUsageLog({})
    const { app, single } = fixture()

    await app.run(single, { input: 'Hello' })

    const lines = stderr.mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(lines.map(({ event, operation }) => ({ event, operation }))).toEqual([
      { event: 'provider.usage', operation: 'single' },
    ])
    expect(stdout).not.toHaveBeenCalled()
  },
)
