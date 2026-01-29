import type { Runnable, Agent, StreamEvent, RunResult, Event } from '../types';
import { BaseSession } from '../session';
import { BaseRunner } from '../core';
import { MockAdapter } from './mock/adapter';
import {
  runTest,
  user,
  model,
  type Step,
  type TestResult,
  type MockResponseConfig,
} from './runTest';
import { openai } from '../providers';
import { includeHistory } from '../context';
import { agent } from '../agents';

export interface TestContext {
  agent: Runnable;
  adapter: MockAdapter;
  runner: BaseRunner;
  respond: (...responses: MockResponseConfig[]) => TestContext;
  run: (steps: Step[]) => Promise<TestResult>;
  runMessage: (message: string) => Promise<TestResult>;
  reset: () => void;
}

export function createTestContext(agent: Runnable): TestContext {
  const adapter = new MockAdapter();
  const runner = new BaseRunner({
    adapters: { openai: adapter, gemini: adapter },
  });

  const queuedResponses: MockResponseConfig[] = [];

  const context: TestContext = {
    agent,
    adapter,
    runner,

    respond(...responses: MockResponseConfig[]) {
      queuedResponses.push(...responses);
      return context;
    },

    async run(steps: Step[]) {
      const responseSteps: Step[] = queuedResponses.map((r) => model(r));
      const allSteps: Step[] = [...responseSteps, ...steps];
      const result = await runTest(agent, allSteps);
      queuedResponses.length = 0;
      adapter.reset();
      return result;
    },

    async runMessage(message: string) {
      return context.run([user(message)]);
    },

    reset() {
      queuedResponses.length = 0;
      adapter.reset();
    },
  };

  return context;
}

export function testAgent(overrides: Partial<Omit<Agent, 'kind'>> = {}): Agent {
  return agent({
    name: 'test',
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    ...overrides,
  });
}

export function createTestSession(
  message?: string,
  options?: {
    appName?: string;
    id?: string;
    userId?: string;
    patientId?: string;
    practiceId?: string;
  },
): BaseSession {
  const session = new BaseSession(options?.appName ?? 'test-app', {
    id: options?.id ?? 'test-session',
    userId: options?.userId,
    patientId: options?.patientId,
    practiceId: options?.practiceId,
  });
  if (message) {
    session.addMessage(message);
  }
  return session;
}

export function findEventsByType<T extends Event['type']>(
  events: readonly Event[],
  type: T,
): Extract<Event, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<Event, { type: T }>[];
}

export function findStreamEventsByType<T extends StreamEvent['type']>(
  events: StreamEvent[],
  type: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<
    StreamEvent,
    { type: T }
  >[];
}

export function getLastAssistantText(
  events: readonly Event[],
): string | undefined {
  const assistantEvents = findEventsByType(events, 'assistant');
  return assistantEvents[assistantEvents.length - 1]?.text;
}

export function getToolCalls(
  events: readonly Event[],
): Array<{ name: string; args: Record<string, unknown> }> {
  return findEventsByType(events, 'tool_call').map((e) => ({
    name: e.name,
    args: e.args,
  }));
}

export function getToolResults(events: readonly Event[]): Array<{
  name: string;
  result?: unknown;
  error?: string;
}> {
  return findEventsByType(events, 'tool_result').map((e) => ({
    name: e.name,
    result: e.result,
    error: e.error,
  }));
}

export async function collectStream<T>(
  stream: AsyncIterable<StreamEvent> & PromiseLike<T>,
): Promise<{ events: StreamEvent[]; result: T }> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  const result = await stream;
  return { events, result };
}
