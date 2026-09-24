import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { adk } from '../api'
import { BaseRunner } from '../core/runner'
import { chatCompletions, ChatCompletionsAdapter } from '../integrations/chat-completions'
import { BaseSession } from '../session/base'
import { SQLiteStore } from '../session/sqlite'
import { createTestSession } from '../testing'

function chunk(delta: object, finish: string | null = null) {
  return {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
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
function fixture(responses: Response[]) {
  const requests: Record<string, unknown>[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe('http://127.0.0.1:30000/v1/chat/completions')
    expect(request.headers.has('authorization')).toBe(false)
    const body = await request.json()
    expect(body).not.toHaveProperty('provider')
    expect(body.reasoning_effort).toBe('xhigh')
    expect(body.chat_template_kwargs).toEqual({
      preserve_thinking: true,
      reasoning_effort: 'xhigh',
    })
    requests.push(body)
    const response = responses.shift()
    if (!response) throw new Error('Unexpected request')
    return response
  }
  return { requests, fetch }
}

it.each([
  { field: 'reasoning', fragments: [' Keep', ' exactly.\n'], expected: ' Keep exactly.\n' },
  { field: 'reasoning_content', fragments: [' Keep', ' exactly.\n'], expected: ' Keep exactly.\n' },
  { field: 'reasoning_content', fragments: ['', ''], expected: '' },
  {
    field: 'reasoning_details',
    fragments: [
      [{ type: 'reasoning.text', text: ' Keep', index: 0, format: 'unknown' }],
      [{ type: 'reasoning.text', text: ' exactly.\n', index: 0, signature: 'fixture-signature' }],
      [{ type: 'reasoning.encrypted', data: 'fixture-opaque', index: 1, extra: { retain: true } }],
    ],
    expected: [
      { type: 'reasoning.text', text: ' Keep', index: 0, format: 'unknown' },
      { type: 'reasoning.text', text: ' exactly.\n', index: 0, signature: 'fixture-signature' },
      { type: 'reasoning.encrypted', data: 'fixture-opaque', index: 1, extra: { retain: true } },
    ],
  },
  {
    field: 'reasoning_details',
    fragments: [[{ type: 'reasoning.encrypted', data: 'fixture-opaque', index: 0 }]],
    expected: [{ type: 'reasoning.encrypted', data: 'fixture-opaque', index: 0 }],
  },
])(
  'replays $field through tools and a new turn after SQLite reload',
  async ({ field, fragments, expected }) => {
    const http = fixture([
      sse([
        ...fragments.map((part) => chunk({ [field]: part, tool_calls: null })),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'wire-lookup',
              type: 'function',
              function: { name: 'lookup', arguments: '' },
            },
          ],
        }),
        chunk(
          {
            tool_calls: [
              { index: 0, id: null, type: 'function', function: { name: null, arguments: '{}' } },
            ],
          },
          'tool_calls',
        ),
      ]),
      sse([
        ...fragments.map((part) => chunk({ [field]: part, tool_calls: null })),
        chunk({ content: 'First answer' }, 'stop'),
      ]),
      sse([chunk({ content: 'Second answer' }, 'stop')]),
    ])
    const app = adk()
    const agent = app.agent({
      name: 'continuity',
      model: chatCompletions('fixture-model', {
        reasoningEffort: 'xhigh',
        chatTemplate: { preserve_thinking: true, reasoning_effort: 'xhigh' },
      }),
      context: [app.context.history()],
      tools: [
        app.tool({
          name: 'lookup',
          description: 'Read a synthetic value.',
          schema: z.object({}),
          execute: () => 7,
        }),
      ],
    })
    const session = createTestSession('First question')
    const first = await new BaseRunner({
      adapters: {
        'chat-completions': new ChatCompletionsAdapter({
          baseURL: 'http://127.0.0.1:30000/v1',
          fetch: http.fetch,
        }),
      },
    }).run(agent, session)
    expect(first.status).toBe('completed')
    expect(http.requests[1].messages).toContainEqual({
      role: 'assistant',
      content: null,
      [field]: expected,
      tool_calls: [
        { id: 'wire-lookup', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    })
    const directory = mkdtempSync(join(tmpdir(), 'adk-reasoning-'))
    const path = join(directory, 'sessions.db')
    const writer = new SQLiteStore(path)
    const reader = new SQLiteStore(path)
    try {
      expect(
        await writer.commit(
          {
            id: session.id,
            appName: session.appName,
            version: 0,
            scopes: session.scopes,
            createdAt: session.createdAt,
          },
          [...session.events],
          0,
        ),
      ).toMatchObject({ ok: true })
      await writer.close()
      const saved = await reader.load(session.appName, session.id)
      if (!saved) throw new Error('Expected the persisted session')
      const restored = BaseSession.fromSnapshot({ ...saved.session, events: saved.events })
      restored.input.message('Second question')
      const second = await new BaseRunner({
        adapters: {
          'chat-completions': new ChatCompletionsAdapter({
            baseURL: 'http://127.0.0.1:30000/v1',
            fetch: http.fetch,
          }),
        },
      }).run(agent, restored)
      expect(second.status).toBe('completed')
      const messages = z
        .array(z.object({ role: z.string() }).passthrough())
        .parse(http.requests[2].messages)
      expect(messages.filter((message) => message.role === 'assistant')).toEqual([
        {
          role: 'assistant',
          content: null,
          [field]: expected,
          tool_calls: [
            { id: 'wire-lookup', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        { role: 'assistant', content: 'First answer', [field]: expected },
      ])
      expect(messages.at(-1)).toEqual({ role: 'user', content: 'Second question' })
    } finally {
      await writer.close()
      await reader.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

it('does not inherit native or gateway credentials and preserves an explicit key', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'must-not-send-openai')
  vi.stubEnv('OPENAI_ORG_ID', 'must-not-send-org')
  vi.stubEnv('OPENAI_PROJECT_ID', 'must-not-send-project')
  vi.stubEnv('EUROUTER_API_KEY', 'must-not-send-eurouter')
  try {
    for (const apiKey of [undefined, 'explicit-local-key']) {
      const transport: typeof fetch = async (input, init) => {
        const request = new Request(input, init)
        expect(request.headers.get('authorization')).toBe(apiKey ? `Bearer ${apiKey}` : null)
        expect(request.headers.has('openai-organization')).toBe(false)
        expect(request.headers.has('openai-project')).toBe(false)
        expect(await request.json()).not.toHaveProperty('provider')
        return sse([chunk({ content: 'ok' }, 'stop')])
      }
      const app = adk({
        adapters: {
          'chat-completions': new ChatCompletionsAdapter({
            baseURL: 'http://127.0.0.1:30000/v1',
            apiKey,
            fetch: transport,
          }),
        },
      })
      const result = await app.run(
        app.agent({
          name: 'test',
          context: [app.context.history()],
          model: chatCompletions('fixture-model'),
        }),
        { input: 'hello' },
      )
      expect(result.output.text).toBe('ok')
      expect(
        result.session.events.filter((event) => event.type === 'assistant')[0]?.providerContext
          ?.provider,
      ).toBe('chat-completions')
    }
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each([
  'file:///tmp/model',
  'http://secret@localhost/v1',
  'https://host/v1?key=secret',
  'http://host/v1#fragment',
])('rejects unsupported endpoint %s before a request', (baseURL) => {
  expect(() => new ChatCompletionsAdapter({ baseURL })).toThrow()
})

it('rejects unrecognized chat template fields before HTTP', async () => {
  const transport = vi.fn<typeof fetch>()
  const app = adk({
    adapters: {
      'chat-completions': new ChatCompletionsAdapter({
        baseURL: 'http://127.0.0.1:30000/v1',
        fetch: transport,
      }),
    },
  })
  const model = chatCompletions('fixture-model', { chatTemplate: JSON.parse('{"model":"other"}') })
  await expect(
    app.run(app.agent({ name: 'test', context: [app.context.history()], model }), {
      input: 'hello',
    }),
  ).rejects.toThrow()
  expect(transport).not.toHaveBeenCalled()
})

it.each(['chat-completions', 'eurouter'] as const)(
  'rejects a registered but unadvertised tool before %s executes it',
  async (provider) => {
    const executions: string[] = []
    let requests = 0
    const transport: typeof fetch = async (input, init) => {
      const body = await new Request(input, init).json()
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
        'allowed',
      ])
      requests++
      return requests === 1
        ? sse([
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: 'forbidden-call',
                    type: 'function',
                    function: { name: 'forbidden', arguments: '{"sensitive":"private value"}' },
                  },
                ],
              },
              'tool_calls',
            ),
          ])
        : sse([chunk({ content: 'done' }, 'stop')])
    }
    const { eurouter, EurouterAdapter } = await import('../integrations/eurouter')
    const app = adk({
      adapters: {
        'chat-completions': new ChatCompletionsAdapter({
          baseURL: 'http://127.0.0.1:30000/v1',
          fetch: transport,
        }),
        eurouter: new EurouterAdapter({ apiKey: 'fixture', fetch: transport }),
      },
    })
    const tools = ['allowed', 'forbidden'].map((name) =>
      app.tool({
        name,
        description: name,
        schema: z.object({}),
        execute: () => {
          executions.push(name)
          return 'called'
        },
      }),
    )
    const agent = app.agent({
      name: 'limited',
      model: provider === 'eurouter' ? eurouter('fixture-model') : chatCompletions('fixture-model'),
      tools,
      context: [app.context.history(), app.context.limitTools(['allowed'])],
    })
    const outcome = await Promise.resolve(app.run(agent, { input: 'Use the allowed tool' })).then(
      () => null,
      (error: unknown) => error,
    )
    expect(executions).toEqual([])
    expect(outcome).toMatchObject({
      message: `${provider === 'eurouter' ? 'EUrouter' : 'Chat Completions'} returned an unadvertised tool "forbidden"; allowed tools: allowed`,
    })
    expect(requests).toBe(1)
  },
)

it('routes concurrent models to independently configured named adapters', async () => {
  const calls: { url: string; authorization: string | null; body: unknown }[] = []
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    calls.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      body: await request.json(),
    })
    return sse([chunk({ content: new URL(request.url).hostname }, 'stop')])
  }
  const app = adk({
    adapters: {
      base: new ChatCompletionsAdapter({
        baseURL: 'https://base.example/v1',
        apiKey: 'base-key',
        fetch: transport,
      }),
      trained: new ChatCompletionsAdapter({
        baseURL: 'https://trained.example/v1',
        apiKey: 'trained-key',
        fetch: transport,
      }),
    },
  })
  const models = [
    chatCompletions('same-model', { adapter: 'base', reasoningEffort: 'high', temperature: 0.1 }),
    chatCompletions('same-model', {
      adapter: 'trained',
      reasoningEffort: 'xhigh',
      temperature: 0.8,
    }),
  ]
  const results = await Promise.all(
    models.map((model) =>
      app.run(app.agent({ name: 'test', model, context: [app.context.history()] }), {
        input: 'hello',
      }),
    ),
  )
  expect(results.map((result) => result.output.text)).toEqual(['base.example', 'trained.example'])
  expect(calls).toHaveLength(2)
  expect(calls).toEqual(
    expect.arrayContaining([
      {
        url: 'https://base.example/v1/chat/completions',
        authorization: 'Bearer base-key',
        body: expect.objectContaining({
          model: 'same-model',
          reasoning_effort: 'high',
          temperature: 0.1,
        }),
      },
      {
        url: 'https://trained.example/v1/chat/completions',
        authorization: 'Bearer trained-key',
        body: expect.objectContaining({
          model: 'same-model',
          reasoning_effort: 'xhigh',
          temperature: 0.8,
        }),
      },
    ]),
  )
  expect(
    JSON.stringify(
      results.flatMap((result) => result.session.events.map((event) => event.providerContext)),
    ),
  ).not.toMatch(/base\.example|trained\.example|base-key|trained-key/)
})

it.each(['missing', 'constructor', 'toString'])(
  'rejects missing named adapter %s without fallback',
  async (adapter) => {
    const transport = vi.fn<typeof fetch>()
    const app = adk({
      adapters: {
        'chat-completions': new ChatCompletionsAdapter({
          baseURL: 'https://default.example/v1',
          fetch: transport,
        }),
      },
    })
    await expect(
      app.run(
        app.agent({
          name: 'test',
          model: chatCompletions('fixture-model', { adapter }),
          context: [app.context.history()],
        }),
        {
          input: 'hello',
        },
      ),
    ).rejects.toThrow(`No adapter registered as '${adapter}'`)
    expect(transport).not.toHaveBeenCalled()
  },
)

it('selects named adapters from a runner Map and a handler override', async () => {
  const makeAdapter = (text: string) =>
    new ChatCompletionsAdapter({
      baseURL: 'https://fixture.example/v1',
      fetch: async () => sse([chunk({ content: text }, 'stop')]),
    })
  const app = adk({ adapters: { research: makeAdapter('app') } })
  const agent = app.agent({
    name: 'named',
    model: chatCompletions('fixture-model', { adapter: 'research' }),
    context: [app.context.history()],
  })
  const runner = new BaseRunner({ adapters: new Map([['research', makeAdapter('map')]]) })
  expect((await runner.run(agent, createTestSession('hello'))).output.text).toBe('map')
  expect((await app.handler.rest({ agent })({ input: { message: 'hello' } })).output.text).toBe(
    'app',
  )
  const override = app.handler.rest({ agent, adapters: { research: makeAdapter('handler') } })
  expect((await override({ input: { message: 'hello' } })).output.text).toBe('handler')
})

it.each(['same', 'host', 'alias', 'model', 'unscoped'])(
  'isolates native continuation after SQLite reload when changing %s',
  async (change) => {
    const requests: unknown[] = []
    const responses = [
      sse([
        chunk({ reasoning_content: 'private reasoning' }),
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'wire-lookup',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
      ]),
      sse([chunk({ reasoning_content: 'answer reasoning', content: 'First answer' }, 'stop')]),
      sse([chunk({ content: 'Second answer' }, 'stop')]),
    ]
    const transport: typeof fetch = async (input, init) => {
      requests.push(await new Request(input, init).json())
      const response = responses.shift()
      if (!response) throw new Error('Unexpected request')
      return response
    }
    const app = adk()
    const tools = [
      app.tool({
        name: 'lookup',
        description: 'Read a value',
        schema: z.object({}),
        execute: () => 7,
      }),
    ]
    const makeAgent = (adapter: string, model: string) =>
      app.agent({
        name: 'continuity',
        model: chatCompletions(model, { adapter }),
        tools,
        context: [app.context.history()],
      })
    const session = createTestSession('First question')
    const first = await new BaseRunner({
      adapters: {
        research: new ChatCompletionsAdapter({
          baseURL: 'https://first.example/v1/',
          fetch: transport,
        }),
      },
    }).run(makeAgent('research', 'fixture-model'), session)
    expect(first.status).toBe('completed')
    const directory = mkdtempSync(join(tmpdir(), 'adk-scoped-reasoning-'))
    const path = join(directory, 'sessions.db')
    const writer = new SQLiteStore(path)
    const reader = new SQLiteStore(path)
    try {
      const events = [...session.events]
      if (change === 'unscoped') {
        for (const event of events) {
          const data = event.providerContext?.data
          if (typeof data === 'object' && data !== null && 'scope' in data) delete data.scope
        }
      }
      expect(
        await writer.commit(
          {
            id: session.id,
            appName: session.appName,
            version: 0,
            scopes: session.scopes,
            createdAt: session.createdAt,
          },
          events,
          0,
        ),
      ).toMatchObject({ ok: true })
      await writer.close()
      const saved = await reader.load(session.appName, session.id)
      if (!saved) throw new Error('Expected persisted session')
      const restored = BaseSession.fromSnapshot({ ...saved.session, events: saved.events })
      restored.input.message('Second question')
      const adapter = change === 'alias' ? 'other' : 'research'
      const second = await new BaseRunner({
        adapters: {
          [adapter]: new ChatCompletionsAdapter({
            baseURL: change === 'host' ? 'https://second.example/v1' : 'https://first.example/v1',
            apiKey: 'rotated-key',
            fetch: transport,
          }),
        },
      }).run(makeAgent(adapter, change === 'model' ? 'other-model' : 'fixture-model'), restored)
      expect(second.status).toBe('completed')
      const body = z
        .object({ messages: z.array(z.object({ role: z.string() }).passthrough()) })
        .parse(requests[2])
      const toolCall = events.find((event) => event.type === 'tool_call')
      if (!toolCall || toolCall.type !== 'tool_call') throw new Error('Expected a tool call')
      const callId = change === 'same' ? 'wire-lookup' : toolCall.callId
      expect(body.messages.filter((message) => message.role === 'assistant')).toEqual([
        {
          role: 'assistant',
          content: null,
          ...(change === 'same' && { reasoning_content: 'private reasoning' }),
          tool_calls: [
            { id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        {
          role: 'assistant',
          content: 'First answer',
          ...(change === 'same' && { reasoning_content: 'answer reasoning' }),
        },
      ])
      expect(body.messages).toContainEqual({ role: 'tool', tool_call_id: callId, content: '7' })
      const persisted = JSON.stringify(saved.events)
      expect(persisted).not.toMatch(/first\.example|second\.example|rotated-key/)
      if (change !== 'unscoped') {
        const thought = saved.events.find((event) => event.type === 'thought')
        expect(thought?.providerContext?.data).toMatchObject({
          scope: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
      }
    } finally {
      await writer.close()
      await reader.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
