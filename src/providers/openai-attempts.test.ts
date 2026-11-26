import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'

import { adk } from '../api/app'
import { FLEX_BUDGET_PASSED } from '../core/constants'
import { configureUsageLog } from '../core/usage-log'
import { useTestPricing } from '../test-support/pricing-registry'
import { openai } from './models'
import { OpenAIAdapter } from './openai'
import { configurePricing } from './pricing'

type Answer = (req: IncomingMessage, res: ServerResponse) => void

/** The input estimated for `Hello`, at about four characters a token. */
const ESTIMATED_INPUT = 2

const status =
  (code: number, message = `status ${code}`): Answer =>
  (_req, res) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message, type: 'server_error' } }))
  }

function stream(events: readonly unknown[]): Answer {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      events
        .map(
          (event, sequence_number) =>
            `data: ${JSON.stringify({ ...Object(event), sequence_number })}\n\n`,
        )
        .join(''),
    )
  }
}

const created = {
  type: 'response.created',
  response: { id: 'r', status: 'in_progress', output: [] },
}

/** A stream that ends without a terminal response. */
const premature = stream([created])

/** A completed answer that read 1M input tokens, priced at $0.15 for gpt-4o-mini. */
const answered = stream([
  created,
  {
    type: 'response.completed',
    response: {
      id: 'r',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'm',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Done', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    },
  },
])

/** A decision answering `urgent` that read 1M input tokens, priced at $0.15 for gpt-4o-mini. */
const decided: Answer = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      answers: [{ type: 'predicate', name: 'urgent', probability: 0.9 }],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }),
  )
}

let server: Server | undefined
let lines: Array<Record<string, unknown>> = []

beforeEach(async () => {
  await useTestPricing()
  lines = []
  configureUsageLog({ write: (line) => lines.push(JSON.parse(line)) })
})

afterEach(async () => {
  configureUsageLog(false)
  configurePricing(false)
  const open = server
  server = undefined
  if (open) await new Promise((resolve) => open.close(resolve))
})

/** Serves each request with the next answer, the last one repeated; counts the requests. */
async function serve(answers: readonly Answer[]): Promise<{ url: string; requests: () => number }> {
  let requests = 0
  const open = createServer((req, res) => {
    req.resume()
    req.on('end', () => answers[Math.min(requests++, answers.length - 1)](req, res))
  })
  server = open
  await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve))
  const address = open.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address')
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests }
}

/** An agent on `endpoints` OpenAI endpoints served by `url`, one by default. */
function agentOn(
  url: string,
  options: {
    retry?: { maxAttempts: number }
    endpoints?: number
    serviceTier?: 'flex'
    flexBudgetMs?: number
  } = {},
) {
  const adapter = new OpenAIAdapter(
    Array.from({ length: options.endpoints ?? 1 }, () => ({
      type: 'openai' as const,
      apiKey: 'test',
      baseUrl: `${url}/v1`,
    })),
  )
  const app = adk({ adapters: { openai: adapter } })
  const retry = options.retry && {
    ...options.retry,
    initialDelayMs: 1,
    maxDelayMs: 1,
    backoffMultiplier: 1,
  }
  const agent = app.agent({
    name: 'backend',
    model: openai('gpt-4o-mini', {
      retry,
      serviceTier: options.serviceTier,
      flexBudgetMs: options.flexBudgetMs,
    }),
    context: [app.context.history()],
  })
  return { app, agent }
}

function written() {
  return lines.map(
    ({ inputTokens, usageBasis, costUsd, costBasis, finishReason, serviceTier }) => ({
      inputTokens,
      serviceTier,
      usageBasis,
      costUsd,
      costBasis,
      finishReason,
    }),
  )
}

const ESTIMATED_LINE = {
  inputTokens: ESTIMATED_INPUT,
  usageBasis: 'estimated',
  costUsd: 3e-7,
  costBasis: 'estimated',
  finishReason: 'error',
}

/** A flex request cut off is priced at the flex rates, the tier it was sent at. */
const ESTIMATED_FLEX_LINE = { ...ESTIMATED_LINE, serviceTier: 'flex', costUsd: 1.5e-7 }

const SPENT_NOTHING_LINE = {
  inputTokens: 0,
  usageBasis: 'reported',
  costUsd: 0,
  costBasis: 'reported',
  finishReason: 'error',
}

const ANSWERED_LINE = {
  inputTokens: 1_000_000,
  usageBasis: 'reported',
  costUsd: 0.15,
  costBasis: 'reported',
  finishReason: 'stop',
}

test(
  'a request answered with an error status, retried by the adapter, writes a line that spent nothing',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([status(400), answered])
    const { app, agent } = agentOn(url, { retry: { maxAttempts: 2 } })

    const result = await app.run(agent, { input: 'Hello' })

    expect(requests()).toBe(2)
    expect(written()).toEqual([SPENT_NOTHING_LINE, ANSWERED_LINE])
    expect(result.usage?.modelCalls).toBe(2)
  },
)

test(
  'a request an endpoint refused, sent on to the next endpoint, writes a line that spent nothing',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([status(404, 'model not found'), answered])
    const { app, agent } = agentOn(url, { endpoints: 2 })

    const result = await app.run(agent, { input: 'Hello' })

    expect(requests()).toBe(2)
    expect(written()).toEqual([SPENT_NOTHING_LINE, ANSWERED_LINE])
    expect(result.usage?.modelCalls).toBe(2)
  },
)

test(
  'a flex request that failed, sent again at the standard tier, writes a line that spent nothing',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([status(400), answered])
    const { app, agent } = agentOn(url, { serviceTier: 'flex' })

    const result = await app.run(agent, { input: 'Hello' })

    expect(requests()).toBe(2)
    expect(written()).toEqual([SPENT_NOTHING_LINE, ANSWERED_LINE])
    expect(result.usage?.modelCalls).toBe(2)
  },
)

test(
  'a flex request cut off before output and tried again is priced at flex rates',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([premature, answered])
    const { app, agent } = agentOn(url, { serviceTier: 'flex', retry: { maxAttempts: 2 } })

    await app.run(agent, { input: 'Hello' })

    expect(requests()).toBe(2)
    expect(written()[0]).toEqual(ESTIMATED_FLEX_LINE)
  },
)

/** Never answers: the request stays open until the client gives up. */
const hung: Answer = () => undefined

test(
  'a flex request that passes its budget is cancelled and sent again at the standard tier',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([hung, answered])
    const { app, agent } = agentOn(url, { serviceTier: 'flex', flexBudgetMs: 50 })

    const result = await app.run(agent, { input: 'Hello' })

    expect(requests()).toBe(2)
    expect(written()).toEqual([ESTIMATED_FLEX_LINE, ANSWERED_LINE])
    expect(
      result.session.events.filter((e) => e.type === 'model_end' && e.error === FLEX_BUDGET_PASSED),
    ).toHaveLength(1)
  },
)

test(
  'a flex request answered within its budget is sent once',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([answered])
    const { app, agent } = agentOn(url, { serviceTier: 'flex', flexBudgetMs: 5_000 })

    const result = await app.run(agent, { input: 'Hello' })

    expect(requests()).toBe(1)
    expect(
      result.session.events.filter((e) => e.type === 'model_end' && e.error === FLEX_BUDGET_PASSED),
    ).toHaveLength(0)
  },
)

test(
  'a run aborted while a flex request waits is not sent again at the standard tier',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([hung, answered])
    const { app, agent } = agentOn(url, { serviceTier: 'flex', flexBudgetMs: 5_000 })

    const run = app.run(agent, { input: 'Hello' })
    await vi.waitFor(() => expect(requests()).toBe(1))
    run.abort()
    await expect(run).rejects.toThrow()

    expect(requests()).toBe(1)
  },
)

test(
  'a stream that ended early, retried by the adapter, writes a line of its own',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([premature, answered])
    const { app, agent } = agentOn(url)

    const result = await app.run(agent, { input: 'Hello' })

    expect(requests()).toBe(2)
    expect(written()).toEqual([ESTIMATED_LINE, ANSWERED_LINE])
    expect(result.usage?.modelCalls).toBe(2)
  },
)

test(
  'a retry aborted before its request is sent writes a line that spent nothing',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([premature, answered])
    const { app, agent } = agentOn(url)

    const run = app.run(agent, { input: 'Hello' })
    // The stream that ended early has its line; the adapter now waits before retrying.
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    run.abort()
    await expect(run).rejects.toThrow()
    await vi.waitFor(() => expect(lines).toHaveLength(2))

    expect(requests()).toBe(1)
    expect(written()).toEqual([ESTIMATED_LINE, SPENT_NOTHING_LINE])
  },
)

test(
  'a decision answered with an error status is sent once and writes a line that spent nothing',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    const { url, requests } = await serve([status(400)])
    const adapter = new OpenAIAdapter([{ type: 'openai', apiKey: 'test', baseUrl: `${url}/v1` }])
    const app = adk({ adapters: { openai: adapter }, defaultModel: openai('gpt-4o-mini') })

    await expect(
      app.decide('Is this urgent?', {
        questions: { urgent: { type: 'predicate', instructions: 'Is it urgent?' } },
      }),
    ).rejects.toThrow('400')

    expect(requests()).toBe(1)
    expect(
      lines.map(({ operation, inputTokens, costUsd, finishReason }) => ({
        operation,
        inputTokens,
        costUsd,
        finishReason,
      })),
    ).toEqual([{ operation: 'decide', inputTokens: 0, costUsd: 0, finishReason: 'error' }])
  },
)

test(
  'a decision an endpoint refused, sent on to the next endpoint, is a call per endpoint, each with its own start, line and duration',
  { meta: { fixture: 'agent-kit.failed-attempt-line' } },
  async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const after =
      (ms: number, answer: Answer): Answer =>
      (req, res) => {
        vi.setSystemTime(Date.now() + ms)
        answer(req, res)
      }
    const { url, requests } = await serve([
      after(1_000, status(400, 'model not found')),
      after(3_000, decided),
    ])
    const endpoint = { type: 'openai', apiKey: 'test', baseUrl: `${url}/v1` } as const
    const events: string[] = []
    const app = adk({
      adapters: { openai: new OpenAIAdapter([endpoint, endpoint]) },
      defaultModel: openai('gpt-4o-mini'),
      hooks: [{ onEvent: (event) => events.push(event.type) }],
    })

    await app.decide('Is this urgent?', {
      questions: { urgent: { type: 'predicate', instructions: 'Is it urgent?' } },
    })

    expect(requests()).toBe(2)
    expect(events).toEqual(['model_start', 'model_end', 'model_start', 'model_end'])
    expect(
      lines.map(({ operation, inputTokens, costUsd, finishReason, durationMs }) => ({
        operation,
        inputTokens,
        costUsd,
        finishReason,
        durationMs,
      })),
    ).toEqual([
      { operation: 'decide', inputTokens: 0, costUsd: 0, finishReason: 'error', durationMs: 1_000 },
      {
        operation: 'decide',
        inputTokens: 1_000_000,
        costUsd: 0.15,
        finishReason: 'stop',
        durationMs: 3_000,
      },
    ])
  },
)
