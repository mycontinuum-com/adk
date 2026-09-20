import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { chatCompletions, ChatCompletionsAdapter } from '@animahealth/adk/chat-completions'
import { SQLiteStore } from '@animahealth/adk/stores/sqlite'

const reasoningMessage = z
  .object({
    role: z.string(),
    reasoning: z.string().optional(),
    reasoning_content: z.string().optional(),
    reasoning_details: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  })
  .passthrough()
const requestSchema = z.object({ model: z.string(), messages: z.array(reasoningMessage) })
const outputSchema = z.object({ quantity: z.number().int() })

async function main() {
  const { values } = parseArgs({
    options: {
      endpoint: { type: 'string', default: 'http://127.0.0.1:30000/v1' },
      model: { type: 'string', default: 'Qwen/Qwen3.8-27B' },
    },
  })
  const endpoint = new URL(values.endpoint)
  assert.ok(
    ['127.0.0.1', '[::1]'].includes(endpoint.hostname),
    'Use a private tunnel with a loopback endpoint',
  )
  const directory = mkdtempSync(join(tmpdir(), 'adk-self-hosted-'))
  const path = join(directory, 'session.db')
  const sentReasoning: string[][] = []
  let checkingCancellation = false
  let fetchAbortObserved = false
  let streamDeltas = 0
  let lookups = 0
  let currentQuantity = 7
  let store = new SQLiteStore(path)
  const capture: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = requestSchema.parse(await request.clone().json())
    assert.equal(body.model, values.model)
    const hashes = body.messages
      .filter(
        (message) =>
          message.role === 'assistant' &&
          (message.reasoning !== undefined ||
            message.reasoning_content !== undefined ||
            message.reasoning_details !== undefined),
      )
      .map((message) => createHash('sha256').update(JSON.stringify(message)).digest('hex'))
    sentReasoning.push(hashes)
    if (checkingCancellation) {
      request.signal.addEventListener(
        'abort',
        () => {
          fetchAbortObserved = true
        },
        { once: true },
      )
    }
    return fetch(request)
  }
  const createApp = () => {
    const app = adk({
      name: 'self-hosted-example',
      store,
      adapters: {
        'chat-completions': new ChatCompletionsAdapter({ baseURL: endpoint.href, fetch: capture }),
      },
    })
    const lookup = app.tool({
      name: 'lookup_inventory',
      description: 'Read the current synthetic inventory quantity.',
      schema: z.object({ sku: z.literal('test-widget') }),
      execute: () => {
        lookups++
        return { sku: 'test-widget', quantity: currentQuantity }
      },
    })
    const agent = app.agent({
      name: 'inventory',
      model: chatCompletions(values.model, {
        maxTokens: 8192,
        chatTemplate: { reasoning_effort: 'xhigh', preserve_thinking: true },
      }),
      tools: [lookup],
      output: { schema: outputSchema, mode: 'prompt' },
      maxSteps: 3,
      context: [
        app.context.system(
          ({ outputSchema: schemaText }) =>
            `For each user request call lookup_inventory exactly once. Return only a JSON object containing its current quantity. Match this schema: ${schemaText}`,
        ),
        app.context.history(),
      ],
    })
    return { app, agent }
  }
  try {
    const first = createApp()
    const session = await first.app.sessions.create()
    const firstResult = await first.app.run(first.agent, {
      session,
      input: 'Check the current test-widget inventory.',
      timeout: 300_000,
      hooks: [
        {
          onEvent: (event) => {
            if (event.type === 'assistant_delta') streamDeltas++
          },
        },
      ],
    })
    assert.equal(firstResult.status, 'completed')
    assert.deepEqual(firstResult.output.value, { quantity: 7 })
    assert.equal(lookups, 1)
    const priorHashes = sentReasoning.at(-1) ?? []
    assert.ok(priorHashes.length > 0, 'Expected reasoning replay after the first tool call')
    const committed = await first.app.sessions.commit(session)
    assert.ok(committed.ok, 'Expected saved session')
    await store.close()
    store = new SQLiteStore(path)
    currentQuantity = 11
    const beforeReloadRequests = sentReasoning.length
    const second = createApp()
    const restored = await second.app.sessions.get(session.id)
    assert.ok(restored, 'Expected session reload')
    const secondResult = await second.app.run(second.agent, {
      session: restored,
      input: 'Check again. The inventory may have changed.',
      timeout: 300_000,
      hooks: [
        {
          onEvent: (event) => {
            if (event.type === 'assistant_delta') streamDeltas++
          },
        },
      ],
    })
    assert.equal(secondResult.status, 'completed')
    assert.deepEqual(secondResult.output.value, { quantity: 11 })
    assert.equal(lookups, 2)
    const replayed = sentReasoning[beforeReloadRequests]
    assert.ok(replayed)
    assert.deepEqual(
      replayed.slice(0, priorHashes.length),
      priorHashes,
      'Reasoning messages changed across SQLite reload',
    )
    assert.ok(streamDeltas > 0, 'Expected streamed assistant deltas')
    checkingCancellation = true
    let cancellationRequested = false
    const callsBeforeCancellation = sentReasoning.length
    const cancellation = second.app.run(second.agent, {
      input: 'Check the current test-widget inventory once more.',
      timeout: 300_000,
      hooks: [
        {
          onEvent: (event) => {
            if (
              !cancellationRequested &&
              (event.type === 'thought_delta' || event.type === 'assistant_delta')
            ) {
              cancellationRequested = true
              cancellation.abort()
            }
          },
        },
      ],
    })
    await assert.rejects(Promise.resolve(cancellation), /abort/i)
    assert.ok(cancellationRequested, 'Expected cancellation on the first streamed delta')
    assert.ok(fetchAbortObserved, 'Expected the HTTP request signal to observe cancellation')
    assert.equal(lookups, 2, 'Cancelled generation must not execute another tool')
    assert.equal(
      sentReasoning.length,
      callsBeforeCancellation + 1,
      'Cancelled generation must not retry',
    )
    console.log(
      JSON.stringify({
        model: values.model,
        status: 'passed',
        toolExecutions: lookups,
        streamDeltas,
        modelCalls: sentReasoning.length,
        reasoningMessagesAfterTool: priorHashes.length,
        reasoningMessagesAfterReload: replayed.length,
        outputs: [7, 11],
        cancellation: { aborted: true, fetchAbortObserved, additionalToolExecutions: 0 },
      }),
    )
  } finally {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Self-hosted verification failed')
  process.exitCode = 1
})
