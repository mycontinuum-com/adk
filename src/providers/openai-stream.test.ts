import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ErrorHandler } from '../errors/types'
import type { ProviderModelConfig, StreamEvent } from '../types'

import { adk } from '../api'
import { buildContext } from '../context'
import { ModelResponseFailedError } from '../errors/types'
import { createTestSession, testAgent } from '../testing/context'
import { OpenAIAdapter } from './openai'

const model: ProviderModelConfig = { provider: 'openai', name: 'synthetic' }
const context = () => buildContext(createTestSession('Synthetic input'), testAgent(), 'synthetic')
const adapter = () =>
  new OpenAIAdapter([
    { type: 'openai', apiKey: 'synthetic', baseUrl: 'https://synthetic.invalid/v1' },
  ])
const created = () => ({
  type: 'response.created',
  response: { id: 'synthetic', status: 'in_progress', output: [] },
})
const completed = (output: unknown[] = []) => ({
  type: 'response.completed',
  response: {
    id: 'synthetic',
    status: 'completed',
    output,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
})
const FAILED_CODE = 'server_error'
const PROVIDER_DETAIL = 'private provider detail'
const FAILED_MESSAGE = `OpenAI response failed: ${FAILED_CODE}`
const TIMEOUT_CODE = 'vector_store_timeout'
const failed = (code: string = FAILED_CODE) => ({
  type: 'response.failed',
  response: {
    id: 'synthetic',
    status: 'failed',
    output: [],
    error: { code, message: PROVIDER_DETAIL },
  },
})
const call = {
  type: 'function_call',
  id: 'item_1',
  call_id: 'call_1',
  name: 'finish',
  arguments: '{"value":7}',
  status: 'completed',
}

function serve(streams: unknown[][]) {
  let next = 0
  const fetch = vi.fn<() => Promise<Response>>(async () => {
    const events = streams[next++]
    if (!events) throw new Error('Unexpected synthetic request')
    return new Response(
      events
        .map(
          (event, sequence_number) =>
            `data: ${JSON.stringify({ ...Object(event), sequence_number })}\n\n`,
        )
        .join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    )
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function consume(config: ProviderModelConfig = model) {
  const deltas: StreamEvent[] = []
  const stream = adapter().step(context(), config)
  let event = await stream.next()
  while (!event.done) {
    deltas.push(event.value)
    event = await stream.next()
  }
  return { deltas, result: event.value }
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI SDK stream completion', () => {
  it('retries a clean EOF without a terminal event once', async () => {
    const fetch = serve([[created()], [created(), completed([call])]])
    const { result } = await consume()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({ name: 'finish', args: { value: 7 } })
    expect(result.finishReason).toBe('tool_calls')
  })

  it('does not restart a failed stream after delivering partial reasoning', async () => {
    const fetch = serve([
      [
        created(),
        {
          type: 'response.reasoning_summary_text.delta',
          delta: 'Partial synthetic reasoning',
          item_id: 'reasoning_1',
          output_index: 0,
          summary_index: 0,
        },
      ],
      [created(), completed([call])],
    ])
    const stream = adapter().step(context(), model)
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { type: 'thought_delta', delta: 'Partial synthetic reasoning' },
    })
    await expect(stream.next()).rejects.toThrow('OpenAI stream ended without a terminal response')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails after two premature responses instead of returning an empty successful result', async () => {
    const fetch = serve([[created()], [created()]])
    await expect(consume()).rejects.toThrow('OpenAI stream ended without a terminal response')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry completed empty output', async () => {
    const fetch = serve([[created(), completed()]])
    const { result } = await consume()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ terminal: true, finishReason: 'stop', stepEvents: [] })
  })

  it('preserves a terminal incomplete response without retrying a token limit', async () => {
    const fetch = serve([
      [
        created(),
        {
          type: 'response.incomplete',
          response: {
            id: 'synthetic',
            status: 'incomplete',
            output: [],
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 1, output_tokens: 9 },
          },
        },
      ],
    ])
    const { result } = await consume()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      terminal: true,
      finishReason: 'length',
      usage: { inputTokens: 1, outputTokens: 9 },
    })
  })

  it('rejects a terminal failed response with its code and without the provider detail', async () => {
    const fetch = serve([[created(), failed()]])
    const failure = await consume().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ModelResponseFailedError)
    expect(failure).toMatchObject({
      message: FAILED_MESSAGE,
      provider: 'OpenAI',
      code: FAILED_CODE,
    })
    expect(inspect(failure)).not.toContain(PROVIDER_DETAIL)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not send a failed response to the next endpoint, even when its code names a timeout', async () => {
    const fetch = serve([
      [created(), failed(TIMEOUT_CODE)],
      [created(), completed()],
    ])
    const endpoints = new OpenAIAdapter([
      { type: 'openai', apiKey: 'synthetic', baseUrl: 'https://first.invalid/v1' },
      { type: 'openai', apiKey: 'synthetic', baseUrl: 'https://second.invalid/v1' },
    ])
    await expect(endpoints.step(context(), model).next()).rejects.toMatchObject({
      name: 'ModelResponseFailedError',
      code: TIMEOUT_CODE,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([1, 3])('honors the explicit %i attempt retry limit', async (maxAttempts) => {
    const fetch = serve(Array.from({ length: maxAttempts }, () => [created()]))
    await expect(
      consume({
        ...model,
        retry: { maxAttempts, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
      }),
    ).rejects.toThrow('OpenAI stream ended without a terminal response')
    expect(fetch).toHaveBeenCalledTimes(maxAttempts)
  })

  it('honors an explicit retry predicate that rejects the failure', async () => {
    const fetch = serve([[created()]])
    await expect(
      consume({
        ...model,
        retry: {
          maxAttempts: 3,
          initialDelayMs: 0,
          maxDelayMs: 0,
          backoffMultiplier: 1,
          retryableErrors: () => false,
        },
      }),
    ).rejects.toThrow('OpenAI stream ended without a terminal response')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('executes a tool only from the completed retry, never from the truncated attempt', async () => {
    const fetch = serve([
      [created(), { type: 'response.output_item.added', output_index: 0, item: call }],
      [created(), completed([call])],
    ])
    const execute = vi.fn<(value: number) => void>()
    const app = adk({ adapters: { openai: adapter() } })
    const agent = app.agent({
      name: 'synthetic',
      model,
      maxSteps: 3,
      context: [app.context.history()],
      tools: [
        app.tool({
          name: 'finish',
          description: 'Finish',
          schema: z.object({ value: z.number() }),
          execute: (ctx) => {
            execute(ctx.args.value)
            return ctx.output(ctx.args.value)
          },
        }),
      ],
    })
    try {
      const run = await app.run(agent, { input: 'Synthetic input' })
      expect(run.status).toBe('completed')
      expect(run.output.value).toBe(7)
      expect(execute).toHaveBeenCalledExactlyOnceWith(7)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(run.session.events.filter((event) => event.type === 'tool_call')).toHaveLength(1)
    } finally {
      await app.close()
    }
  })
})

// Sends a failed response once more when the run's state asks for it, as a call's flag does.
function retryFailedOnce(seen: Array<string | undefined>): ErrorHandler {
  return {
    canHandle: (ctx) => {
      if (ctx.phase !== 'model' || !(ctx.error instanceof ModelResponseFailedError)) return false
      seen.push(ctx.error.code)
      return ctx.attempt === 1 && ctx.session.state.retryFailed === true
    },
    handle: () => ({ action: 'retry' }),
  }
}

async function runWithRetryHandler(retryFailed: boolean, streams: unknown[][]) {
  const fetch = serve(streams)
  const seen: Array<string | undefined> = []
  const execute = vi.fn<(value: number) => void>()
  const app = adk({ adapters: { openai: adapter() } })
  const agent = app.agent({
    name: 'synthetic',
    model,
    maxSteps: 3,
    context: [app.context.history()],
    errorHandlers: [retryFailedOnce(seen)],
    tools: [
      app.tool({
        name: 'finish',
        description: 'Finish',
        schema: z.object({ value: z.number() }),
        execute: (ctx) => {
          execute(ctx.args.value)
          return ctx.output(ctx.args.value)
        },
      }),
    ],
  })
  const session = createTestSession('Synthetic input')
  session.state.update({ retryFailed })
  try {
    const outcome: { result?: unknown; error?: unknown } = await app.run(agent, { session }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    return { ...outcome, fetch, execute, session, seen }
  } finally {
    await app.close()
  }
}

// A run that still fails rejects with the same class name and message, without the error's fields.
function expectRejectedRun(error: unknown) {
  expect(error).toMatchObject({ name: 'ModelResponseFailedError', message: FAILED_MESSAGE })
  expect(error).not.toHaveProperty('code')
  expect(error).not.toHaveProperty('provider')
  expect(inspect(error)).not.toContain(PROVIDER_DETAIL)
}

describe('a failed OpenAI response and a model error handler', () => {
  it('fails the run on a failed response when the handler does not retry', async () => {
    const { error, seen, fetch, execute } = await runWithRetryHandler(false, [
      [created(), failed()],
    ])
    expect(seen).toEqual([FAILED_CODE])
    expectRejectedRun(error)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('sends the step once more when the handler reads the state and retries', async () => {
    const { result, seen, fetch, execute, session } = await runWithRetryHandler(true, [
      [created(), failed()],
      [created(), completed([call])],
    ])
    expect(seen).toEqual([FAILED_CODE])
    expect(result).toMatchObject({ status: 'completed', output: { value: 7 } })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledExactlyOnceWith(7)
    expect(session.events.filter((event) => event.type === 'tool_call')).toHaveLength(1)
  })

  it('fails the run when the one retry fails too', async () => {
    const { error, seen, fetch, execute } = await runWithRetryHandler(true, [
      [created(), failed()],
      [created(), failed()],
    ])
    expect(seen).toEqual([FAILED_CODE, FAILED_CODE])
    expectRejectedRun(error)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
  })
})
