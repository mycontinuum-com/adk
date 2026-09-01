/**
 * `temperature` and `maxTokens` are declared on every model config (`BaseModelConfig`), but for a
 * long time only Claude's adapter read `maxTokens` and nothing read `temperature` -- the
 * non-realtime Gemini and OpenAI adapters accepted both and silently dropped them, so callers got
 * the provider default while their code said otherwise.
 *
 * That is invisible until output quality moves: a port that sets `temperature: 0.2` to match an
 * existing pipeline actually ran at Gemini's default of 1.0. These tests pin the forwarding so the
 * drop cannot come back.
 */
import { z } from 'zod'

import type { RenderContext } from '../types'

import { GeminiAdapter } from './gemini'
import { OpenAIAdapter } from './openai'

type CapturedRequest = {
  config?: {
    temperature?: number
    maxOutputTokens?: number
    thinkingConfig?: unknown
    responseSchema?: unknown
  }
}

function stubClient(capture: (request: CapturedRequest) => void) {
  return {
    models: {
      generateContentStream: async (request: CapturedRequest) => {
        capture(request)
        return (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: '{"ok":true}' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }
        })()
      },
    },
  }
}

function renderContext(): RenderContext {
  return {
    events: [{ type: 'user', text: 'hello' }],
    functionTools: [],
    invocationId: 'test-invocation',
    agentName: 'test_agent',
    agent: {},
    session: {},
  } as unknown as RenderContext
}

async function runStep(config: Record<string, unknown>): Promise<CapturedRequest> {
  const adapter = new GeminiAdapter({ apiKey: 'test-key' })
  let captured: CapturedRequest = {}
  // @ts-expect-error replacing the private client factory so no network call happens
  adapter.getClient = () => stubClient((request) => (captured = request))

  const stream = adapter.step(renderContext(), {
    provider: 'gemini',
    name: 'gemini-3.5-flash-lite',
    ...config,
  } as never)
  // Drain: the request is only issued once the generator is pulled.
  let next = await stream.next()
  while (!next.done) {
    next = await stream.next()
  }
  return captured
}

describe('Gemini sampling parameters', () => {
  it('forwards temperature to the request', async () => {
    const request = await runStep({ temperature: 0.2 })
    expect(request.config?.temperature).toBe(0.2)
  })

  it('forwards maxTokens as maxOutputTokens', async () => {
    const request = await runStep({ maxTokens: 16384 })
    expect(request.config?.maxOutputTokens).toBe(16384)
  })

  it('forwards temperature 0 rather than treating it as unset', async () => {
    const request = await runStep({ temperature: 0 })
    expect(request.config?.temperature).toBe(0)
  })

  it('omits both when the caller does not set them', async () => {
    const request = await runStep({})
    expect(request.config).not.toHaveProperty('temperature')
    expect(request.config).not.toHaveProperty('maxOutputTokens')
  })

  it('keeps forwarding them alongside structured output and thinking config', async () => {
    const adapter = new GeminiAdapter({ apiKey: 'test-key' })
    let captured: CapturedRequest = {}
    // @ts-expect-error replacing the private client factory so no network call happens
    adapter.getClient = () => stubClient((request) => (captured = request))

    const ctx = renderContext()
    // @ts-expect-error narrowing a test double
    ctx.outputSchema = z.object({ ok: z.boolean() })

    const stream = adapter.step(ctx, {
      provider: 'gemini',
      name: 'gemini-3.5-flash-lite',
      temperature: 0.2,
      maxTokens: 16384,
      thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: false },
    } as never)
    let next = await stream.next()
    while (!next.done) {
      next = await stream.next()
    }

    expect(captured.config?.temperature).toBe(0.2)
    expect(captured.config?.maxOutputTokens).toBe(16384)
    expect(captured.config?.responseSchema).toBeDefined()
  })
})

type CapturedOpenAI = { temperature?: number; reasoning?: unknown }

function stubOpenAIStream(capture: (request: CapturedOpenAI) => void) {
  return (request: CapturedOpenAI) => {
    capture(request)
    return {
      [Symbol.asyncIterator]: async function* () {},
      abort: () => {},
      finalResponse: async () => ({
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }
  }
}

async function runOpenAIStep(config: Record<string, unknown>): Promise<CapturedOpenAI> {
  const adapter = new OpenAIAdapter([{ type: 'openai', apiKey: 'test-key' }] as never)
  let captured: CapturedOpenAI = {}
  // @ts-expect-error replacing the private client factory so no network call happens
  adapter.getOrCreateClient = () => ({
    client: { responses: { stream: stubOpenAIStream((r) => (captured = r)) } },
    resolvedModel: 'gpt-4o',
  })
  const stream = adapter.step(
    {
      events: [{ type: 'user', text: 'hello' }],
      functionTools: [],
      invocationId: 'test-invocation',
      agentName: 'test_agent',
      agent: {},
      session: {},
    } as unknown as RenderContext,
    { provider: 'openai', name: 'gpt-4o', ...config } as never,
  )
  let next = await stream.next()
  while (!next.done) {
    next = await stream.next()
  }
  return captured
}

describe('OpenAI sampling parameters', () => {
  it('forwards temperature to a non-reasoning model', async () => {
    const request = await runOpenAIStep({ temperature: 0.2 })
    expect(request.temperature).toBe(0.2)
  })

  it('drops temperature when a reasoning effort is set, which those models reject', async () => {
    const request = await runOpenAIStep({
      temperature: 0.2,
      reasoning: { effort: 'medium' },
    })
    expect(request.reasoning).toBeDefined()
    expect(request).not.toHaveProperty('temperature')
  })
})
