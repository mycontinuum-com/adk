import { z } from 'zod'

import { adk } from '../api/app'
import { GeminiAdapter, serializeTools } from './gemini'
import { gemini } from './models'

afterEach(() => vi.unstubAllGlobals())

it('sends Zod JSON Schema through the actual SDK JSON Schema field', async () => {
  let body: unknown
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body))
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: '{"kind":"count","value":7}' }] },
          finishReason: 'STOP',
        },
      ],
    }
    return new Response(`data: ${JSON.stringify(response)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  const schema = z.object({ kind: z.literal('count'), value: z.number().min(1) })
  const app = adk({
    defaultModel: gemini('synthetic'),
    adapters: { gemini: new GeminiAdapter('synthetic-test-key') },
  })
  await expect(app.ask('Test', { schema, retries: 0 })).resolves.toEqual({
    kind: 'count',
    value: 7,
  })
  const config = z
    .object({
      generationConfig: z.object({
        responseJsonSchema: z.unknown(),
        responseSchema: z.unknown().optional(),
      }),
    })
    .parse(body).generationConfig
  expect(config.responseJsonSchema).toMatchObject({
    properties: { kind: { const: 'count' }, value: { minimum: 1 } },
  })
  expect(config.responseSchema).toBeUndefined()
})

it('keeps literal and additional-property constraints in function JSON Schema', () => {
  const app = adk()
  const tool = app.tool({
    name: 'count',
    description: 'Count',
    schema: z.object({ kind: z.literal('count'), value: z.number() }),
    execute: (ctx) => ctx.args,
  })
  expect(serializeTools([tool])).toEqual([
    {
      functionDeclarations: [
        {
          name: 'count',
          description: 'Count',
          parametersJsonSchema: {
            type: 'object',
            properties: { kind: { type: 'string', const: 'count' }, value: { type: 'number' } },
            required: ['kind', 'value'],
            additionalProperties: false,
          },
        },
      ],
    },
  ])
})
