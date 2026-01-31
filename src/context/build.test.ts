import {
  injectSystemMessage,
  includeHistory,
  selectRecentEvents,
  pruneReasoning,
  excludeChildInvocationInstructions,
  excludeChildInvocationEvents,
  createRenderContext,
  buildContext,
  createStateAccessor,
  wrapUserMessages,
} from './index';
import { agent } from '../agents';
import { openai } from '../providers';
import { BaseSession } from '../session';
import type { Event, RenderContext, Agent } from '../types';

const TEST_INV_ID = 'test-invocation-id';

describe('injectSystemMessage', () => {
  const createMinimalAgent = (): Agent =>
    agent({ name: 'test', model: openai('gpt-4o-mini'), context: [] });

  const createContext = (session: BaseSession): RenderContext => ({
    session,
    agent: createMinimalAgent(),
    invocationId: TEST_INV_ID,
    agentName: 'test',
    events: [],
    functionTools: [],
    providerTools: [],
    state: createStateAccessor(session, TEST_INV_ID),
  });

  test('injects static instruction as system event', () => {
    const ctx = createContext(new BaseSession('app', { id: 'test' }));
    const result = injectSystemMessage('You are a helpful assistant.')(ctx);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: 'system',
      text: 'You are a helpful assistant.',
    });
  });

  test('appends instruction to existing events', () => {
    const ctx: RenderContext = {
      ...createContext(new BaseSession('app', { id: 'test' })),
      events: [{ id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' }],
    };
    const result = injectSystemMessage('System prompt.')(ctx);

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.type)).toEqual(['user', 'system']);
  });
});

describe('includeHistory', () => {
  const createMinimalAgent = (): Agent =>
    agent({ name: 'test', model: openai('gpt-4o-mini'), context: [] });

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
  });

  test('includes all events by default', () => {
    const session = new BaseSession('app', { id: 'test' });
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    });
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      invocationId: TEST_INV_ID,
      agentName: 'test',
      text: 'Hi!',
    } as Event);
    const ctx = createCtx(session, undefined, [
      {
        id: '0',
        type: 'system',
        createdAt: Date.now(),
        invocationId: TEST_INV_ID,
        agentName: 'test',
        text: 'System',
      },
    ]);

    const result = includeHistory()(ctx);
    expect(result.events.map((e) => e.type)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
  });

  test('scope: current filters to current invocation', () => {
    const session = new BaseSession('app', { id: 'test' });
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    });
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      text: 'Hi',
      invocationId: 'inv1',
      agentName: 'test',
    });
    session.pushEvent({
      id: '3',
      type: 'user',
      createdAt: Date.now(),
      text: 'More',
      invocationId: 'inv2',
    });

    const result = includeHistory({ scope: 'invocation' })(
      createCtx(session, 'inv1'),
    );
    expect(result.events.map((e) => e.id)).toEqual(['1', '2']);
  });

  test('scope: ancestors includes parent chain but excludes siblings', () => {
    const session = new BaseSession('app', { id: 'test' });
    session.pushEvent({
      id: '1',
      type: 'user',
      createdAt: Date.now(),
      text: 'Hello',
    });
    session.pushEvent({
      id: 'p-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'parent',
      agentName: 'p',
      kind: 'agent',
    });
    session.pushEvent({
      id: '2',
      type: 'assistant',
      createdAt: Date.now(),
      text: 'Parent',
      invocationId: 'parent',
      agentName: 'p',
    });
    session.pushEvent({
      id: 'c-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'child',
      agentName: 'c',
      parentInvocationId: 'parent',
      kind: 'agent',
    });
    session.pushEvent({
      id: '3',
      type: 'user',
      createdAt: Date.now(),
      text: 'Child',
      invocationId: 'child',
    });
    session.pushEvent({
      id: 's-start',
      type: 'invocation_start',
      createdAt: Date.now(),
      invocationId: 'sibling',
      agentName: 's',
      parentInvocationId: 'parent',
      kind: 'agent',
    });
    session.pushEvent({
      id: '4',
      type: 'assistant',
      createdAt: Date.now(),
      text: 'Sibling',
      invocationId: 'sibling',
      agentName: 's',
    });

    const result = includeHistory({ scope: 'ancestors' })(
      createCtx(session, 'child'),
    );
    const ids = result.events.map((e) => e.id);

    expect(ids).toContain('1');
    expect(ids).toContain('2');
    expect(ids).toContain('3');
    expect(ids).not.toContain('4');
  });
});

describe('selectRecentEvents', () => {
  const createCtx = (events: Event[]): RenderContext => {
    const session = new BaseSession('app', { id: 'test' });
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
    };
  };

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
    ];

    const result = selectRecentEvents(2)(createCtx(events));
    expect(result.events.map((e) => e.id)).toEqual(['s1', '3', '4']);
  });

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
    ];

    expect(selectRecentEvents(5)(createCtx(events)).events).toHaveLength(2);
  });
});

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
    ];

    const session = new BaseSession('app', { id: 'test' });
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
    };

    expect(pruneReasoning()(ctx).events.map((e) => e.type)).toEqual([
      'user',
      'assistant',
    ]);
  });
});

describe('excludeChildInvocationInstructions', () => {
  const createCtx = (events: Event[]): RenderContext => {
    const session = new BaseSession('app', { id: 'test' });
    return {
      session,
      agent: agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [],
      }),
      invocationId: 'parent-inv',
      agentName: 'test',
      events,
      functionTools: [],
      providerTools: [],
      state: createStateAccessor(session, 'parent-inv'),
    };
  };

  test('filters user events belonging to delegate child invocations', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' },
      {
        id: '2',
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        callId: 'c1',
        name: 'delegate',
        args: {},
      },
      {
        id: '3',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        agentName: 'child',
        kind: 'agent',
        parentInvocationId: 'parent-inv',
        handoffOrigin: {
          type: 'call',
          invocationId: 'parent-inv',
          callId: 'c1',
        },
      },
      {
        id: '4',
        type: 'user',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        text: 'Delegation instruction',
      },
      {
        id: '5',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        agentName: 'child',
        text: 'Child response',
      },
      {
        id: '6',
        type: 'tool_result',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        callId: 'c1',
        name: 'delegate',
        result: 'done',
      },
    ];

    const result = excludeChildInvocationInstructions()(createCtx(events));
    const userEvents = result.events.filter((e) => e.type === 'user');

    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]).toMatchObject({ id: '1', text: 'Hello' });
  });

  test('filters user events belonging to spawn child invocations', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Original' },
      {
        id: '2',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'spawn-inv',
        agentName: 'spawned',
        kind: 'agent',
        parentInvocationId: 'parent-inv',
        handoffOrigin: { type: 'spawn', invocationId: 'parent-inv' },
      },
      {
        id: '3',
        type: 'user',
        createdAt: Date.now(),
        invocationId: 'spawn-inv',
        text: 'Spawn instruction',
      },
    ];

    const result = excludeChildInvocationInstructions()(createCtx(events));
    expect(result.events.filter((e) => e.type === 'user')).toHaveLength(1);
  });

  test('filters user events belonging to transfer child invocations', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Original' },
      {
        id: '2',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'transfer-inv',
        agentName: 'specialist',
        kind: 'agent',
        handoffOrigin: { type: 'transfer', invocationId: 'parent-inv' },
      },
      {
        id: '3',
        type: 'user',
        createdAt: Date.now(),
        invocationId: 'transfer-inv',
        text: 'Transfer context',
      },
    ];

    const result = excludeChildInvocationInstructions()(createCtx(events));
    expect(result.events.filter((e) => e.type === 'user')).toHaveLength(1);
  });

  test('preserves user events without invocationId', () => {
    const events: Event[] = [
      {
        id: '1',
        type: 'user',
        createdAt: Date.now(),
        text: 'Original user message',
      },
      {
        id: '2',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        agentName: 'child',
        kind: 'agent',
        handoffOrigin: { type: 'call', invocationId: 'parent-inv' },
      },
    ];

    const result = excludeChildInvocationInstructions()(createCtx(events));
    expect(result.events.filter((e) => e.type === 'user')).toHaveLength(1);
  });

  test('returns unchanged context when no child invocations exist', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' },
      {
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        text: 'Hi',
      },
    ];

    const ctx = createCtx(events);
    const result = excludeChildInvocationInstructions()(ctx);

    expect(result).toBe(ctx);
  });
});

describe('excludeChildInvocationEvents', () => {
  const createCtx = (events: Event[]): RenderContext => {
    const session = new BaseSession('app', { id: 'test' });
    return {
      session,
      agent: agent({
        name: 'test',
        model: openai('gpt-4o-mini'),
        context: [],
      }),
      invocationId: 'parent-inv',
      agentName: 'test',
      events,
      functionTools: [],
      providerTools: [],
      state: createStateAccessor(session, 'parent-inv'),
    };
  };

  test('filters all events belonging to delegate child invocations', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' },
      {
        id: '2',
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        callId: 'c1',
        name: 'delegate',
        args: {},
      },
      {
        id: '3',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        agentName: 'child',
        kind: 'agent',
        parentInvocationId: 'parent-inv',
        handoffOrigin: {
          type: 'call',
          invocationId: 'parent-inv',
          callId: 'c1',
        },
      },
      {
        id: '4',
        type: 'user',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        text: 'Delegation instruction',
      },
      {
        id: '5',
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        agentName: 'child',
        callId: 'c2',
        name: 'some_tool',
        args: {},
      },
      {
        id: '6',
        type: 'tool_result',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        agentName: 'child',
        callId: 'c2',
        name: 'some_tool',
        result: 'done',
      },
      {
        id: '7',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: 'child-inv',
        agentName: 'child',
        text: 'Child response',
      },
      {
        id: '8',
        type: 'tool_result',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        callId: 'c1',
        name: 'delegate',
        result: 'done',
      },
    ];

    const result = excludeChildInvocationEvents()(createCtx(events));

    expect(result.events.map((e) => e.id)).toEqual(['1', '2', '8']);
    expect(
      result.events.filter((e) => e.invocationId === 'child-inv'),
    ).toHaveLength(0);
  });

  test('filters all events from spawn child invocations', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Original' },
      {
        id: '2',
        type: 'invocation_start',
        createdAt: Date.now(),
        invocationId: 'spawn-inv',
        agentName: 'spawned',
        kind: 'agent',
        parentInvocationId: 'parent-inv',
        handoffOrigin: { type: 'spawn', invocationId: 'parent-inv' },
      },
      {
        id: '3',
        type: 'user',
        createdAt: Date.now(),
        invocationId: 'spawn-inv',
        text: 'Spawn instruction',
      },
      {
        id: '4',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: 'spawn-inv',
        agentName: 'spawned',
        text: 'Spawned response',
      },
    ];

    const result = excludeChildInvocationEvents()(createCtx(events));
    expect(result.events.map((e) => e.id)).toEqual(['1']);
  });

  test('preserves parent invocation events', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' },
      {
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        text: 'Hi',
      },
      {
        id: '3',
        type: 'tool_call',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        callId: 'c1',
        name: 'tool',
        args: {},
      },
      {
        id: '4',
        type: 'tool_result',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        callId: 'c1',
        name: 'tool',
        result: 'ok',
      },
    ];

    const result = excludeChildInvocationEvents()(createCtx(events));
    expect(result.events).toHaveLength(4);
  });

  test('returns unchanged context when no child invocations exist', () => {
    const events: Event[] = [
      { id: '1', type: 'user', createdAt: Date.now(), text: 'Hello' },
      {
        id: '2',
        type: 'assistant',
        createdAt: Date.now(),
        invocationId: 'parent-inv',
        agentName: 'test',
        text: 'Hi',
      },
    ];

    const ctx = createCtx(events);
    const result = excludeChildInvocationEvents()(ctx);

    expect(result).toBe(ctx);
  });
});

describe('createRenderContext', () => {
  test('creates initial context from session and agent', () => {
    const session = new BaseSession('app', { id: 'test' });
    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [],
    });
    const ctx = createRenderContext(session, testAgent, 'inv-123');

    expect(ctx.session).toBe(session);
    expect(ctx.invocationId).toBe('inv-123');
    expect(ctx.events).toEqual([]);
  });
});

describe('buildContext', () => {
  test('composes context renderers in order', () => {
    const session = new BaseSession('app', { id: 'test' });
    session.addMessage('Hello');

    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [injectSystemMessage('System prompt'), includeHistory()],
    });

    const ctx = buildContext(session, testAgent, 'inv-123');
    expect(ctx.events[0]).toMatchObject({
      type: 'system',
      text: 'System prompt',
    });
    expect(ctx.events[1]).toMatchObject({ type: 'user', text: 'Hello' });
  });

  test('empty context array produces empty events', () => {
    const testAgent = agent({
      name: 'test',
      model: openai('gpt-4o-mini'),
      context: [],
    });
    expect(
      buildContext(
        new BaseSession('app', { id: 'test' }),
        testAgent,
        TEST_INV_ID,
      ).events,
    ).toEqual([]);
  });
});

describe('wrapUserMessages', () => {
  const createMinimalAgent = (): Agent =>
    agent({ name: 'test', model: openai('gpt-4o-mini'), context: [] });

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
  });

  test('wraps user messages with transform function', () => {
    const session = new BaseSession('app', { id: 'test' });
    const events: Event[] = [
      { id: 'u1', type: 'user', createdAt: Date.now(), text: 'Hello' },
    ];

    const ctx = createCtx(session, events);
    const renderer = wrapUserMessages((msg: string) => `<user>${msg}</user>`);

    const result = renderer(ctx);
    expect(result.events[0]).toMatchObject({
      type: 'user',
      text: '<user>Hello</user>',
    });
  });

  test('wraps multiple user messages', () => {
    const session = new BaseSession('app', { id: 'test' });
    const events: Event[] = [
      { id: 'u1', type: 'user', createdAt: Date.now(), text: 'First' },
      { id: 'u2', type: 'user', createdAt: Date.now(), text: 'Second' },
    ];

    const ctx = createCtx(session, events);
    const renderer = wrapUserMessages((msg: string) => `[${msg}]`);

    const result = renderer(ctx);
    const userEvents = result.events.filter((e) => e.type === 'user');

    expect(userEvents[0]).toMatchObject({ text: '[First]' });
    expect(userEvents[1]).toMatchObject({ text: '[Second]' });
  });

  test('preserves non-user events unchanged', () => {
    const session = new BaseSession('app', { id: 'test' });
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
    ];

    const ctx = createCtx(session, events);
    const renderer = wrapUserMessages((msg: string) => `wrapped: ${msg}`);

    const result = renderer(ctx);
    expect(result.events[0]).toMatchObject({
      type: 'system',
      text: 'System prompt',
    });
    expect(result.events[1]).toMatchObject({
      type: 'user',
      text: 'wrapped: Hello',
    });
    expect(result.events[2]).toMatchObject({
      type: 'assistant',
      text: 'Response',
    });
  });

  test('filters by targetAgent when specified', () => {
    const session = new BaseSession('app', { id: 'test' });
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
    ];

    const ctx = createCtx(session, events);
    const renderer = wrapUserMessages((msg: string) => `[wrapped] ${msg}`, {
      targetAgent: 'agent_a',
    });

    const result = renderer(ctx);
    const userEvents = result.events.filter((e) => e.type === 'user');

    expect(userEvents[0]).toMatchObject({ text: '[wrapped] First' });
    expect(userEvents[1]).toMatchObject({ text: 'Second' });
  });
});
