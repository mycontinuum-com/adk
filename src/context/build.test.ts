import type { Event, RenderContext, Agent } from '../types'

import { agent } from '../agents'
import { openai } from '../providers'
import { BaseSession } from '../session'
import {
  injectSystemMessage,
  includeHistory,
  selectRecentEvents,
  pruneReasoning,
  createRenderContext,
  buildContext,
  createStateAccessor,
  transformUserMessages,
} from './index'

const TEST_INV_ID = 'test-invocation-id'

describe('injectSystemMessage', () => {
  const createMinimalAgent = (): Agent =>
    agent({ name: 'test', model: openai('gpt-4o-mini'), context: [] })

  const createContext = (session: BaseSession): RenderContext => ({
    session,
    agent: createMinimalAgent(),
    invocationId: TEST_INV_ID,
    agentName: 'test',
    events: [],
    functionTools: [],
    providerTools: [],
    state: createStateAccessor(session, TEST_INV_ID),
  })

  test('injects static instruction as system event', () => {
    const ctx = createContext(new BaseSession('app', { id: 'test' }))
    const result = injectSystemMessage('You are a helpful assistant.')(ctx)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'system',
      text: 'You are a helpful assistant.',
    })
  })

  test('appends instruction to existing events', () => {
    const ctx: RenderContext = {
      ...createContext(new BaseSession('app', { id: 'test' })),
      events: [{ id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' }],
    }
    const result = injectSystemMessage('System prompt.')(ctx)

    expect(result.events).toHaveLength(2)
    expect(result.events.map((e) => e.type)).toEqual(['user', 'system'])
  })
})

describe('includeHistory', () => {
  const createMinimalAgent = (): Agent =>
    agent({ name: 'test', model: openai('gpt-4o-mini'), context: [] })

  const createCtx = (
    session: BaseSession,
    invocationId: string = TEST_INV_ID,
    events: Event[] = [],
  ): RenderContext => ({
    session,
    agent: createMinimalAgent(),
    invocationId,
    agentName: 'test',
    events,
    functionTools: [],
    providerTools: [],
    state: createStateAccessor(session, invocationId),
  })

  test('defaults to direct scope, includes non-handoff events', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    })
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: TEST_INV_ID,
      agentName: 'test',
      text: 'Hi!',
    } as Event)
    const ctx = createCtx(session, undefined, [
      {
        id: '0',
        type: 'system',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'System',
      },
    ])

    const result = includeHistory()(ctx)
    expect(result.events.map((e) => e.type)).toEqual(['system', 'user', 'assistant'])
  })

  test('direct scope excludes child handoff events', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    })
    session.pushEvent({
      id: '2',
      type: 'tool_call',
      createdAt: Date.now(),
      invocationId: 'parent-inv',
      agentName: 'test',
      callId: 'c1',
      name: 'delegate',
      args: {},
    } as Event)
    session.pushEvent({
      id: '3',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      kind: 'agent',
      parentInvocationId: 'parent-inv',
      handoffOrigin: {
        type: 'run',
        invocationId: 'parent-inv',
        callId: 'c1',
      },
    } as Event)
    session.pushEvent({
      id: '4',
      type: 'user',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      text: 'Delegation instruction',
    })
    session.pushEvent({
      id: '5',
      type: 'tool_call',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      callId: 'c2',
      name: 'some_tool',
      args: {},
    } as Event)
    session.pushEvent({
      id: '6',
      type: 'tool_result',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      callId: 'c2',
      name: 'some_tool',
      result: 'done',
    } as Event)
    session.pushEvent({
      id: '7',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      text: 'Child response',
    } as Event)
    session.pushEvent({
      id: '8',
      type: 'tool_result',
      createdAt: Date.now(),
      invocationId: 'parent-inv',
      agentName: 'test',
      callId: 'c1',
      name: 'delegate',
      result: 'done',
    } as Event)

    const result = includeHistory()(createCtx(session, 'parent-inv'))
    expect(result.events.map((e) => e.id)).toEqual(['1', '2', '8'])
  })

  test('direct scope isolates called agents to own invocation', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'parent-inv',
      agentName: 'parent',
      kind: 'agent',
    } as Event)
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'parent-inv',
      agentName: 'parent',
      text: 'Parent thinking',
    } as Event)
    session.pushEvent({
      id: '3',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      kind: 'agent',
      parentInvocationId: 'parent-inv',
      handoffOrigin: {
        type: 'run',
        invocationId: 'parent-inv',
        callId: 'c1',
      },
    } as Event)
    session.pushEvent({
      id: '4',
      type: 'user',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      text: 'Task for child',
    })
    session.pushEvent({
      id: '5',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      text: 'Child result',
    } as Event)

    const result = includeHistory()(createCtx(session, 'child-inv'))
    expect(result.events.map((e) => e.id)).toEqual(['3', '4', '5'])
    expect(result.events.every((e) => !e.invocationId || e.invocationId === 'child-inv')).toBe(true)
  })

  test('direct scope includes cross-turn roots for root agents', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'turn1-root',
      agentName: 'coordinator',
      kind: 'agent',
    } as Event)
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'turn1-root',
      agentName: 'coordinator',
      text: 'Turn 1 response',
    } as Event)
    session.pushEvent({
      id: '3',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'turn2-root',
      agentName: 'coordinator',
      kind: 'agent',
    } as Event)
    session.pushEvent({
      id: '4',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'turn2-root',
      agentName: 'coordinator',
      text: 'Turn 2 response',
    } as Event)

    const result = includeHistory()(createCtx(session, 'turn2-root'))
    expect(result.events.map((e) => e.id)).toEqual(['1', '2', '3', '4'])
  })

  test('direct scope includes roots for transfer targets', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'root-inv',
      agentName: 'coordinator',
      kind: 'agent',
    } as Event)
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'root-inv',
      agentName: 'coordinator',
      text: 'Transferring',
    } as Event)
    session.pushEvent({
      id: '3',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'transfer-inv',
      agentName: 'specialist',
      kind: 'agent',
      parentInvocationId: 'root-inv',
      handoffOrigin: { type: 'transfer', invocationId: 'root-inv' },
    } as Event)
    session.pushEvent({
      id: '4',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'transfer-inv',
      agentName: 'specialist',
      text: 'Specialist response',
    } as Event)

    const result = includeHistory()(createCtx(session, 'transfer-inv'))
    expect(result.events.map((e) => e.id)).toEqual(['1', '2', '3', '4'])
  })

  test('scope: all includes everything including child handoff events', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    })
    session.pushEvent({
      id: '2',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      kind: 'agent',
      parentInvocationId: 'parent-inv',
      handoffOrigin: { type: 'run', invocationId: 'parent-inv', callId: 'c1' },
    } as Event)
    session.pushEvent({
      id: '3',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      text: 'Child response',
    } as Event)

    const result = includeHistory({ scope: 'all' })(createCtx(session, 'parent-inv'))
    expect(result.events.map((e) => e.id)).toEqual(['1', '2', '3'])
  })

  test('scope: agent excludes child handoff events', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    })
    session.pushEvent({
      id: '2',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'child',
      kind: 'agent',
      parentInvocationId: 'parent-inv',
      handoffOrigin: { type: 'run', invocationId: 'parent-inv', callId: 'c1' },
    } as Event)
    session.pushEvent({
      id: '3',
      type: 'user',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      text: 'Child instruction',
    })
    session.pushEvent({
      id: '4',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'parent-inv',
      agentName: 'test',
      text: 'My response',
    } as Event)

    const result = includeHistory({ scope: 'agent' })(createCtx(session, 'parent-inv'))
    const ids = result.events.map((e) => e.id)
    expect(ids).toContain('1')
    expect(ids).toContain('4')
    expect(ids).not.toContain('3')
  })

  test('scope: current filters to current invocation', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    })
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      text: 'Hi',
      invocationId: 'inv1',
      agentName: 'test',
    })
    session.pushEvent({
      id: '3',
      type: 'user',
      createdAt: Date.now(),
      text: 'More',
      invocationId: 'inv2',
    })

    const result = includeHistory({ scope: 'invocation' })(createCtx(session, 'inv1'))
    expect(result.events.map((e) => e.id)).toEqual(['1', '2'])
  })

  test('scope: ancestors includes parent chain and cross-turn roots but excludes siblings', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    })
    session.pushEvent({
      id: 'p-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'parent',
      agentName: 'p',
      kind: 'agent',
    })
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      text: 'Parent',
      invocationId: 'parent',
      agentName: 'p',
    })
    session.pushEvent({
      id: 'c-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'child',
      agentName: 'c',
      parentInvocationId: 'parent',
      kind: 'agent',
      handoffOrigin: { type: 'run', invocationId: 'parent', callId: 'c1' },
    } as Event)
    session.pushEvent({
      id: '3',
      type: 'user',
      createdAt: Date.now(),
      text: 'Child',
      invocationId: 'child',
    })
    session.pushEvent({
      id: 's-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'sibling',
      agentName: 's',
      parentInvocationId: 'parent',
      kind: 'agent',
      handoffOrigin: { type: 'run', invocationId: 'parent', callId: 'c2' },
    } as Event)
    session.pushEvent({
      id: '4',
      type: 'assistant',
      createdAt: Date.now(),
      text: 'Sibling',
      invocationId: 'sibling',
      agentName: 's',
    })

    const result = includeHistory({ scope: 'ancestors' })(createCtx(session, 'child'))
    const ids = result.events.map((e) => e.id)

    expect(ids).toContain('1')
    expect(ids).toContain('p-start')
    expect(ids).toContain('2')
    expect(ids).toContain('3')
    expect(ids).not.toContain('4')
  })

  test('scope: ancestors includes cross-turn root events for called agents', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.pushEvent({
      id: 't1-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'turn1-root',
      agentName: 'coordinator',
      kind: 'agent',
    } as Event)
    session.pushEvent({
      id: '1',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'turn1-root',
      agentName: 'coordinator',
      text: 'Turn 1',
    } as Event)
    session.pushEvent({
      id: 't2-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'turn2-root',
      agentName: 'coordinator',
      kind: 'agent',
    } as Event)
    session.pushEvent({
      id: 'child-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'researcher',
      kind: 'agent',
      parentInvocationId: 'turn2-root',
      handoffOrigin: { type: 'run', invocationId: 'turn2-root', callId: 'c1' },
    } as Event)
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: 'child-inv',
      agentName: 'researcher',
      text: 'Research result',
    } as Event)

    const result = includeHistory({ scope: 'ancestors' })(createCtx(session, 'child-inv'))
    const ids = result.events.map((e) => e.id)

    expect(ids).toContain('t1-start')
    expect(ids).toContain('1')
    expect(ids).toContain('t2-start')
    expect(ids).toContain('2')
  })
})

describe('selectRecentEvents', () => {
  const createCtx = (events: Event[]): RenderContext => {
    const session = new BaseSession('app', { id: 'test' })
    return {
      session,
      agent: agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [],
      }),
      invocationId: TEST_INV_ID,
      agentName: 'test',
      events,
      functionTools: [],
      providerTools: [],
      state: createStateAccessor(session, TEST_INV_ID),
    }
  }

  test('limits non-system events but preserves system events', () => {
    const events: Event[] = [
      {
        id: 's1',
        type: 'system',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'System',
      },
      { id: '1', type: 'user', createdAt: Date.now(), text: 'First' },
      {
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Second',
      },
      { id: '3', type: 'user', createdAt: Date.now(), text: 'Third' },
      {
        id: '4',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Fourth',
      },
    ]

    const result = selectRecentEvents(2)(createCtx(events))
    expect(result.events.map((e) => e.id)).toEqual(['s1', '3', '4'])
  })

  test('preserves all events if under limit', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'First' },
      {
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Second',
      },
    ]

    expect(selectRecentEvents(5)(createCtx(events)).events).toHaveLength(2)
  })

  test('does not count internal bookkeeping events toward the limit', () => {
    const events: Event[] = [
      {
        id: 's1',
        type: 'system',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'System',
      },
      // A bunch of non-prompt events that historically caused early truncation
      {
        id: 'm1',
        type: 'model_start',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        stepIndex: 0,
        messageCount: 0,
        tools: [],
      } as any,
      {
        id: 'm2',
        type: 'model_end',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        stepIndex: 0,
        durationMs: 1,
      } as any,
      { id: '1', type: 'user', createdAt: Date.now(), text: 'First' },
      {
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Second',
      },
      { id: '3', type: 'user', createdAt: Date.now(), text: 'Third' },
    ]

    const result = selectRecentEvents(2)(createCtx(events))
    expect(result.events.map((e) => e.id)).toEqual(['s1', '2', '3'])
  })

  test('preserves tool_call + tool_result integrity even when truncated', () => {
    const events: Event[] = [
      {
        id: 's1',
        type: 'system',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'System',
      },
      { id: 'u1', type: 'user', createdAt: Date.now(), text: 'Hi' },
      {
        id: 'tc',
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        callId: 'call-1',
        name: 'some_tool',
        args: {},
      } as any,
      // Lots of internal events that would push tc out of a naive slice window
      ...(Array.from({ length: 100 }).map((_, i) => ({
        id: `bk-${i}`,
        type: 'invocation_end',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        reason: 'completed',
      })) as any),
      {
        id: 'tr',
        type: 'tool_result',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        callId: 'call-1',
        name: 'some_tool',
        result: { ok: true },
      } as any,
      {
        id: 'a1',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Done',
      },
    ]

    const result = selectRecentEvents(3)(createCtx(events))
    expect(result.events.map((e) => e.id)).toContain('tc')
    expect(result.events.map((e) => e.id)).toContain('tr')
    expect(result.events[0].id).toBe('s1')
  })
})

describe('pruneReasoning', () => {
  test('removes thought events', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' },
      {
        id: '2',
        type: 'thought',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Thinking...',
      },
      {
        id: '3',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Response',
      },
    ]

    const session = new BaseSession('app', { id: 'test' })
    const ctx: RenderContext = {
      session,
      agent: agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [],
      }),
      invocationId: TEST_INV_ID,
      agentName: 'test',
      events,
      functionTools: [],
      providerTools: [],
      state: createStateAccessor(session, TEST_INV_ID),
    }

    expect(pruneReasoning()(ctx).events.map((e) => e.type)).toEqual(['user', 'assistant'])
  })
})

describe('createRenderContext', () => {
  test('creates initial context from session and agent', () => {
    const session = new BaseSession('app', { id: 'test' })
    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [],
    })
    const ctx = createRenderContext(session, testAgent, 'inv-123')

    expect(ctx.session).toBe(session)
    expect(ctx.invocationId).toBe('inv-123')
    expect(ctx.events).toEqual([])
  })
})

describe('buildContext', () => {
  test('composes context renderers in order', () => {
    const session = new BaseSession('app', { id: 'test' })
    session.input.message('Hello')

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [injectSystemMessage('System prompt'), includeHistory()],
    })

    const ctx = buildContext(session, testAgent, 'inv-123')
    expect(ctx.events[0]).toMatchObject({
      type: 'system',
      text: 'System prompt',
    })
    expect(ctx.events[1]).toMatchObject({ type: 'user', text: 'Hello' })
  })

  test('empty context array produces empty events', () => {
    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [],
    })
    expect(
      buildContext(new BaseSession('app', { id: 'test' }), testAgent, TEST_INV_ID).events,
    ).toEqual([])
  })
})

describe('transformUserMessages', () => {
  const createMinimalAgent = (): Agent =>
    agent({ name: 'test', model: openai('gpt-4o-mini'), context: [] })

  const createCtx = (
    session: BaseSession,
    events: Event[] = [],
    agentName = 'test',
  ): RenderContext => ({
    session,
    agent: createMinimalAgent(),
    invocationId: TEST_INV_ID,
    agentName,
    events,
    functionTools: [],
    providerTools: [],
    state: createStateAccessor(session, TEST_INV_ID),
  })

  test('wraps user messages with transform function', () => {
    const session = new BaseSession('app', { id: 'test' })
    const events: Event[] = [{ id: 'u1', type: 'user', createdAt: Date.now(), text: 'Hello' }]

    const ctx = createCtx(session, events)
    const renderer = transformUserMessages((msg: string) => `<user>${msg}</user>`)

    const result = renderer(ctx)
    expect(result.events[0]).toMatchObject({
      type: 'user',
      text: '<user>Hello</user>',
    })
  })

  test('wraps multiple user messages', () => {
    const session = new BaseSession('app', { id: 'test' })
    const events: Event[] = [
      { id: 'u1', type: 'user', createdAt: Date.now(), text: 'First' },
      { id: 'u2', type: 'user', createdAt: Date.now(), text: 'Second' },
    ]

    const ctx = createCtx(session, events)
    const renderer = transformUserMessages((msg: string) => `[${msg}]`)

    const result = renderer(ctx)
    const userEvents = result.events.filter((e) => e.type === 'user')

    expect(userEvents[0]).toMatchObject({ text: '[First]' })
    expect(userEvents[1]).toMatchObject({ text: '[Second]' })
  })

  test('preserves non-user events unchanged', () => {
    const session = new BaseSession('app', { id: 'test' })
    const events: Event[] = [
      {
        id: 's1',
        type: 'system',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'System prompt',
      },
      { id: 'u1', type: 'user', createdAt: Date.now(), text: 'Hello' },
      {
        id: 'a1',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'Response',
      },
    ]

    const ctx = createCtx(session, events)
    const renderer = transformUserMessages((msg: string) => `wrapped: ${msg}`)

    const result = renderer(ctx)
    expect(result.events[0]).toMatchObject({
      type: 'system',
      text: 'System prompt',
    })
    expect(result.events[1]).toMatchObject({
      type: 'user',
      text: 'wrapped: Hello',
    })
    expect(result.events[2]).toMatchObject({
      type: 'assistant',
      text: 'Response',
    })
  })

  test('filters by targetAgent when specified', () => {
    const session = new BaseSession('app', { id: 'test' })
    const events: Event[] = [
      {
        id: 'inv1-start',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'inv1',
        agentName: 'agent_a',
        kind: 'agent',
      },
      { id: 'u1', type: 'user', createdAt: Date.now(), text: 'First' },
      {
        id: 'inv1-end',
        type: 'invocation_end',
        createdAt: Date.now(),
        invocationId: 'inv1',
        agentName: 'agent_a',
        reason: 'completed',
      },
      {
        id: 'inv2-start',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'inv2',
        agentName: 'agent_b',
        kind: 'agent',
      },
      { id: 'u2', type: 'user', createdAt: Date.now(), text: 'Second' },
    ]

    const ctx = createCtx(session, events)
    const renderer = transformUserMessages((msg: string) => `[wrapped] ${msg}`, {
      targetAgent: 'agent_a',
    })

    const result = renderer(ctx)
    const userEvents = result.events.filter((e) => e.type === 'user')

    expect(userEvents[0]).toMatchObject({ text: '[wrapped] First' })
    expect(userEvents[1]).toMatchObject({ text: 'Second' })
  })
})
