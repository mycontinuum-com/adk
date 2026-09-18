import { z } from 'zod'

import { adk } from '../api/app'
import { openai } from './models'
import { OpenAIAdapter } from './openai'

afterEach(() => vi.unstubAllGlobals())

function answerWith(payload: unknown) {
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body))
    expect(request.stream).toBe(true)
    const response = {
      id: 'resp_local',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'synthetic',
      output: [
        {
          id: 'msg_local',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(payload), annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    const events = [
      {
        type: 'response.created',
        response: { ...response, status: 'in_progress', output: [] },
        sequence_number: 0,
      },
      { type: 'response.completed', response, sequence_number: 1 },
    ]
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  })
  return adk({
    defaultModel: openai('synthetic'),
    adapters: {
      openai: new OpenAIAdapter([
        { type: 'openai', apiKey: 'offline-test-only', baseUrl: 'https://local.invalid/v1' },
      ]),
    },
  })
}

it('rejects an SDK response that violates a numeric constraint', async () => {
  const app = answerWith({ value: -1 })
  await expect(
    app.ask('Validate', { schema: z.object({ value: z.number().min(1) }), retries: 0 }),
  ).rejects.toThrow()
})

it('rejects a nested refinement even when the response satisfies its JSON Schema', async () => {
  const app = answerWith({ interval: { start: 5, end: 2 } })
  const schema = z.object({
    interval: z
      .object({ start: z.number(), end: z.number() })
      .refine((value) => value.end > value.start, 'end must follow start'),
  })
  await expect(app.ask('Validate', { schema, retries: 0 })).rejects.toThrow('end must follow start')
})

it('returns valid structured output', async () => {
  const app = answerWith({ value: 2 })
  await expect(
    app.ask('Validate', { schema: z.object({ value: z.number().min(1) }), retries: 0 }),
  ).resolves.toEqual({ value: 2 })
})

it('applies output transforms once, including pipelines with different input and output types', async () => {
  const app = answerWith({ label: 'hello', count: '5' })
  const schema = z.object({
    label: z.string().transform((value) => value + '!'),
    count: z.string().transform(Number).pipe(z.number().min(1)),
  })
  await expect(app.ask('Validate', { schema, retries: 0 })).resolves.toEqual({
    label: 'hello!',
    count: 5,
  })
})

it('validates after coercion when the response contains a numeric string', async () => {
  const app = answerWith({ value: '2' })
  await expect(
    app.ask('Validate', { schema: z.object({ value: z.number().min(1) }), retries: 0 }),
  ).resolves.toEqual({ value: 2 })
})
