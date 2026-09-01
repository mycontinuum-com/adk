import type { GeminiModel, RealtimeModelConfig } from '../types/runnables'

import { ADAPTER, REALTIME_ADAPTER } from '../core/adapter-symbol'
import { GeminiAdapter } from '../providers/gemini'
import { GeminiRealtimeTextAdapter } from '../providers/gemini-realtime'
import { gemini as _gemini } from '../providers/models'

function attach<T extends object>(config: T): T {
  Object.defineProperty(config, ADAPTER, { value: () => new GeminiAdapter() })
  Object.defineProperty(config, REALTIME_ADAPTER, { value: () => new GeminiRealtimeTextAdapter() })
  return config
}

interface GeminiFactory {
  (name: string, config?: Omit<GeminiModel, 'provider' | 'name'>): GeminiModel
  realtime: typeof _gemini.realtime
}

export const gemini: GeminiFactory = Object.assign(
  (name: string, config?: Omit<GeminiModel, 'provider' | 'name'>): GeminiModel =>
    attach(_gemini(name, config)),
  {
    realtime(...args: Parameters<typeof _gemini.realtime>): RealtimeModelConfig {
      return attach(_gemini.realtime(...args))
    },
  },
)

export type { GeminiModel } from '../types/runnables'
export { serializeToolConfig } from '../providers/gemini'
