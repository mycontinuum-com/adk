import type { Agent } from '../../types';
import { openai } from '../../providers';
import { includeHistory } from '../../context';
import type { MockResponseConfig } from '../runTest';

export interface MockAgentConfig {
  responses?: MockResponseConfig[];
  defaultResponse?: MockResponseConfig;
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
  };

  return agent;
}

export function isMockAgent(
  agent: Agent,
): agent is Agent & { __mockConfig: MockAgentConfig } {
  return '__mockConfig' in agent;
}

export function getMockResponses(agent: Agent): MockResponseConfig[] {
  if (isMockAgent(agent)) {
    return agent.__mockConfig.responses ?? [];
  }
  return [];
}
