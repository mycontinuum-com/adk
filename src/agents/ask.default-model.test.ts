/**
 * Workflow.ask-default-model — Ask Uses App Default Model
 *
 * The ephemeral agent is constructed with opts.model ?? app.defaultModel. Omitting opts.model MUST
 * NOT fall back to a hardcoded or first-registered provider.
 *
 * Evidence: unit test
 */
import { describe, it, expect } from 'vitest'

import { adk } from '../api/app'
import { openai } from '../providers/models'
import { MockAdapter } from '../testing'

describe('workflow.ask-default-model', () => {
  it('omitting opts.model uses app.defaultModel', async () => {
    const defaultModel = openai('gpt-default-test')
    const mockAdapter = new MockAdapter({ responses: [] })
    const capturedModelNames: string[] = []

    const captureAdapter = new Proxy(mockAdapter, {
      get(target, prop) {
        if (prop === 'step') {
          return async function* (ctx: any, config: any, signal?: AbortSignal) {
            // Capture the model name that was used
            capturedModelNames.push(config.name)
            return yield* target.step(ctx, config, signal)
          }
        }
        return (target as any)[prop]
      },
    })

    mockAdapter.setResponses([{ text: 'default model response' }])

    const app = adk({
      name: 'default-model-test',
      adapters: { openai: captureAdapter },
      defaultModel,
    })

    await app.ask('hello')

    // The model used should be the app's configured default
    expect(capturedModelNames).toHaveLength(1)
    expect(capturedModelNames[0]).toBe('gpt-default-test')
  })

  it('explicit opts.model overrides the app default', async () => {
    const defaultModel = openai('gpt-default')
    const explicitModel = openai('gpt-explicit')
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

    mockAdapter.setResponses([{ text: 'explicit model response' }])

    const app = adk({
      name: 'explicit-model-test',
      adapters: { openai: captureAdapter },
      defaultModel,
    })

    await app.ask('hello', { model: explicitModel })

    // The model used should be the explicitly passed one
    expect(capturedModelNames).toHaveLength(1)
    expect(capturedModelNames[0]).toBe('gpt-explicit')
  })

  it('app.ask without opts.model and without defaultModel throws', async () => {
    const mockAdapter = new MockAdapter({ responses: [{ text: 'response' }] })

    // App with NO defaultModel configured
    const app = adk({
      name: 'no-default-model',
      adapters: { openai: mockAdapter },
      // defaultModel intentionally NOT set
    })

    await expect(app.ask('hello')).rejects.toThrow('no model configured')
  })

  it('app.defaultModel property is accessible on the app instance', () => {
    const model = openai('gpt-4o-mini')
    const app = adk({ defaultModel: model })
    expect(app.defaultModel).toBe(model)
  })
})
