import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { eurouter, EurouterAdapter } from '@animahealth/adk/eurouter'

const resultSchema = z.object({ sku: z.literal('test-widget'), quantity: z.number().int() })
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.unknown().optional(),
      tool_call_id: z.string().optional(),
      tool_calls: z.array(z.object({ id: z.string() })).optional(),
    }),
  ),
})

function syntheticTransport(model: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.url, 'https://api.eurouter.ai/api/v1/chat/completions')
    const body = requestSchema.parse(await request.json())
    assert.equal(body.model, model)
    const toolResult = body.messages.find((message) => message.role === 'tool')
    if (toolResult) {
      assert.equal(toolResult.tool_call_id, 'lookup-1')
      assert.equal(typeof toolResult.content, 'string')
      assert.deepEqual(JSON.parse(String(toolResult.content)), {
        sku: 'test-widget',
        quantity: 7,
      })
      assert.equal(
        body.messages.find((message) => message.tool_calls?.length)?.tool_calls?.[0]?.id,
        'lookup-1',
      )
    }
    const deltas = toolResult
      ? [{ content: '{"sku":"test-widget",' }, { content: '"quantity":7}' }]
      : [
          { reasoning: 'Look up the synthetic inventory before answering.' },
          {
            tool_calls: [
              {
                index: 0,
                id: 'lookup-1',
                type: 'function',
                function: { name: 'lookup_inventory', arguments: '{"sku":' },
              },
            ],
          },
          { tool_calls: [{ index: 0, function: { arguments: '"test-widget"}' } }] },
        ]
    const envelope = {
      id: toolResult ? 'local-final' : 'local-tool',
      object: 'chat.completion.chunk',
      created: 0,
      model: `synthetic/${model}`,
      provider: 'synthetic',
    }
    const chunks = [
      ...deltas.map((delta) => ({
        ...envelope,
        choices: [{ index: 0, delta, finish_reason: null }],
      })),
      {
        ...envelope,
        choices: [{ index: 0, delta: {}, finish_reason: toolResult ? 'stop' : 'tool_calls' }],
      },
      {
        ...envelope,
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    ]
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean', default: false },
      model: { type: 'string', multiple: true },
      'output-mode': { type: 'string', default: 'prompt' },
    },
  })
  const outputMode = z.enum(['native', 'prompt']).parse(values['output-mode'])
  if (values.live && !process.env.EUROUTER_API_KEY) {
    throw new Error('EUROUTER_API_KEY is required for live mode')
  }
  const models =
    values.model ??
    (values.live ? ['deepseek-v4-flash-0731'] : ['deepseek-v4-flash-0731', 'kimi-k3', 'glm-5.3'])

  for (const model of models) {
    const adapter = new EurouterAdapter(
      values.live ? {} : { apiKey: 'local-fixture-key', fetch: syntheticTransport(model) },
    )
    const app = adk({ name: 'eurouter-example', adapters: { eurouter: adapter } })
    let lookups = 0
    const lookup = app.tool({
      name: 'lookup_inventory',
      description: 'Read the synthetic inventory quantity for a SKU.',
      schema: z.object({ sku: z.literal('test-widget') }),
      execute: (ctx) => {
        lookups++
        return { sku: ctx.args.sku, quantity: 7 }
      },
    })
    const agent = app.agent({
      name: 'inventory',
      model: eurouter(model, { maxTokens: 4096 }),
      tools: [lookup],
      output: { schema: resultSchema, mode: outputMode },
      maxSteps: 3,
      context: [
        app.context.system(
          ({ outputSchema }) =>
            `Call lookup_inventory once, then return only a JSON object with its SKU and quantity. Do not include prose or markdown. Match this schema:\n${outputSchema}`,
        ),
        app.context.history(),
      ],
    })
    let streamDeltas = 0
    const started = performance.now()
    const result = await app.run(agent, {
      input: 'How many test-widget items are in stock?',
      timeout: 120_000,
      hooks: [
        {
          onEvent: (event) => {
            if (event.type === 'assistant_delta') streamDeltas++
          },
        },
      ],
    })
    assert.equal(result.status, 'completed')
    assert.equal(lookups, 1)
    assert.ok(streamDeltas > 0, 'Expected streamed assistant text')
    assert.deepEqual(result.output.value, { sku: 'test-widget', quantity: 7 })
    console.log(
      JSON.stringify({
        mode: values.live ? 'live' : 'local-fixture',
        requestedModel: model,
        outputMode,
        status: result.status,
        toolExecutions: lookups,
        streamDeltas,
        output: result.output.value,
        durationMs: Math.round(performance.now() - started),
        usage: result.usage,
      }),
    )
  }
}

main().catch(() => {
  console.error(
    'EUrouter example failed. Check the mode, credential availability, and model configuration.',
  )
  process.exitCode = 1
})
