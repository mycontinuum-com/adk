import type { OpenAIModel, RealtimeModelConfig } from '../types/runnables'

import { ADAPTER, REALTIME_ADAPTER } from '../core/adapter-symbol'
import { openai as _openai } from '../providers/models'
import { OpenAIAdapter } from '../providers/openai'
import { OpenAIRealtimeTextAdapter } from '../providers/openai-realtime'

function attach<T extends object>(config: T): T {
  Object.defineProperty(config, ADAPTER, { value: () => new OpenAIAdapter() })
  Object.defineProperty(config, REALTIME_ADAPTER, { value: () => new OpenAIRealtimeTextAdapter() })
  return config
}

interface OpenAIFactory {
  (name: string, config?: Omit<OpenAIModel, 'provider' | 'name'>): OpenAIModel
  realtime: typeof _openai.realtime
}

export const openai: OpenAIFactory = Object.assign(
  (name: string, config?: Omit<OpenAIModel, 'provider' | 'name'>): OpenAIModel =>
    attach(_openai(name, config)),
  {
    realtime(...args: Parameters<typeof _openai.realtime>): RealtimeModelConfig {
      return attach(_openai.realtime(...args))
    },
  },
)

export type { OpenAIModel } from '../types/runnables'
export type { OpenAIEndpoint } from '../providers/openai-endpoints'
// The adapter seam: `new OpenAIAdapter(endpoints)` + `adk({ adapters: { openai } })` is how a
// caller injects endpoints programmatically (multi-endpoint fallback chains, or a browser page
// driving the API with the reader's own key) instead of relying on process.env.
export { OpenAIAdapter } from '../providers/openai'
export {
  serializeTools,
  serializeContext,
  parseResponse,
  serializeToolChoice,
} from '../providers/openai'
