import type { ChatCompletionsModel } from '../types/runnables'

export function chatCompletions(
  name: string,
  config?: Omit<ChatCompletionsModel, 'provider' | 'name'>,
): ChatCompletionsModel {
  return { ...config, provider: 'chat-completions', name }
}

export type { ChatCompletionsModel } from '../types/runnables'
export type { ChatCompletionsAdapterOptions } from '../providers/chat-completions'
export { ChatCompletionsAdapter } from '../providers/chat-completions'
