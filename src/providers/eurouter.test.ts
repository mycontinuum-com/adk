import { z } from 'zod'
import { z as z3 } from 'zod/v3'

import type { EurouterModel, RenderContext, StreamEvent } from '../types'

import { adk } from '../api'
import { BaseRunner } from '../core/runner'
import { eurouter, EurouterAdapter } from '../integrations/eurouter'
import { createTestSession } from '../testing'

function chunk(delta: object, finish: string | null = null, extra: object = {}) {
  return {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    model: 'served-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  }
}
function sse(chunks: object[]) {
  return new Response(
    chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n',
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )
}
const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 30 },
  completion_tokens_details: { reasoning_tokens: 5 },
  cost: 0.001,
  cost_currency: 'USD',
}

function fixture(responses: Response[]) {
  const requests: Record<string, unknown>[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe('https://api.eurouter.ai/api/v1/chat/completions')
    requests.push(JSON.parse(String(init?.body)))
    const response = responses.shift()
    if (!response) throw new Error('Unexpected request')
    return response
  }
  return { requests, fetch }
}

function context(): RenderContext {
  const app = adk()
  return {
    invocationId: 'invocation',
    agentName: 'test',
    session: createTestSession('hello'),
    state: {},
    agent: app.agent({ name: 'test', model: eurouter('requested-model') }),
    events: [],
    functionTools: [],
    providerTools: [],
  }
}
async function drain(
  adapter: EurouterAdapter,
  config: EurouterModel = eurouter('requested-model'),
  signal?: AbortSignal,
) {
  const stream = adapter.step(context(), config, signal)
  const events: StreamEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, result: next.value }
}

it.each([
  {
    version: 'Zod 3',
    toolSchema: z3.object({ key: z3.enum(['a', 'b']) }),
    outputSchema: z3.object({ total: z3.number() }),
  },
  {
    version: 'Zod 4',
    toolSchema: z.object({ key: z.enum(['a', 'b']) }),
    outputSchema: z.object({ total: z.number() }),
  },
])(
  'runs tools and validates $version structured output through the real SDK',
  async ({ toolSchema, outputSchema }) => {
    const http = fixture([
      sse([
        chunk({ reasoning: 'Read both synthetic counts.' }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'lookup-a',
              type: 'function',
              function: { name: 'count', arguments: '{"' },
            },
            {
              index: 1,
              id: 'lookup-b',
              type: 'function',
              function: { name: 'count', arguments: '{"key":"b"}' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'key":"a"}' } }] }, 'tool_calls'),
        chunk({}, null, { choices: [], usage, provider: 'tensorix' }),
      ]),
      sse([
        { ...chunk({ content: '{"total":7}' }, 'stop'), id: 'completion-2' },
        { ...chunk({}, null, { choices: [], usage, provider: 'tensorix' }), id: 'completion-2' },
      ]),
    ])
    const app = adk()
    const seen: string[] = []
    const count = app.tool({
      name: 'count',
      description: 'Read a synthetic count.',
      schema: toolSchema,
      execute: (ctx) => {
        seen.push(ctx.args.key)
        return ctx.args.key === 'a' ? 3 : 4
      },
    })
    const agent = app.agent({
      name: 'test',
      model: eurouter('requested-model'),
      tools: [count],
      context: [app.context.history()],
      output: { schema: outputSchema },
    })
    const runner = new BaseRunner({
      adapters: {
        eurouter: new EurouterAdapter({
          apiKey: 'fixture-secret',
          fetch: http.fetch,
          routing: { only: ['tensorix'], order: ['tensorix'], allowFallbacks: false },
        }),
      },
    })
    const result = await runner.run(agent, createTestSession('Add a and b.'))
    expect(result.status).toBe('completed')
    expect(result.output.value).toEqual({ total: 7 })
    expect(seen.sort()).toEqual(['a', 'b'])
    expect(http.requests[0].provider).toEqual({
      only: ['tensorix'],
      order: ['tensorix'],
      allow_fallbacks: false,
      data_residency: 'eu',
      max_retention_days: 0,
      data_collection: 'deny',
    })
    expect(http.requests[0].response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    })
    const messages = z
      .array(z.object({ role: z.string() }).passthrough())
      .parse(http.requests[1].messages)
    expect(messages.filter((message) => message.role === 'assistant')).toEqual([
      {
        role: 'assistant',
        content: null,
        reasoning: 'Read both synthetic counts.',
        tool_calls: [
          {
            id: 'lookup-a',
            type: 'function',
            function: { name: 'count', arguments: '{"key":"a"}' },
          },
          {
            id: 'lookup-b',
            type: 'function',
            function: { name: 'count', arguments: '{"key":"b"}' },
          },
        ],
      },
    ])
    expect(messages.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'lookup-a', content: '3' },
      { role: 'tool', tool_call_id: 'lookup-b', content: '4' },
    ])
    expect(result.usage).toMatchObject({
      modelCalls: 2,
      reportedCostUSD: 0.002,
      totalInputTokens: 200,
      totalOutputTokens: 40,
      models: [
        { provider: 'eurouter', modelName: 'served-model', calls: 2, reportedCostUSD: 0.002 },
      ],
    })
    expect(result.usage?.cost).toBeUndefined()
    expect(result.session.events.filter((event) => event.type === 'model_end')).toEqual([
      expect.objectContaining({
        usage: expect.objectContaining({
          modelName: 'served-model',
          requestedModelName: 'requested-model',
          servingProvider: 'tensorix',
        }),
      }),
      expect.objectContaining({ usage: expect.objectContaining({ modelName: 'served-model' }) }),
    ])
    expect(JSON.stringify(result.session.events)).not.toContain('fixture-secret')
  },
)

it('keeps gateway usage separate from native-model pricing and omits totals with missing usage', async () => {
  const http = fixture([
    sse([chunk({ content: 'first' }, 'stop', { model: 'gpt-4o-mini', usage })]),
    sse([chunk({ content: 'second' }, 'stop', { model: 'gpt-4o-mini' })]),
  ])
  const app = adk()
  const runner = new BaseRunner({
    adapters: { eurouter: new EurouterAdapter({ apiKey: 'fixture', fetch: http.fetch }) },
  })
  const agent = app.agent({ name: 'test', model: eurouter('alias'), context: [] })
  const session = createTestSession('hello')
  const first = await runner.run(agent, session)
  expect(first.usage).toMatchObject({ modelCalls: 1, reportedCostUSD: 0.001 })
  session.input.message('again')
  const second = await runner.run(agent, session)
  expect(second.output.text).toBe('second')
  expect(second.usage?.cost).toBeUndefined()
  expect(second.usage?.reportedCostUSD).toBeUndefined()
})

it.each([
  ['length', [chunk({ content: 'partial' }, 'length')]],
  ['content_filter', [chunk({}, 'content_filter')]],
  ['incomplete stream', [chunk({ content: 'partial' })]],
  ['refused', [chunk({ refusal: 'No' }, 'stop')]],
  [
    'JSON',
    [
      chunk(
        {
          tool_calls: [
            { index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{bad' } },
          ],
        },
        'tool_calls',
      ),
    ],
  ],
])('fails %s without retrying generated output', async (_name, chunks) => {
  const http = fixture([sse(chunks)])
  await expect(
    drain(
      new EurouterAdapter({ apiKey: 'fixture', fetch: http.fetch }),
      eurouter('m', {
        retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, backoffMultiplier: 1 },
      }),
    ),
  ).rejects.toThrow()
  expect(http.requests).toHaveLength(1)
})

it('retries a transient pre-output error, preserving request policy', async () => {
  const http = fixture([
    new Response('{"error":{"message":"busy"}}', { status: 429 }),
    sse([chunk({ content: 'ready' }, 'stop')]),
  ])
  const result = await drain(
    new EurouterAdapter({ apiKey: 'fixture', fetch: http.fetch }),
    eurouter('m', {
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, backoffMultiplier: 1 },
    }),
  )
  expect(result.result.stepEvents).toEqual([
    expect.objectContaining({ type: 'assistant', text: 'ready' }),
  ])
  expect(http.requests).toHaveLength(2)
  expect(http.requests[0]).toEqual(http.requests[1])
})

it('cancels a retry delay and never performs the next request', async () => {
  const controller = new AbortController()
  let requests = 0
  const fetch: typeof globalThis.fetch = async () => {
    requests++
    setTimeout(() => controller.abort(), 10)
    return new Response('{"error":{"message":"busy"}}', { status: 429 })
  }
  await expect(
    drain(
      new EurouterAdapter({ apiKey: 'fixture', fetch }),
      eurouter('m', {
        retry: { maxAttempts: 3, initialDelayMs: 60_000, maxDelayMs: 60_000, backoffMultiplier: 1 },
      }),
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(controller.signal.aborted).toBe(true)
  expect(requests).toBe(1)
})

it('rejects provider tools and media before sending requests', async () => {
  const adapter = new EurouterAdapter({
    apiKey: 'fixture',
    fetch: async () => {
      throw new Error('Network called')
    },
  })
  const ctx = context()
  await expect(
    adapter.step({ ...ctx, providerTools: [{ type: 'web_search' }] }, eurouter('m')).next(),
  ).rejects.toThrow('provider-native tools')
  await expect(
    adapter
      .step(
        {
          ...ctx,
          events: [
            {
              id: 'u',
              type: 'user',
              text: '',
              createdAt: 0,
              media: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image' } }],
            },
          ],
        },
        eurouter('m'),
      )
      .next(),
  ).rejects.toThrow('text context only')
})

it('leaves prompt-mode structured output to the common ADK runner', async () => {
  const http = fixture([sse([chunk({ content: '{"ok":true}' }, 'stop')])])
  const ctx = {
    ...context(),
    outputSchema: z.object({ ok: z.boolean() }),
    outputMode: 'prompt' as const,
  }
  const stream = new EurouterAdapter({ apiKey: 'fixture', fetch: http.fetch }).step(
    ctx,
    eurouter('m'),
  )
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  expect(next.value.stepEvents).toEqual([expect.objectContaining({ text: '{"ok":true}' })])
  expect(http.requests[0].response_format).toBeUndefined()
})

it('never substitutes OpenAI credentials for a missing EUrouter key', () => {
  const originalGateway = process.env.EUROUTER_API_KEY
  const originalOpenAI = process.env.OPENAI_API_KEY
  try {
    delete process.env.EUROUTER_API_KEY
    process.env.OPENAI_API_KEY = 'native-openai-secret'
    expect(() => new EurouterAdapter()).toThrow('EUrouter requires an apiKey or EUROUTER_API_KEY')
    expect(() => new EurouterAdapter({ apiKey: '  ' })).toThrow('EUrouter requires an apiKey')
    expect(() => new EurouterAdapter({ apiKey: 'gateway-secret' })).not.toThrow()
  } finally {
    if (originalGateway === undefined) delete process.env.EUROUTER_API_KEY
    else process.env.EUROUTER_API_KEY = originalGateway
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAI
  }
})

it('does not report a complete estimated cost when a model call omitted usage', async () => {
  let calls = 0
  const app = adk()
  const runner = new BaseRunner({
    adapters: {
      openai: {
        async *step(ctx) {
          calls++
          yield {
            id: `delta-${calls}`,
            type: 'assistant_delta',
            createdAt: 0,
            invocationId: ctx.invocationId,
            agentName: ctx.agentName,
            text: 'reply',
            delta: 'reply',
          }
          return {
            stepEvents: [],
            toolCalls: [],
            terminal: calls === 2,
            ...(calls === 1 && {
              usage: { modelName: 'gpt-4o-mini', inputTokens: 100, outputTokens: 20 },
            }),
          }
        },
      },
    },
  })
  const result = await runner.run(
    app.agent({
      name: 'partial-cost',
      context: [],
      model: { provider: 'openai', name: 'gpt-4o-mini' },
    }),
    createTestSession('hello'),
  )
  expect(result.status).toBe('completed')
  expect(result.usage).toMatchObject({
    modelCalls: 2,
    totalInputTokens: 100,
    totalOutputTokens: 20,
  })
  expect(result.usage?.cost).toBeUndefined()
  expect(result.usage?.models[0].cost).toBeUndefined()
})

it('does not retry a failed stream after emitting text', async () => {
  let requests = 0
  const fetch: typeof globalThis.fetch = async () => {
    requests++
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`),
          )
          setTimeout(() => controller.error(new Error('Connection reset')), 5)
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  const stream = new EurouterAdapter({ apiKey: 'fixture', fetch }).step(
    context(),
    eurouter('m', {
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 },
    }),
  )
  expect(await stream.next()).toMatchObject({
    done: false,
    value: { type: 'assistant_delta', text: 'partial' },
  })
  await expect(stream.next()).rejects.toThrow('Connection reset')
  expect(requests).toBe(1)
})

it('propagates cancellation to an active SDK request', async () => {
  const controller = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal
    return new Response(
      new ReadableStream({
        start(body) {
          body.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`),
          )
          requestSignal?.addEventListener('abort', () => body.error(new Error('Request aborted')), {
            once: true,
          })
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  const stream = new EurouterAdapter({ apiKey: 'fixture', fetch }).step(
    context(),
    eurouter('m'),
    controller.signal,
  )
  expect(await stream.next()).toMatchObject({ done: false, value: { text: 'partial' } })
  controller.abort()
  await expect(stream.next()).rejects.toThrow()
  expect(requestSignal?.aborted).toBe(true)
})

it('respects context filters when replaying reasoning and parallel tool turns', async () => {
  const { pruneReasoning, selectRecentEvents } = await import('../context/filters')
  const http = fixture([
    sse([
      chunk(
        {
          reasoning: 'Remove this thought.',
          tool_calls: [
            { index: 0, id: 'a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            { index: 1, id: 'b', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
          ],
        },
        'tool_calls',
      ),
    ]),
    sse([chunk({ content: 'done' }, 'stop')]),
    sse([chunk({ content: 'done' }, 'stop')]),
  ])
  const adapter = new EurouterAdapter({ apiKey: 'fixture', fetch: http.fetch })
  const first = await drain(adapter)
  const ctx: RenderContext = {
    ...context(),
    events: [
      ...first.result.stepEvents,
      ...first.result.toolCalls.map((call) => ({
        id: `result-${call.callId}`,
        type: 'tool_result' as const,
        callId: call.callId,
        name: call.name,
        result: 'ok',
        createdAt: 0,
        invocationId: 'invocation',
        agentName: 'test',
      })),
    ],
  }
  for (const filtered of [pruneReasoning()(ctx), selectRecentEvents(1)(ctx)]) {
    const stream = adapter.step(filtered, eurouter('requested-model'))
    let next = await stream.next()
    while (!next.done) next = await stream.next()
    expect(next.value.stepEvents).toEqual([
      expect.objectContaining({ type: 'assistant', text: 'done' }),
    ])
  }
  expect(http.requests[1].messages).toEqual([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: '"ok"' },
    { role: 'tool', tool_call_id: 'b', content: '"ok"' },
  ])
  expect(http.requests[2].messages).toEqual([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'b', type: 'function', function: { name: 'tool_b', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'b', content: '"ok"' },
  ])
})

it('does not complete after cancellation following a final text delta', async () => {
  const controller = new AbortController()
  const fetch: typeof globalThis.fetch = async (_input, init) =>
    new Response(
      new ReadableStream({
        start(body) {
          body.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(chunk({ content: 'done' }, 'stop'))}\n\n`,
            ),
          )
          init?.signal?.addEventListener(
            'abort',
            () => {
              body.error(new DOMException('Aborted', 'AbortError'))
            },
            { once: true },
          )
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  const stream = new EurouterAdapter({ apiKey: 'fixture', fetch }).step(
    context(),
    eurouter('m'),
    controller.signal,
  )
  expect(await stream.next()).toMatchObject({ done: false, value: { text: 'done' } })
  controller.abort()
  await expect(stream.next()).rejects.toThrow()
})

it('keeps reused gateway tool IDs distinct in ADK history while replaying the wire IDs', async () => {
  const http = fixture([
    sse([
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_0',
              type: 'function',
              function: { name: 'count', arguments: '{}' },
            },
          ],
        },
        'tool_calls',
      ),
    ]),
    sse([chunk({ content: 'first' }, 'stop')]),
    sse([
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_0',
              type: 'function',
              function: { name: 'count', arguments: '{}' },
            },
          ],
        },
        'tool_calls',
      ),
    ]),
    sse([chunk({ content: 'second' }, 'stop')]),
  ])
  let count = 0
  const app = adk()
  const tool = app.tool({
    name: 'count',
    description: 'Count invocations.',
    schema: z.object({}),
    execute: () => ++count,
  })
  const agent = app.agent({
    name: 'test',
    model: eurouter('m'),
    tools: [tool],
    context: [app.context.history()],
  })
  const runner = new BaseRunner({
    adapters: { eurouter: new EurouterAdapter({ apiKey: 'fixture', fetch: http.fetch }) },
  })
  const session = createTestSession('first')
  expect((await runner.run(agent, session)).output.text).toBe('first')
  session.input.message('second')
  expect((await runner.run(agent, session)).output.text).toBe('second')
  const calls = session.events.filter((event) => event.type === 'tool_call')
  expect(calls).toHaveLength(2)
  expect(new Set(calls.map((event) => event.callId)).size).toBe(2)
  expect(count).toBe(2)
  const messages = z
    .array(z.object({ role: z.string() }).passthrough())
    .parse(http.requests[3].messages)
  expect(messages.filter((message) => message.role === 'tool')).toEqual([
    { role: 'tool', tool_call_id: 'call_0', content: '1' },
    { role: 'tool', tool_call_id: 'call_0', content: '2' },
  ])
  expect(messages.filter((message) => message.role === 'assistant' && message.tool_calls)).toEqual([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_0', type: 'function', function: { name: 'count', arguments: '{}' } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_0', type: 'function', function: { name: 'count', arguments: '{}' } },
      ],
    },
  ])
})
