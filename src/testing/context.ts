import type { StreamEvent, Event } from '../types/events'
import type { Runnable, Agent } from '../types/runnables'

import { agent } from '../agents'
import { includeHistory } from '../context'
import { BaseRunner } from '../core'
// The SDK-free descriptor from models — the providers barrel's `openai` statically drags the
// OpenAI SDK in, and /testing must load on a bare install (mocks never reach a real adapter).
import { openai } from '../providers/models'
import { BaseSession } from '../session'
import { MockAdapter } from './mock/adapter'
import {
  runTest,
  user,
  model,
  type Step,
  type TestResult,
  type MockResponseConfig,
} from './runTest'

export interface TestContext {
  agent: Runnable
  adapter: MockAdapter
  runner: BaseRunner
  respond: (...responses: MockResponseConfig[]) => TestContext
  run: (steps: Step[]) => Promise<TestResult>
  runMessage: (message: string) => Promise<TestResult>
  reset: () => void
}

export function createTestContext(agentRunnable: Runnable): TestContext {
  const adapter = new MockAdapter()
  const runner = new BaseRunner({
    adapters: { openai: adapter, gemini: adapter },
  })

  const queuedResponses: MockResponseConfig[] = []

  const context: TestContext = {
    agent: agentRunnable,
    adapter,
    runner,

    respond(...responses: MockResponseConfig[]) {
      queuedResponses.push(...responses)
      return context
    },

    async run(steps: Step[]) {
      const responseSteps: Step[] = queuedResponses.map((r) => model(r))
      const allSteps: Step[] = [...responseSteps, ...steps]
      const result = await runTest(agentRunnable, allSteps)
      queuedResponses.length = 0
      adapter.reset()
      return result
    },

    async runMessage(message: string) {
      return context.run([user(message)])
    },

    reset() {
      queuedResponses.length = 0
      adapter.reset()
    },
  }

  return context
}

export function testAgent(overrides: Partial<Omit<Agent, 'kind'>> = {}): Agent {
  return agent({
    name: 'test',
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    ...overrides,
  })
}

export function createTestSession(
  message?: string,
  options?: {
    appName?: string
    id?: string
    scopes?: Partial<Record<import('../types').SharedScope, string>>
  },
): BaseSession {
  const session = new BaseSession(options?.appName ?? 'test-app', {
    id: options?.id ?? 'test-session',
    scopes: options?.scopes,
  })
  if (message) {
    session.input.message(message)
  }
  return session
}

export function findEventsByType<T extends Event['type']>(
  events: readonly Event[],
  type: T,
): Extract<Event, { type: T }>[] {
  return events.filter((e): e is Extract<Event, { type: T }> => e.type === type)
}

export function findStreamEventsByType<T extends StreamEvent['type']>(
  events: StreamEvent[],
  type: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === type)
}

export function getLastAssistantText(events: readonly Event[]): string | undefined {
  const assistantEvents = findEventsByType(events, 'assistant')
  return assistantEvents[assistantEvents.length - 1]?.text
}

export function getToolCalls(
  events: readonly Event[],
): Array<{ name: string; args: Record<string, unknown> }> {
  return findEventsByType(events, 'tool_call').map((e) => ({
    name: e.name,
    args: e.args,
  }))
}

export function getToolResults(events: readonly Event[]): Array<{
  name: string
  result?: unknown
  error?: string
}> {
  return findEventsByType(events, 'tool_result').map((e) => ({
    name: e.name,
    result: e.result,
    error: e.error,
  }))
}

export async function collectStream<T>(
  stream: AsyncIterable<StreamEvent> & PromiseLike<T>,
): Promise<{ events: StreamEvent[]; result: T }> {
  const events: StreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  const result = await stream
  return { events, result }
}
