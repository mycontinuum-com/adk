import OpenAI from 'openai'

import { ChatCompletionsCore } from './chat-completions-core'

export interface ChatCompletionsAdapterOptions {
  baseURL: string
  apiKey?: string
  fetch?: typeof globalThis.fetch
}

export class ChatCompletionsAdapter extends ChatCompletionsCore {
  constructor(options: ChatCompletionsAdapterOptions) {
    const endpoint = new URL(options.baseURL)
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error(
        'Chat Completions requires an HTTP(S) baseURL without credentials, query or fragment',
      )
    }
    const baseURL = endpoint.href.replace(/\/$/, '')
    super({
      provider: 'chat-completions',
      endpoint: baseURL,
      label: 'Chat Completions',
      client: new OpenAI({
        apiKey: options.apiKey ?? '',
        organization: null,
        project: null,
        baseURL,
        maxRetries: 0,
        defaultHeaders: options.apiKey ? undefined : { Authorization: null },
        ...(options.fetch && { fetch: options.fetch }),
      }),
    })
  }
}
