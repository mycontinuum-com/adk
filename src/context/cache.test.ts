import type { Agent, RenderContext } from '../types'

import { agent } from '../agents'
import { openai } from '../providers'
import { BaseSession } from '../session'
import { injectCacheableSystemMessage, injectCacheableUserMessage } from './cache'
import { createStateAccessor } from './state'

const TEST_INVOCATION_ID = 'cache-test-invocation'

function createContext(): RenderContext {
  const session = new BaseSession('app', { id: 'cache-test-session' })
  const testAgent: Agent = agent({
    name: 'cache-test-agent',
    model: openai('gpt-5.6-luna'),
    context: [],
  })
  return {
    session,
    agent: testAgent,
    invocationId: TEST_INVOCATION_ID,
    agentName: testAgent.name,
    events: [],
    functionTools: [],
    providerTools: [],
    state: createStateAccessor(session, TEST_INVOCATION_ID),
  }
}

describe('cacheable context messages', () => {
  test('tags a system message as cacheable', () => {
    const result = injectCacheableSystemMessage('Stable system prefix')(createContext())

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'system',
      text: 'Stable system prefix',
      providerContext: { provider: 'adk', data: { cacheable: true } },
    })
  })

  test('tags a user message as cacheable', () => {
    const result = injectCacheableUserMessage('Stable user prefix')(createContext())

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'user',
      text: 'Stable user prefix',
      providerContext: { provider: 'adk', data: { cacheable: true } },
    })
  })
})
