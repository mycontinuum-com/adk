import { z } from 'zod'

import type {
  Event,
  ToolCallEvent,
  ModelStepResult,
  MockResponseConfig,
  OpenAIModel,
} from '../types'

import { agent } from '../agents'
import { adk } from '../api'
import { includeHistory } from '../context'
import { ADAPTER } from '../core/adapter-symbol'
import { openai } from '../providers'
import { createEventId, createCallId } from '../session'
import { InMemoryStore } from '../session/memory'
import { sessionService } from '../session/service'
import { MockAdapter } from '../testing'
import { aguiHandler } from './agui'
import { restHandler } from './rest'
import { turn } from './turn'

const app = adk()
const defaultSessionService = sessionService(new InMemoryStore())

function mockOpenAIModel(responses: MockResponseConfig[]): OpenAIModel {
  const config = {
    provider: 'openai',
    name: 'gpt-4o-mini',
  } satisfies OpenAIModel

  Object.defineProperty(config, ADAPTER, {
    value: () => new MockAdapter({ responses }),
  })

  return config
}

describe('handler.rest', () => {
  it('returns completed response', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'Hello from hook' }],
    })

    const handle = restHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
    })

    const response = await handle({ input: { message: 'Hi' } })

    expect(response.status).toBe('completed')
    expect(response.output.text).toBe('Hello from hook')
    expect(response.sessionId).toBeDefined()
  })

  it('uses provided sessionId', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'OK' }],
    })

    const handle = restHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
    })

    const response = await handle({
      sessionId: 'my-thread',
      input: { message: 'Hi' },
    })
    expect(response.sessionId).toBe('session_my-thread')
  })

  it('applies state before execution', async () => {
    let capturedMode: unknown

    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [
        {
          beforeAgent: (ctx) => {
            capturedMode = (ctx.state as Record<string, unknown>).mode
            return 'OK'
          },
        },
      ],
    })

    const handle = restHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
    })

    await handle({ input: { message: 'Hi', state: { mode: 'debug' } } })
    expect(capturedMode).toBe('debug')
  })

  it('returns error on failure', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [
        {
          beforeAgent: () => {
            throw new Error('Boom')
          },
        },
      ],
    })

    const handle = restHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
    })

    const response = await handle({ input: { message: 'Hi' } })
    expect(response.status).toBe('error')
    expect(response.error).toContain('Boom')
  })

  it('returns yielded response with toolCall', async () => {
    const askTool = app.tool({
      name: 'ask',
      description: 'Ask',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
    })

    const myAgent = agent({
      name: 'test',
      model: mockOpenAIModel([{ toolCalls: [{ name: 'ask', args: { question: 'Color?' } }] }]),
      context: [includeHistory()],
      tools: [askTool],
    })

    const handle = restHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
      hooks: [
        {
          beforeModel: (_ctx, renderCtx) => {
            const callId = createCallId()
            const tc: ToolCallEvent = {
              id: createEventId(),
              type: 'tool_call',
              createdAt: Date.now(),
              invocationId: renderCtx.invocationId,
              agentName: renderCtx.agentName,
              callId,
              name: 'ask',
              args: { question: 'Color?' },
            }
            return {
              stepEvents: [tc],
              toolCalls: [tc],
              terminal: false,
            } satisfies ModelStepResult
          },
        },
      ],
    })

    const response = await handle({ input: { message: 'Hi' } })

    expect(response.status).toBe('yielded_tool')
    expect(response.yieldedTools).toBeDefined()
    expect(response.yieldedTools![0].name).toBe('ask')
    expect(response.yieldedTools![0].args).toEqual({ question: 'Color?' })
  })

  it('skips delivery on conflict when newer message exists', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'OK' }],
    })

    const store = new InMemoryStore()
    const baseService = sessionService(store)
    const session = await baseService.createSession('test', {
      sessionId: 'thread-1',
    })
    await baseService.appendEvent(session, makeUserEvent('u-latest', Date.now() + 60_000, 'newer'))
    await baseService.commitSession(session)

    let mergeCalled = false
    const mockSessionService = {
      ...baseService,
      commitSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
      mergeSession: async () => {
        mergeCalled = true
        return {
          ok: false as const,
          conflict: true as const,
          currentVersion: 2,
        }
      },
    }

    const handle = restHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: mockSessionService,
    })

    const response = await handle({
      sessionId: 'thread-1',
      input: { message: 'Hi' },
    })

    expect(response.status).toBe('skipped')
    expect(mergeCalled).toBe(false)
  })

  it('returns warning on orphaned conflict', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'OK' }],
    })

    const store = new InMemoryStore()
    const baseService = sessionService(store)
    const session = await baseService.createSession('test', {
      sessionId: 'orphan-thread',
    })
    await baseService.commitSession(session)

    const mockSessionService = {
      ...baseService,
      commitSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
      mergeSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
    }

    const handle = restHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: mockSessionService,
    })

    const response = await handle({
      sessionId: 'orphan-thread',
      input: { message: 'Hi' },
    })

    expect(response.status).toBe('completed')
    expect(response.output.text).toBe('OK')
    expect(response.warning).toContain('concurrent session conflict')
  })
})

describe('handler.agui', () => {
  it('streams AG-UI lifecycle events', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'Hello' }],
    })

    const handle = aguiHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
    })

    const events: { type: string }[] = []
    for await (const event of handle({ input: { message: 'Hi' } })) {
      events.push(event as { type: string })
    }

    const types = events.map((e) => e.type)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types[1]).toBe('STATE_SNAPSHOT')
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
  })

  it('emits RUN_ERROR on failure', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [
        {
          beforeAgent: () => {
            throw new Error('Boom')
          },
        },
      ],
    })

    const handle = aguiHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
    })

    const events: { type: string; message?: string }[] = []
    for await (const event of handle({ input: { message: 'Hi' } })) {
      events.push(event as { type: string; message?: string })
    }

    const errorEvent = events.find((e) => e.type === 'RUN_ERROR')
    expect(errorEvent).toBeDefined()
    expect(errorEvent!.message).toContain('Boom')
  })

  it('streams tool call events and RUN_INTERRUPTED on yield', async () => {
    const askTool = app.tool({
      name: 'ask',
      description: 'Ask',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
    })

    const myAgent = agent({
      name: 'test',
      model: mockOpenAIModel([{ toolCalls: [{ name: 'ask', args: { question: 'Color?' } }] }]),
      context: [includeHistory()],
      tools: [askTool],
    })

    const handle = aguiHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
      hooks: [
        {
          beforeModel: (_ctx, renderCtx) => {
            const callId = createCallId()
            const tc: ToolCallEvent = {
              id: createEventId(),
              type: 'tool_call',
              createdAt: Date.now(),
              invocationId: renderCtx.invocationId,
              agentName: renderCtx.agentName,
              callId,
              name: 'ask',
              args: { question: 'Color?' },
            }
            return {
              stepEvents: [tc],
              toolCalls: [tc],
              terminal: false,
            } satisfies ModelStepResult
          },
        },
      ],
    })

    const events: Record<string, unknown>[] = []
    for await (const event of handle({ input: { message: 'Hi' } })) {
      events.push(event as Record<string, unknown>)
    }

    const types = events.map((e) => e.type)

    expect(types).toContain('TOOL_CALL_START')
    expect(types).toContain('TOOL_CALL_ARGS')

    const toolStart = events.find((e) => e.type === 'TOOL_CALL_START')
    expect(toolStart!.toolCallName).toBe('ask')

    expect(types).toContain('CUSTOM')
    const interrupted = events.find((e) => e.type === 'CUSTOM' && e.name === 'RUN_INTERRUPTED')
    expect(interrupted).toBeDefined()

    expect(types[types.length - 1]).toBe('RUN_FINISHED')
  })

  it('skips stream events on conflict', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'OK' }],
    })

    const store = new InMemoryStore()
    const baseService = sessionService(store)
    const session = await baseService.createSession('test', {
      sessionId: 'agui-conflict',
    })
    await baseService.appendEvent(session, makeUserEvent('u-latest', Date.now() + 60_000, 'newer'))
    await baseService.commitSession(session)

    const mockSessionService = {
      ...baseService,
      commitSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
      mergeSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
    }

    const handle = aguiHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: mockSessionService,
    })

    const events: { type: string }[] = []
    for await (const event of handle({
      sessionId: 'agui-conflict',
      input: { message: 'Hi' },
    })) {
      events.push(event as { type: string })
    }

    const types = events.map((e) => e.type)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types[1]).toBe('STATE_SNAPSHOT')
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    const runFinished = events[events.length - 1] as {
      type: string
      result?: { commitStatus?: string }
    }
    expect(runFinished.result?.commitStatus).toBe('skipped')
  })

  it('applies state and uses sessionId', async () => {
    let capturedMode: unknown

    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [
        {
          beforeAgent: (ctx) => {
            capturedMode = (ctx.state as Record<string, unknown>).mode
            return 'OK'
          },
        },
      ],
    })

    const handle = aguiHandler({
      agent: myAgent,
      appName: 'test',
      sessionService: defaultSessionService,
    })

    const events: Record<string, unknown>[] = []
    for await (const event of handle({
      sessionId: 'agui-thread',
      input: { message: 'Hi', state: { mode: 'debug' } },
    })) {
      events.push(event as Record<string, unknown>)
    }

    expect(capturedMode).toBe('debug')

    const runStarted = events.find((e) => e.type === 'RUN_STARTED')
    expect(runStarted!.threadId).toBe('session_agui-thread')

    const snapshot = events.find((e) => e.type === 'STATE_SNAPSHOT') as
      | Record<string, unknown>
      | undefined
    expect(snapshot).toBeDefined()
  })
})

describe('handler.turn', () => {
  it('streams events and resolves with commitStatus committed on success', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'Hello' }],
    })

    const turnStream = turn(
      {
        agent: myAgent,
        appName: 'test',
        sessionService: defaultSessionService,
      },
      { input: { message: 'Hi' } },
    )

    const streamed: unknown[] = []
    const it = turnStream[Symbol.asyncIterator]()
    let iterResult = await it.next()
    while (!iterResult.done) {
      streamed.push(iterResult.value)
      iterResult = await it.next()
    }
    const result = iterResult.value
    expect(result.status).toBe('completed')
    expect(result.commitStatus).toBe('committed')
    expect(result.sessionId).toBeDefined()
    expect(result.invocationId).toBe(turnStream.invocationId)
    expect(result.output.text).toBe('Hello')
    expect(streamed.length).toBeGreaterThan(0)
  })

  it('resolves with commitStatus merged on conflict then merge', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'OK' }],
    })

    const store = new InMemoryStore()
    const baseService = sessionService(store)
    await baseService.createSession('test', { sessionId: 'merge-thread' })
    await baseService.commitSession((await baseService.getSession('test', 'merge-thread'))!)

    const mockSessionService = {
      ...baseService,
      commitSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
      mergeSession: async () => ({
        ok: true as const,
        version: 2,
        merged: true,
      }),
    }

    const turnStream = turn(
      { agent: myAgent, appName: 'test', sessionService: mockSessionService },
      { sessionId: 'merge-thread', input: { message: 'Hi' } },
    )

    const result = await turnStream
    expect(result.status).toBe('completed')
    expect(result.commitStatus).toBe('merged')
  })

  it('resolves with commitStatus skipped when newer message exists', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'OK' }],
    })

    const store = new InMemoryStore()
    const baseService = sessionService(store)
    const session = await baseService.createSession('test', {
      sessionId: 'skip-thread',
    })
    await baseService.appendEvent(session, makeUserEvent('u-latest', Date.now() + 60_000, 'newer'))
    await baseService.commitSession(session)

    const mockSessionService = {
      ...baseService,
      commitSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
      mergeSession: async () => ({
        ok: false as const,
        conflict: true as const,
        currentVersion: 2,
      }),
    }

    const turnStream = turn(
      { agent: myAgent, appName: 'test', sessionService: mockSessionService },
      { sessionId: 'skip-thread', input: { message: 'Hi' } },
    )

    const result = await turnStream
    expect(result.commitStatus).toBe('skipped')
  })

  it('resolves with commitStatus undefined and skips commit when aborted', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'OK' }],
    })

    const turnStream = turn(
      { agent: myAgent, appName: 'test', sessionService: defaultSessionService },
      { input: { message: 'Hi' } },
    )

    const it = turnStream[Symbol.asyncIterator]()
    await it.next()
    turnStream.abort()
    let iterResult = await it.next()
    while (!iterResult.done) {
      iterResult = await it.next()
    }
    const result = iterResult.value
    expect(result.status).toBe('aborted')
    expect(result.commitStatus).toBeUndefined()
  })

  it('resolves with status error and no commitStatus on lifecycle error', async () => {
    const myAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [
        {
          beforeAgent: () => {
            throw new Error('Boom')
          },
        },
      ],
    })

    const turnStream = turn(
      { agent: myAgent, appName: 'test', sessionService: defaultSessionService },
      { input: { message: 'Hi' } },
    )

    const result = await turnStream
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error).toContain('Boom')
    }
    expect(result.commitStatus).toBeUndefined()
  })
})

function makeUserEvent(id: string, createdAt: number, text: string): Event {
  return { id, type: 'user', createdAt, text } as Event
}

function makeAssistantEvent(id: string, createdAt: number, text: string): Event {
  return {
    id,
    type: 'assistant',
    createdAt,
    text,
    invocationId: 'inv-1',
    agentName: 'test',
  } as Event
}

describe('commitSession merge-on-conflict', () => {
  it('returns ok without merged flag on clean commit', async () => {
    const store = new InMemoryStore()
    const service = sessionService(store)
    const session = await service.createSession('app')

    await service.appendEvent(session, makeUserEvent('u1', 100, 'hello'))

    const result = await service.commitSession(session)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.merged).toBeUndefined()
    }
  })

  it('auto-merges on conflict and returns merged flag', async () => {
    const store = new InMemoryStore()
    const service = sessionService(store)
    const session = await service.createSession('app')

    await service.appendEvent(session, makeUserEvent('u1', 100, 'hello'))
    await service.appendEvent(session, makeAssistantEvent('a1', 200, 'Hi there'))

    await store.commit(
      {
        id: session.id,
        appName: 'app',
        version: 1,
        scopes: {},
        createdAt: Date.now(),
      },
      [makeAssistantEvent('concurrent-a', 150, 'concurrent response')],
      1,
    )

    const result = await service.commitSession(session)
    expect(result.ok).toBe(false)
    const merged = await service.mergeSession(session)
    expect(merged.ok).toBe(true)
    if (merged.ok) {
      expect(merged.merged).toBe(true)
    }

    const reloaded = await service.getSession('app', session.id)
    expect(reloaded!.events).toHaveLength(3)
  })

  it('returns conflict when session was deleted', async () => {
    const store = new InMemoryStore()
    const service = sessionService(store)
    const session = await service.createSession('app')

    await service.appendEvent(session, makeUserEvent('u1', 100, 'hello'))

    await store.delete('app', session.id)

    const result = await service.commitSession(session)
    expect(result.ok).toBe(false)
  })

  it('merges successfully even when store is multiple versions ahead', async () => {
    const store = new InMemoryStore()
    const service = sessionService(store)
    const session = await service.createSession('app')

    await service.appendEvent(session, makeUserEvent('u1', 100, 'hello'))

    await store.commit(
      {
        id: session.id,
        appName: 'app',
        version: 1,
        scopes: {},
        createdAt: Date.now(),
      },
      [],
      1,
    )
    await store.commit(
      {
        id: session.id,
        appName: 'app',
        version: 2,
        scopes: {},
        createdAt: Date.now(),
      },
      [],
      2,
    )

    const result = await service.mergeSession(session)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.merged).toBe(true)
    }
  })

  it('preserves events from both executions after merge', async () => {
    const store = new InMemoryStore()
    const service = sessionService(store)
    const session = await service.createSession('app')

    await service.appendEvent(session, makeUserEvent('u1', 100, 'hello'))
    await service.appendEvent(session, makeAssistantEvent('a1', 200, 'response'))

    await store.commit(
      {
        id: session.id,
        appName: 'app',
        version: 1,
        scopes: {},
        createdAt: Date.now(),
      },
      [
        makeUserEvent('u2', 300, 'concurrent msg'),
        makeAssistantEvent('a2', 400, 'concurrent response'),
      ],
      1,
    )

    const result = await service.mergeSession(session)
    expect(result.ok).toBe(true)

    const final = await service.getSession('app', session.id)
    expect(final!.events).toHaveLength(4)
    expect(final!.events.map((e) => e.id)).toEqual(['u2', 'a2', 'u1', 'a1'])
  })
})
