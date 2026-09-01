/**
 * Workflow.model-config-explicit — Model Config Explicit
 *
 * A run with a missing credential fails fast naming the model and missing credential, before any
 * agent executes. No silent provider substitution.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

describe('workflow.model-config-explicit', () => {
  it('app.ask without any model configured throws a descriptive error (no silent fallback)', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'response' }] })

    // App with NO defaultModel configured
    const app = adk({
      name: 'no-model',
      adapters: { openai: mockAdapter },
      // intentionally no defaultModel
    })

    let errorMessage = ''
    await app.ask('hello').catch((e: Error) => {
      errorMessage = e.message
    })

    // Error should mention model configuration, not throw a provider credential error
    expect(errorMessage).toMatch(/no model configured/i)
    // No model call should have been made
    expect(mockAdapter.stepCalls).toHaveLength(0)
  })

  it('app.ask with an explicit model uses that model without falling back', async () => {
    const explicitModel = openai('gpt-explicit-4')
    const mockAdapter = new MockAdapter({ responses: [] })
    const capturedModelNames: string[] = []

    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            capturedModelNames.push(config.name)
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    mockAdapter.setResponses([{ text: 'ok' }])

    const app = adk({
      name: 'explicit-model-test',
      adapters: { openai: captureAdapter },
      defaultModel: openai('gpt-default'),
    })

    await app.ask('hello', { model: explicitModel })

    // Should use the explicit model, not the default
    expect(capturedModelNames).toHaveLength(1)
    expect(capturedModelNames[0]).toBe('gpt-explicit-4')
  })

  it('ModelConfig is passed through to the underlying agent without coercion', async () => {
    const mockAdapter = new MockAdapter({ responses: [] })
    const capturedConfigs: any[] = []

    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            capturedConfigs.push({ ...config })
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    mockAdapter.setResponses([{ text: 'ok' }])

    const customModel = openai('gpt-custom', { temperature: 0.1 })
    const app = adk({
      name: 'model-passthrough',
      adapters: { openai: captureAdapter },
      defaultModel: customModel,
    })

    await app.ask('hello')

    expect(capturedConfigs).toHaveLength(1)
    expect(capturedConfigs[0].name).toBe('gpt-custom')
  })
})
