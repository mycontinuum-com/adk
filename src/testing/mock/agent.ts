import type { Agent } from '../../types/runnables'
import type { MockResponseConfig } from '../runTest'

import { includeHistory } from '../../context'
// The SDK-free descriptor from models — the providers barrel's `openai` statically drags the
// OpenAI SDK in, and /testing must load on a bare install (mocks never reach a real adapter).
import { openai } from '../../providers/models'

export interface MockAgentConfig {
  responses?: MockResponseConfig[]
  defaultResponse?: MockResponseConfig
}

export function mockAgent(
  name: string,
  config: MockAgentConfig = {},
): Agent & { __mockConfig: MockAgentConfig } {
  const agent: Agent & { __mockConfig: MockAgentConfig } = {
    kind: 'agent',
    name,
    description: `Mock agent: ${name}`,
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    tools: [],
    __mockConfig: config,
  }

  return agent
}

export function isMockAgent(agent: Agent): agent is Agent & { __mockConfig: MockAgentConfig } {
  return '__mockConfig' in agent
}

export function getMockResponses(agent: Agent): MockResponseConfig[] {
  if (isMockAgent(agent)) {
    return agent.__mockConfig.responses ?? []
  }
  return []
}
