import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Questions } from '../types/decisions'
import type { OpenAIEndpoint } from './openai-endpoints'

import { DecisionsUnavailableError } from '../errors'
import { OpenAIAdapter, parseDecisionResponse } from './openai'

const INPUT = 'I was charged twice.'
const luna = { provider: 'openai' as const, name: 'gpt-6-luna' }
const mini = { provider: 'openai' as const, name: 'gpt-5.4-mini' }

const questions = {
  is_greeting: { type: 'predicate', instructions: 'Is the text a greeting?' },
  department: {
    type: 'choice',
    instructions: 'Which department should handle this?',
    choices: [{ value: 'billing', description: 'Payments.' }, { value: 'technical' }],
  },
  severity: {
    type: 'score',
    instructions: 'How severe is this issue?',
    levels: [{ label: 'Cosmetic', description: 'Appearance only.' }, { label: 'Fully blocked' }],
  },
} satisfies Questions
const greetingOnly = { is_greeting: questions.is_greeting }

const greeting = { type: 'predicate', name: 'is_greeting', probability: 0 }
const department = {
  type: 'choice',
  name: 'department',
  choice: 'billing',
  probabilities: [
    { value: 'billing', probability: 0.99 },
    { value: 'technical', probability: 0.01 },
  ],
  confidence: 0.99,
}
const severity = {
  type: 'score',
  name: 'severity',
  score: 0.9,
  probabilities: [
    { value: 0, label: 'Cosmetic', probability: 0.1 },
    { value: 1, label: 'Fully blocked', probability: 0.9 },
  ],
  confidence: 0.85,
}
/** A body in the shape `POST /v1/decisions` returned for three such questions on 2026-10-07. */
const served = {
  model: luna.name,
  answers: [greeting, department, severity],
  usage: {
    input_tokens: 395,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 395,
  },
}

const servedResponse = {
  answers: {
    is_greeting: { type: greeting.type, probability: greeting.probability },
    department: {
      type: department.type,
      choice: department.choice,
      confidence: department.confidence,
      probabilities: department.probabilities,
    },
    severity: { type: severity.type, score: severity.score, confidence: severity.confidence },
  },
  usage: {
    inputTokens: served.usage.input_tokens,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
  },
}

const UNRECOGNISED = 'unrecognised shape'
const malformed: [string, unknown, string][] = [
  ['an error body', { error: { code: 'server_error' } }, UNRECOGNISED],
  [
    'an answer type it does not know',
    { answers: [{ ...greeting, type: 'ranking' }] },
    UNRECOGNISED,
  ],
  [
    'a predicate without a probability',
    { answers: [{ type: greeting.type, name: greeting.name }] },
    UNRECOGNISED,
  ],
  [
    'two answers to one question',
    { answers: [greeting, greeting] },
    "answers 'is_greeting' more than once",
  ],
]

const KEY = 'test-key'
const BASE = 'https://eu.example.test/v1'
const OTHER_BASE = 'https://us.example.test/v1'
const endpoint: OpenAIEndpoint = { type: 'openai', baseUrl: BASE, apiKey: KEY }
const otherEndpoint: OpenAIEndpoint = { type: 'openai', baseUrl: OTHER_BASE, apiKey: KEY }
const azureEndpoint: OpenAIEndpoint = {
  type: 'azure',
  baseUrl: 'https://azure.example.test',
  apiVersion: '2025-01-01',
  apiKey: KEY,
}
const request = { input: INPUT, questions: greetingOnly }
const greeted = { answers: [greeting] }
const NOT_SERVED = { status: 404, code: 'model_not_found' }
const REFUSED_REQUEST = 'Question names must be unique within the request.'

/** A JSON response as the provider sends one. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The provider's reply for a model its decisions route does not serve. */
function notServed(): Response {
  return json(
    { error: { message: 'The model does not exist.', code: NOT_SERVED.code } },
    NOT_SERVED.status,
  )
}

/**
 * Serves `respond` as the network, so the adapter's own client builds and sends the request.
 *
 * @returns Each request the client sent, in order.
 */
function network(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; authorization: string | null; body: unknown }[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({
      url,
      authorization: new Headers(init.headers).get('authorization'),
      body: JSON.parse(String(init.body)),
    })
    return respond(url, init)
  })
  return calls
}

describe('parseDecisionResponse', () => {
  it('reads a refusal for any question type', () => {
    const refused = { answers: [{ type: 'refusal', name: department.name }] }

    expect(parseDecisionResponse(refused)).toEqual({
      answers: { department: { type: 'refusal' } },
      usage: undefined,
    })
  })

  it('answers a question named __proto__ under that name', () => {
    const name = '__proto__'
    const body = { answers: [{ ...greeting, name }] }

    const { answers } = parseDecisionResponse(body)

    expect(Object.entries(answers)).toEqual([
      [name, { type: greeting.type, probability: greeting.probability }],
    ])
  })

  it.each(malformed)('rejects %s', (_case, body, message) => {
    expect(() => parseDecisionResponse(body)).toThrow(message)
  })
})

describe('OpenAIAdapter.decide', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("posts the questions to the endpoint's decisions route and returns its answers and usage", async () => {
    const calls = network(() => json(served))
    const adapter = new OpenAIAdapter([endpoint])

    await expect(adapter.decide({ input: INPUT, questions }, luna)).resolves.toEqual(servedResponse)
    expect(calls).toEqual([
      {
        url: `${BASE}/decisions`,
        authorization: `Bearer ${KEY}`,
        body: {
          model: luna.name,
          input: INPUT,
          questions: [
            { name: 'is_greeting', ...questions.is_greeting },
            { name: 'department', ...questions.department },
            { name: 'severity', ...questions.severity },
          ],
        },
      },
    ])
  })

  it('rejects with DecisionsUnavailableError when the endpoint does not serve the model', async () => {
    const calls = network(notServed)
    const adapter = new OpenAIAdapter([endpoint])

    const rejection = await adapter.decide(request, mini).catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(DecisionsUnavailableError)
    expect(rejection).toMatchObject({
      modelName: mini.name,
      provider: mini.provider,
      message: `Decisions are not available for model '${mini.name}' (${mini.provider}): no decisions endpoint serves it`,
      cause: NOT_SERVED,
    })
    expect(calls).toHaveLength(1)
  })

  it('rejects with DecisionsUnavailableError when every endpoint is an Azure deployment', async () => {
    const calls = network(() => json(greeted))
    const adapter = new OpenAIAdapter([azureEndpoint])

    await expect(adapter.decide(request, luna)).rejects.toBeInstanceOf(DecisionsUnavailableError)
    expect(calls).toHaveLength(0)
  })

  it('skips an Azure endpoint and asks the next endpoint after a rate limit', async () => {
    const calls = network((url) =>
      url.startsWith(BASE)
        ? json({ error: { message: 'Rate limit reached' } }, 429)
        : json(greeted),
    )
    const adapter = new OpenAIAdapter([azureEndpoint, endpoint, otherEndpoint])

    await expect(adapter.decide(request, luna)).resolves.toMatchObject({
      answers: { is_greeting: { probability: greeting.probability } },
    })
    // The client retries a rate limit itself before the adapter moves on.
    expect(new Set(calls.map((c) => c.url))).toEqual(
      new Set([`${BASE}/decisions`, `${OTHER_BASE}/decisions`]),
    )
  }, 20_000)

  it('does not offer the input to another endpoint after one does not serve the model', async () => {
    const calls = network(notServed)
    const adapter = new OpenAIAdapter([endpoint, otherEndpoint])

    await expect(adapter.decide(request, luna)).rejects.toBeInstanceOf(DecisionsUnavailableError)
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/decisions`])
  })

  it('rejects with the provider error for a request the endpoint refuses', async () => {
    const calls = network(() => json({ error: { message: REFUSED_REQUEST } }, 400))
    const adapter = new OpenAIAdapter([endpoint])

    await expect(adapter.decide(request, luna)).rejects.toMatchObject({
      status: 400,
      message: `400 ${REFUSED_REQUEST}`,
    })
    expect(calls).toHaveLength(1)
  })

  it('aborts the request with the signal', async () => {
    const controller = new AbortController()
    network(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          controller.abort()
        }),
    )
    const adapter = new OpenAIAdapter([endpoint])

    await expect(adapter.decide(request, luna, controller.signal)).rejects.toThrow(
      'Request was aborted',
    )
  })
})
