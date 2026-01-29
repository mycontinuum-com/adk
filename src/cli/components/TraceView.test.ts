import {
  flattenBlocks,
  getLineIndexForEvent,
  findBlockEndEventIndex,
  findBlockStartEventIndex,
  type FlattenedLine,
} from './TraceView';
import type { InvocationBlock, ContextBlock, DisplayEvent } from '../blocks';
import type {
  InvocationStartEvent,
  InvocationEndEvent,
  ModelStartEvent,
  ModelEndEvent,
  AssistantEvent,
} from '../../types';

function createMockBlock(
  invocationId: string,
  agentName: string,
  events: DisplayEvent[] = [],
  contextBlocks: ContextBlock[] = [],
  children: InvocationBlock[] = [],
): InvocationBlock {
  return {
    invocationId,
    agentName,
    kind: 'agent',
    state: 'completed',
    events,
    contextBlocks,
    preContextEvents: [],
    postChildEvents: [],
    children,
  };
}

function createMockStartEvent(invocationId: string): InvocationStartEvent {
  return {
    id: `start-${invocationId}`,
    type: 'invocation_start',
    createdAt: Date.now(),
    invocationId,
    agentName: `Agent-${invocationId}`,
    kind: 'agent',
  };
}

function createMockEndEvent(invocationId: string): InvocationEndEvent {
  return {
    id: `end-${invocationId}`,
    type: 'invocation_end',
    createdAt: Date.now(),
    invocationId,
    agentName: `Agent-${invocationId}`,
    reason: 'completed',
    iterations: 1,
  };
}

function createMockContextEvent(contextId: string): ModelStartEvent {
  return {
    id: contextId,
    type: 'model_start',
    createdAt: Date.now(),
    invocationId: 'inv-1',
    agentName: 'TestAgent',
    stepIndex: 0,
    messages: [],
    tools: [],
  };
}

function createMockResponseEvent(contextId: string): ModelEndEvent {
  return {
    id: `response-${contextId}`,
    type: 'model_end',
    createdAt: Date.now(),
    invocationId: 'inv-1',
    agentName: 'TestAgent',
    stepIndex: 0,
    durationMs: 100,
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function createMockAssistantEvent(id: string): AssistantEvent {
  return {
    id,
    type: 'assistant',
    createdAt: Date.now(),
    invocationId: 'inv-1',
    agentName: 'TestAgent',
    text: 'Hello',
  };
}

function createMockContextBlock(
  contextId: string,
  producedEvents: DisplayEvent[] = [],
  hasResponse = true,
): ContextBlock {
  return {
    contextEvent: createMockContextEvent(contextId),
    responseEvent: hasResponse ? createMockResponseEvent(contextId) : undefined,
    messageItems: [],
    toolItems: [],
    producedEvents,
    postEvents: [],
  };
}

describe('findBlockEndEventIndex', () => {
  it('returns undefined when currentLineIndex is out of bounds', () => {
    const lines: FlattenedLine[] = [];
    expect(findBlockEndEventIndex(lines, -1)).toBeUndefined();
    expect(findBlockEndEventIndex(lines, 0)).toBeUndefined();
  });

  it('finds block_end from block_start', () => {
    const block = createMockBlock('inv-1', 'Agent1');
    block.events = [createMockStartEvent('inv-1'), createMockEndEvent('inv-1')];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      createMockEndEvent('inv-1'),
    ];

    const lines = flattenBlocks([block], selectableEvents);

    const startLineIdx = lines.findIndex((l) => l.type === 'block_start');
    const endLineIdx = lines.findIndex((l) => l.type === 'block_end');
    const endEventIndex = lines[endLineIdx].eventIndex;

    expect(findBlockEndEventIndex(lines, startLineIdx)).toBe(endEventIndex);
  });

  it('finds context_end from context_start', () => {
    const contextBlock = createMockContextBlock('ctx-1');
    const block = createMockBlock('inv-1', 'Agent1', [], [contextBlock]);
    block.events = [createMockStartEvent('inv-1'), createMockEndEvent('inv-1')];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      contextBlock.contextEvent!,
      contextBlock.responseEvent!,
      createMockEndEvent('inv-1'),
    ];

    const lines = flattenBlocks([block], selectableEvents);

    const contextStartIdx = lines.findIndex((l) => l.type === 'context_start');
    const contextEndIdx = lines.findIndex((l) => l.type === 'context_end');
    const contextEndEventIndex = lines[contextEndIdx].eventIndex;

    expect(findBlockEndEventIndex(lines, contextStartIdx)).toBe(
      contextEndEventIndex,
    );
  });

  it('finds the next sibling block end when on a block_end', () => {
    const block1 = createMockBlock('inv-1', 'Agent1');
    block1.events = [
      createMockStartEvent('inv-1'),
      createMockEndEvent('inv-1'),
    ];

    const block2 = createMockBlock('inv-2', 'Agent2');
    block2.events = [
      createMockStartEvent('inv-2'),
      createMockEndEvent('inv-2'),
    ];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      createMockEndEvent('inv-1'),
      createMockStartEvent('inv-2'),
      createMockEndEvent('inv-2'),
    ];

    const lines = flattenBlocks([block1, block2], selectableEvents);

    const firstBlockEndIdx = lines.findIndex(
      (l) => l.type === 'block_end' && l.block?.invocationId === 'inv-1',
    );
    const secondBlockEndIdx = lines.findIndex(
      (l) => l.type === 'block_end' && l.block?.invocationId === 'inv-2',
    );

    expect(findBlockEndEventIndex(lines, firstBlockEndIdx)).toBe(
      lines[secondBlockEndIdx].eventIndex,
    );
  });

  it('finds block_end from an event inside the block', () => {
    const assistantEvent = createMockAssistantEvent('assistant-1');
    const contextBlock = createMockContextBlock('ctx-1', [assistantEvent]);
    const block = createMockBlock('inv-1', 'Agent1', [], [contextBlock]);
    block.events = [createMockStartEvent('inv-1'), createMockEndEvent('inv-1')];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      contextBlock.contextEvent!,
      assistantEvent,
      contextBlock.responseEvent!,
      createMockEndEvent('inv-1'),
    ];

    const lines = flattenBlocks([block], selectableEvents);

    const eventLineIdx = lines.findIndex(
      (l) =>
        l.type === 'event' &&
        (l.event as { id?: string })?.id === 'assistant-1',
    );
    const contextEndIdx = lines.findIndex((l) => l.type === 'context_end');

    expect(findBlockEndEventIndex(lines, eventLineIdx)).toBe(
      lines[contextEndIdx].eventIndex,
    );
  });
});

describe('findBlockStartEventIndex', () => {
  it('returns undefined when currentLineIndex is out of bounds', () => {
    const lines: FlattenedLine[] = [];
    expect(findBlockStartEventIndex(lines, -1)).toBeUndefined();
    expect(findBlockStartEventIndex(lines, 0)).toBeUndefined();
  });

  it('finds block_start from block_end', () => {
    const block = createMockBlock('inv-1', 'Agent1');
    block.events = [createMockStartEvent('inv-1'), createMockEndEvent('inv-1')];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      createMockEndEvent('inv-1'),
    ];

    const lines = flattenBlocks([block], selectableEvents);

    const startLineIdx = lines.findIndex((l) => l.type === 'block_start');
    const endLineIdx = lines.findIndex((l) => l.type === 'block_end');
    const startEventIndex = lines[startLineIdx].eventIndex;

    expect(findBlockStartEventIndex(lines, endLineIdx)).toBe(startEventIndex);
  });

  it('finds context_start from context_end', () => {
    const contextBlock = createMockContextBlock('ctx-1');
    const block = createMockBlock('inv-1', 'Agent1', [], [contextBlock]);
    block.events = [createMockStartEvent('inv-1'), createMockEndEvent('inv-1')];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      contextBlock.contextEvent!,
      contextBlock.responseEvent!,
      createMockEndEvent('inv-1'),
    ];

    const lines = flattenBlocks([block], selectableEvents);

    const contextStartIdx = lines.findIndex((l) => l.type === 'context_start');
    const contextEndIdx = lines.findIndex((l) => l.type === 'context_end');
    const contextStartEventIndex = lines[contextStartIdx].eventIndex;

    expect(findBlockStartEventIndex(lines, contextEndIdx)).toBe(
      contextStartEventIndex,
    );
  });

  it('finds the previous sibling block start when on a block_start', () => {
    const block1 = createMockBlock('inv-1', 'Agent1');
    block1.events = [
      createMockStartEvent('inv-1'),
      createMockEndEvent('inv-1'),
    ];

    const block2 = createMockBlock('inv-2', 'Agent2');
    block2.events = [
      createMockStartEvent('inv-2'),
      createMockEndEvent('inv-2'),
    ];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      createMockEndEvent('inv-1'),
      createMockStartEvent('inv-2'),
      createMockEndEvent('inv-2'),
    ];

    const lines = flattenBlocks([block1, block2], selectableEvents);

    const firstBlockStartIdx = lines.findIndex(
      (l) => l.type === 'block_start' && l.block?.invocationId === 'inv-1',
    );
    const secondBlockStartIdx = lines.findIndex(
      (l) => l.type === 'block_start' && l.block?.invocationId === 'inv-2',
    );

    expect(findBlockStartEventIndex(lines, secondBlockStartIdx)).toBe(
      lines[firstBlockStartIdx].eventIndex,
    );
  });

  it('finds context_start from an event inside the context', () => {
    const assistantEvent = createMockAssistantEvent('assistant-1');
    const contextBlock = createMockContextBlock('ctx-1', [assistantEvent]);
    const block = createMockBlock('inv-1', 'Agent1', [], [contextBlock]);
    block.events = [createMockStartEvent('inv-1'), createMockEndEvent('inv-1')];

    const selectableEvents: DisplayEvent[] = [
      createMockStartEvent('inv-1'),
      contextBlock.contextEvent!,
      assistantEvent,
      contextBlock.responseEvent!,
      createMockEndEvent('inv-1'),
    ];

    const lines = flattenBlocks([block], selectableEvents);

    const eventLineIdx = lines.findIndex(
      (l) =>
        l.type === 'event' &&
        (l.event as { id?: string })?.id === 'assistant-1',
    );
    const contextStartIdx = lines.findIndex((l) => l.type === 'context_start');

    expect(findBlockStartEventIndex(lines, eventLineIdx)).toBe(
      lines[contextStartIdx].eventIndex,
    );
  });
});

describe('getLineIndexForEvent', () => {
  it('returns 0 when event is not found', () => {
    const lines: FlattenedLine[] = [
      { key: 'test', type: 'event', depth: 0, eventIndex: 5 },
    ];
    expect(getLineIndexForEvent(lines, 99)).toBe(0);
  });

  it('returns correct line index for event', () => {
    const lines: FlattenedLine[] = [
      { key: 'test1', type: 'block_start', depth: 0, eventIndex: 0 },
      { key: 'test2', type: 'event', depth: 1, eventIndex: 1 },
      { key: 'test3', type: 'block_end', depth: 0, eventIndex: 2 },
    ];
    expect(getLineIndexForEvent(lines, 1)).toBe(1);
    expect(getLineIndexForEvent(lines, 2)).toBe(2);
  });
});
