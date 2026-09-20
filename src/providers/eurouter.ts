import OpenAI from 'openai'
import { z } from 'zod'

import type { EurouterRouting } from '../types/runnables'

import { ChatCompletionsCore } from './chat-completions-core'

export interface EurouterAdapterOptions {
  apiKey?: string
  routing?: EurouterRouting
  fetch?: typeof globalThis.fetch
}

const routingSchema = z
  .object({
    only: z.array(z.string().min(1)).nonempty().optional(),
    order: z.array(z.string().min(1)).nonempty().optional(),
    allowFallbacks: z.boolean().optional(),
    dataResidency: z.string().min(1).default('eu'),
    maxRetentionDays: z.number().int().nonnegative().default(0),
    dataCollection: z.enum(['allow', 'deny']).default('deny'),
  })
  .strict()

export class EurouterAdapter extends ChatCompletionsCore {
  constructor(options: EurouterAdapterOptions = {}) {
    const routing = routingSchema.parse(options.routing ?? {})
    const apiKey = (options.apiKey ?? process.env.EUROUTER_API_KEY)?.trim()
    if (!apiKey) throw new Error('EUrouter requires an apiKey or EUROUTER_API_KEY')
    super({
      provider: 'eurouter',
      label: 'EUrouter',
      client: new OpenAI({
        apiKey,
        baseURL: 'https://api.eurouter.ai/api/v1',
        maxRetries: 0,
        ...(options.fetch && { fetch: options.fetch }),
      }),
      requestMetadata: {
        provider: {
          ...(routing.only && { only: routing.only }),
          ...(routing.order && { order: routing.order }),
          ...(routing.allowFallbacks !== undefined && { allow_fallbacks: routing.allowFallbacks }),
          data_residency: routing.dataResidency,
          max_retention_days: routing.maxRetentionDays,
          data_collection: routing.dataCollection,
        },
      },
    })
  }
}
