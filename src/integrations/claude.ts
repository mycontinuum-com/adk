import type { ClaudeModel } from '../types/runnables'

import { ADAPTER } from '../core/adapter-symbol'
import { ClaudeAdapter } from '../providers/claude'
import { claude as _claude } from '../providers/models'

export function claude(name: string, config: Omit<ClaudeModel, 'provider' | 'name'>): ClaudeModel {
  const result = _claude(name, config)
  Object.defineProperty(result, ADAPTER, { value: () => new ClaudeAdapter() })
  return result
}

export type { ClaudeModel } from '../types/runnables'
