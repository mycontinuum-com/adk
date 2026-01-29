import type {
  Event,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '../../types';
import {
  buildInvocationTree,
  findYieldedNodes,
  findNode,
  getNodePath,
  hasUnresolvedYields,
  getUnresolvedYields,
  InvocationTreeError,
  type InvocationNode,
  type ToolEntry,
} from './tree';

function createInvocationStart(
  invocationId: string,
  agentName: string,
  parentInvocationId?: string,
): InvocationStartEvent {
  return {
    id: `event-${invocationId}-start`,
    type: 'invocation_start',
    createdAt: Date.now(),
    invocationId,
    agentName,
    parentInvocationId,
    kind: 'agent',
  };
}

function createInvocationEnd(
  invocationId: string,
  agentName: string,
  reason: InvocationEndEvent['reason'],
  parentInvocationId?: string,
): InvocationEndEvent {
  return {
    id: `event-${invocationId}-end`,
    type: 'invocation_end',
    createdAt: Date.now(),
    invocationId,
    agentName,
    reason,
    parentInvocationId,
  };
}

function createInvocationYield(
  invocationId: string,
  agentName: string,
  pendingCallIds: string[],
  yieldIndex: number,
  parentInvocationId?: string,
): InvocationYieldEvent {
  return {
    id: `event-${invocationId}-yield`,
    type: 'invocation_yield',
    createdAt: Date.now(),
    invocationId,
    agentName,
    pendingCallIds,
    yieldIndex,
    parentInvocationId,
  };
}

function createInvocationResume(
  invocationId: string,
  agentName: string,
  yieldIndex: number,
  parentInvocationId?: string,
): InvocationResumeEvent {
  return {
    id: `event-${invocationId}-resume`,
    type: 'invocation_resume',
    createdAt: Date.now(),
    invocationId,
    agentName,
    yieldIndex,
    parentInvocationId,
  };
}

function createToolCall(
  callId: string,
  name: string,
  invocationId: string,
  agentName: string = 'test_agent',
): ToolCallEvent {
  return {
    id: `event-${callId}-call`,
    type: 'tool_call',
    createdAt: Date.now(),
    callId,
    name,
    args: {},
    invocationId,
    agentName,
  };
}

function createToolResult(
  callId: string,
  name: string,
  invocationId: string,
  result?: unknown,
  agentName: string = 'test_agent',
): ToolResultEvent {
  return {
    id: `event-${callId}-result`,
    type: 'tool_result',
    createdAt: Date.now(),
    callId,
    name,
    result,
    invocationId,
    agentName,
  };
}

describe('buildInvocationTree', () => {
  test('returns empty array for empty events', () => {
    const tree = buildInvocationTree([]);
    expect(tree).toEqual([]);
  });

  test('creates single root node from invocation_start', () => {
    const events: Event[] = [createInvocationStart('inv-1', 'agent1')];
    const tree = buildInvocationTree(events);

    expect(tree).toHaveLength(1);
    expect(tree[0].invocationId).toBe('inv-1');
    expect(tree[0].agentName).toBe('agent1');
    expect(tree[0].state).toBe('running');
    expect(tree[0].children).toEqual([]);
    expect(tree[0].parentInvocationId).toBeUndefined();
  });

  test('updates state to completed on invocation_end', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createInvocationEnd('inv-1', 'agent1', 'completed'),
    ];
    const tree = buildInvocationTree(events);

    expect(tree[0].state).toBe('completed');
  });

  test('maps all end reasons correctly', () => {
    const reasons: InvocationEndEvent['reason'][] = [
      'completed',
      'error',
      'aborted',
      'transferred',
      'max_steps',
    ];

    for (const reason of reasons) {
      const events: Event[] = [
        createInvocationStart(`inv-${reason}`, 'agent1'),
        createInvocationEnd(`inv-${reason}`, 'agent1', reason),
      ];
      const tree = buildInvocationTree(events);
      expect(tree[0].state).toBe(reason);
    }
  });

  test('handles invocation_yield event', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createInvocationYield('inv-1', 'agent1', ['call-1', 'call-2'], 0),
    ];
    const tree = buildInvocationTree(events);

    expect(tree[0].state).toBe('yielded');
    expect(tree[0].yieldIndex).toBe(0);
    expect(tree[0].pendingCallIds).toEqual(['call-1', 'call-2']);
  });

  test('handles invocation_resume event and clears pendingCallIds', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createInvocationYield('inv-1', 'agent1', ['call-1'], 0),
      createInvocationResume('inv-1', 'agent1', 0),
    ];
    const tree = buildInvocationTree(events);

    expect(tree[0].state).toBe('running');
    expect(tree[0].yieldIndex).toBe(0);
    expect(tree[0].pendingCallIds).toBeUndefined();
  });

  test('builds parent-child relationships', () => {
    const events: Event[] = [
      createInvocationStart('inv-parent', 'parentAgent'),
      createInvocationStart('inv-child', 'childAgent', 'inv-parent'),
    ];
    const tree = buildInvocationTree(events);

    expect(tree).toHaveLength(1);
    expect(tree[0].invocationId).toBe('inv-parent');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].invocationId).toBe('inv-child');
    expect(tree[0].children[0].parentInvocationId).toBe('inv-parent');
  });

  test('builds multi-level tree structure', () => {
    const events: Event[] = [
      createInvocationStart('inv-root', 'rootAgent'),
      createInvocationStart('inv-child-1', 'child1', 'inv-root'),
      createInvocationStart('inv-grandchild', 'grandchild', 'inv-child-1'),
      createInvocationStart('inv-child-2', 'child2', 'inv-root'),
    ];
    const tree = buildInvocationTree(events);

    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].agentName).toBe('grandchild');
    expect(tree[0].children[1].agentName).toBe('child2');
  });

  test('tracks tool calls for invocation', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createToolCall('call-1', 'myTool', 'inv-1'),
    ];
    const tree = buildInvocationTree(events);

    expect(tree[0].toolCalls.size).toBe(1);
    const toolEntry = tree[0].toolCalls.get('call-1');
    expect(toolEntry?.call.name).toBe('myTool');
    expect(toolEntry?.result).toBeUndefined();
  });

  test('associates tool results with tool calls', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createToolCall('call-1', 'myTool', 'inv-1'),
      createToolResult('call-1', 'myTool', 'inv-1', { success: true }),
    ];
    const tree = buildInvocationTree(events);

    const toolEntry = tree[0].toolCalls.get('call-1');
    expect(toolEntry?.result?.result).toEqual({ success: true });
  });

  test('handles multiple roots (separate invocation trees)', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createInvocationStart('inv-2', 'agent2'),
    ];
    const tree = buildInvocationTree(events);

    expect(tree).toHaveLength(2);
    expect(tree[0].invocationId).toBe('inv-1');
    expect(tree[1].invocationId).toBe('inv-2');
  });

  test('ignores tool events without matching invocation', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createToolCall('orphan-call', 'orphanTool', 'inv-nonexistent'),
      createToolResult(
        'orphan-call',
        'orphanTool',
        'inv-nonexistent',
        'ignored',
      ),
    ];
    const tree = buildInvocationTree(events);

    expect(tree[0].toolCalls.size).toBe(0);
  });

  test('ignores unrelated event types', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      {
        id: 'user-event',
        type: 'user',
        createdAt: Date.now(),
        text: 'hello',
        invocationId: 'inv-1',
      },
      {
        id: 'assistant-event',
        type: 'assistant',
        createdAt: Date.now(),
        text: 'response',
        invocationId: 'inv-1',
        agentName: 'agent1',
      },
    ];
    const tree = buildInvocationTree(events);

    expect(tree).toHaveLength(1);
    expect(tree[0].state).toBe('running');
  });

  test('throws InvocationTreeError when child references non-existent parent', () => {
    const events: Event[] = [
      createInvocationStart('inv-child', 'childAgent', 'inv-missing-parent'),
    ];

    expect(() => buildInvocationTree(events)).toThrow(InvocationTreeError);
    expect(() => buildInvocationTree(events)).toThrow(
      "Child invocation 'inv-child' references parent 'inv-missing-parent' that does not exist",
    );
  });

  test('throws InvocationTreeError for out-of-order events', () => {
    const events: Event[] = [
      createInvocationStart('inv-child', 'childAgent', 'inv-parent'),
      createInvocationStart('inv-parent', 'parentAgent'),
    ];

    expect(() => buildInvocationTree(events)).toThrow(InvocationTreeError);
  });
});

describe('findYieldedNodes', () => {
  test('returns empty array for empty tree', () => {
    const result = findYieldedNodes([]);
    expect(result).toEqual([]);
  });

  test('returns empty array when no nodes are yielded', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createInvocationEnd('inv-1', 'agent1', 'completed'),
    ];
    const tree = buildInvocationTree(events);

    const result = findYieldedNodes(tree);
    expect(result).toEqual([]);
  });

  test('finds single yielded root node', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent1'),
      createInvocationYield('inv-1', 'agent1', ['call-1'], 0),
    ];
    const tree = buildInvocationTree(events);

    const result = findYieldedNodes(tree);
    expect(result).toHaveLength(1);
    expect(result[0].invocationId).toBe('inv-1');
  });

  test('finds yielded child node', () => {
    const events: Event[] = [
      createInvocationStart('inv-parent', 'parentAgent'),
      createInvocationStart('inv-child', 'childAgent', 'inv-parent'),
      createInvocationYield('inv-child', 'childAgent', ['call-1'], 0),
    ];
    const tree = buildInvocationTree(events);

    const result = findYieldedNodes(tree);
    expect(result).toHaveLength(1);
    expect(result[0].invocationId).toBe('inv-child');
  });

  test('finds yielded descendants of yielded nodes', () => {
    const events: Event[] = [
      createInvocationStart('inv-parent', 'parentAgent'),
      createInvocationStart('inv-child', 'childAgent', 'inv-parent'),
      createInvocationYield('inv-parent', 'parentAgent', ['call-1'], 0),
      createInvocationYield('inv-child', 'childAgent', ['call-2'], 0),
    ];
    const tree = buildInvocationTree(events);

    const result = findYieldedNodes(tree);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.invocationId)).toContain('inv-parent');
    expect(result.map((n) => n.invocationId)).toContain('inv-child');
  });

  test('does not include completed descendants of yielded nodes', () => {
    const events: Event[] = [
      createInvocationStart('inv-parent', 'parentAgent'),
      createInvocationStart('inv-child', 'childAgent', 'inv-parent'),
      createInvocationYield('inv-parent', 'parentAgent', ['call-1'], 0),
      createInvocationEnd('inv-child', 'childAgent', 'completed'),
    ];
    const tree = buildInvocationTree(events);

    const result = findYieldedNodes(tree);
    expect(result).toHaveLength(1);
    expect(result[0].invocationId).toBe('inv-parent');
  });

  test('finds multiple yielded nodes at different levels', () => {
    const events: Event[] = [
      createInvocationStart('inv-root', 'root'),
      createInvocationStart('inv-child1', 'child1', 'inv-root'),
      createInvocationStart('inv-child2', 'child2', 'inv-root'),
      createInvocationYield('inv-child1', 'child1', ['call-1'], 0),
      createInvocationYield('inv-child2', 'child2', ['call-2'], 0),
    ];
    const tree = buildInvocationTree(events);

    const result = findYieldedNodes(tree);
    expect(result).toHaveLength(2);
  });
});

describe('findNode', () => {
  test('returns undefined for empty tree or non-existent node', () => {
    expect(findNode([], 'inv-1')).toBeUndefined();

    const tree = buildInvocationTree([
      createInvocationStart('inv-1', 'agent1'),
    ]);
    expect(findNode(tree, 'nonexistent')).toBeUndefined();
  });

  test('finds nodes at any depth', () => {
    const events: Event[] = [
      createInvocationStart('inv-root', 'root'),
      createInvocationStart('inv-child', 'child', 'inv-root'),
      createInvocationStart('inv-grandchild', 'grandchild', 'inv-child'),
    ];
    const tree = buildInvocationTree(events);

    expect(findNode(tree, 'inv-root')?.agentName).toBe('root');
    expect(findNode(tree, 'inv-child')?.agentName).toBe('child');
    expect(findNode(tree, 'inv-grandchild')?.agentName).toBe('grandchild');
  });

  test('finds node among siblings and multiple roots', () => {
    const events: Event[] = [
      createInvocationStart('inv-root1', 'root1'),
      createInvocationStart('inv-root2', 'root2'),
      createInvocationStart('inv-child1', 'child1', 'inv-root1'),
      createInvocationStart('inv-child2', 'child2', 'inv-root1'),
      createInvocationStart('inv-child3', 'child3', 'inv-root2'),
    ];
    const tree = buildInvocationTree(events);

    expect(findNode(tree, 'inv-child2')?.agentName).toBe('child2');
    expect(findNode(tree, 'inv-child3')?.agentName).toBe('child3');
  });
});

describe('getNodePath', () => {
  test('returns empty array for empty tree or non-existent node', () => {
    expect(getNodePath([], 'inv-1')).toEqual([]);

    const tree = buildInvocationTree([
      createInvocationStart('inv-1', 'agent1'),
    ]);
    expect(getNodePath(tree, 'nonexistent')).toEqual([]);
  });

  test('returns correct path to nodes at any depth', () => {
    const events: Event[] = [
      createInvocationStart('inv-parent', 'parent'),
      createInvocationStart('inv-child1', 'child1', 'inv-parent'),
      createInvocationStart('inv-child2', 'child2', 'inv-parent'),
      createInvocationStart('inv-grandchild', 'grandchild', 'inv-child2'),
    ];
    const tree = buildInvocationTree(events);

    const rootPath = getNodePath(tree, 'inv-parent');
    expect(rootPath).toHaveLength(1);
    expect(rootPath[0].invocationId).toBe('inv-parent');

    const childPath = getNodePath(tree, 'inv-child2');
    expect(childPath.map((n) => n.agentName)).toEqual(['parent', 'child2']);

    const grandchildPath = getNodePath(tree, 'inv-grandchild');
    expect(grandchildPath.map((n) => n.agentName)).toEqual([
      'parent',
      'child2',
      'grandchild',
    ]);
  });
});

describe('hasUnresolvedYields', () => {
  function createToolCallEntry(
    callId: string,
    hasInput: boolean,
    invocationId = 'inv-test',
  ): ToolEntry {
    const entry: ToolEntry = {
      call: {
        id: `event-${callId}`,
        type: 'tool_call',
        createdAt: Date.now(),
        callId,
        name: 'test-tool',
        args: {},
        invocationId,
        agentName: 'test_agent',
      },
    };
    if (hasInput) {
      entry.input = {
        id: `event-${callId}-input`,
        type: 'tool_input',
        createdAt: Date.now(),
        callId,
        name: 'test-tool',
        input: 'user input',
      };
    }
    return entry;
  }

  function createYieldedNode(
    invocationId: string,
    pendingCallIds: string[],
    toolCalls: Map<string, ToolEntry>,
    children: InvocationNode[] = [],
  ): InvocationNode {
    return {
      invocationId,
      agentName: 'test-runnable',
      state: 'yielded',
      pendingCallIds,
      children,
      toolCalls,
    };
  }

  function createRunningNode(
    invocationId: string,
    children: InvocationNode[] = [],
  ): InvocationNode {
    return {
      invocationId,
      agentName: 'test-runnable',
      state: 'running',
      children,
      toolCalls: new Map(),
    };
  }

  test('returns false for non-yielded nodes or yielded with no pending calls', () => {
    expect(hasUnresolvedYields(createRunningNode('inv-1'))).toBe(false);

    const yieldedNoPending = createYieldedNode('inv-1', [], new Map());
    yieldedNoPending.pendingCallIds = undefined;
    expect(hasUnresolvedYields(yieldedNoPending)).toBe(false);
  });

  test('returns true when yields are unresolved, false when resolved', () => {
    const toolCalls = new Map<string, ToolEntry>();
    toolCalls.set('call-1', createToolCallEntry('call-1', false));
    toolCalls.set('call-2', createToolCallEntry('call-2', true));

    const nodeWithUnresolved = createYieldedNode(
      'inv-1',
      ['call-1', 'call-2'],
      toolCalls,
    );
    expect(hasUnresolvedYields(nodeWithUnresolved)).toBe(true);

    toolCalls.set('call-1', createToolCallEntry('call-1', true));
    const nodeAllResolved = createYieldedNode(
      'inv-2',
      ['call-1', 'call-2'],
      toolCalls,
    );
    expect(hasUnresolvedYields(nodeAllResolved)).toBe(false);

    const childToolCalls = new Map<string, ToolEntry>();
    childToolCalls.set('call-child', createToolCallEntry('call-child', false));
    const childWithUnresolved = createYieldedNode(
      'inv-child',
      ['call-child'],
      childToolCalls,
    );
    const compositionNode = createYieldedNode(
      'inv-composition',
      ['call-child'],
      new Map(),
      [childWithUnresolved],
    );
    expect(hasUnresolvedYields(compositionNode)).toBe(true);
  });

  test('checks children recursively', () => {
    const grandchildToolCalls = new Map<string, ToolEntry>();
    grandchildToolCalls.set('call-gc', createToolCallEntry('call-gc', false));
    const grandchild = createYieldedNode(
      'inv-grandchild',
      ['call-gc'],
      grandchildToolCalls,
    );
    const child = createRunningNode('inv-child', [grandchild]);
    const parent = createRunningNode('inv-parent', [child]);

    expect(hasUnresolvedYields(parent)).toBe(true);

    grandchildToolCalls.set('call-gc', createToolCallEntry('call-gc', true));
    const resolvedGrandchild = createYieldedNode(
      'inv-grandchild',
      ['call-gc'],
      grandchildToolCalls,
    );
    const resolvedChild = createRunningNode('inv-child', [resolvedGrandchild]);
    const resolvedParent = createRunningNode('inv-parent', [resolvedChild]);

    expect(hasUnresolvedYields(resolvedParent)).toBe(false);
  });
});

describe('getUnresolvedYields', () => {
  function createToolCallEntry(
    callId: string,
    hasInput: boolean,
    invocationId = 'inv-test',
  ): ToolEntry {
    const entry: ToolEntry = {
      call: {
        id: `event-${callId}`,
        type: 'tool_call',
        createdAt: Date.now(),
        callId,
        name: 'test-tool',
        args: {},
        invocationId,
        agentName: 'test_agent',
      },
    };
    if (hasInput) {
      entry.input = {
        id: `event-${callId}-input`,
        type: 'tool_input',
        createdAt: Date.now(),
        callId,
        name: 'test-tool',
        input: 'user input',
      };
    }
    return entry;
  }

  test('returns unresolved yields from current node and children', () => {
    const parentToolCalls = new Map<string, ToolEntry>();
    parentToolCalls.set(
      'call-parent',
      createToolCallEntry('call-parent', false),
    );

    const childToolCalls = new Map<string, ToolEntry>();
    childToolCalls.set('call-child', createToolCallEntry('call-child', false));
    childToolCalls.set(
      'call-resolved',
      createToolCallEntry('call-resolved', true),
    );

    const child: InvocationNode = {
      invocationId: 'inv-child',
      agentName: 'child-runnable',
      state: 'yielded',
      pendingCallIds: ['call-child', 'call-resolved'],
      children: [],
      toolCalls: childToolCalls,
    };

    const parent: InvocationNode = {
      invocationId: 'inv-parent',
      agentName: 'parent-runnable',
      state: 'yielded',
      pendingCallIds: ['call-parent'],
      children: [child],
      toolCalls: parentToolCalls,
    };

    const result = getUnresolvedYields(parent);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      agentName: 'parent-runnable',
      callId: 'call-parent',
    });
    expect(result).toContainEqual({
      agentName: 'child-runnable',
      callId: 'call-child',
    });
  });

  test('returns empty array when no unresolved yields exist', () => {
    const runningNode: InvocationNode = {
      invocationId: 'inv-1',
      agentName: 'runnable',
      state: 'running',
      children: [],
      toolCalls: new Map(),
    };
    expect(getUnresolvedYields(runningNode)).toEqual([]);

    const resolvedToolCalls = new Map<string, ToolEntry>();
    resolvedToolCalls.set('call-1', createToolCallEntry('call-1', true));
    const resolvedNode: InvocationNode = {
      invocationId: 'inv-2',
      agentName: 'runnable',
      state: 'yielded',
      pendingCallIds: ['call-1'],
      children: [],
      toolCalls: resolvedToolCalls,
    };
    expect(getUnresolvedYields(resolvedNode)).toEqual([]);
  });
});

describe('integration scenarios', () => {
  test('complete yield-resume cycle updates tree correctly', () => {
    const events: Event[] = [
      createInvocationStart('inv-1', 'agent'),
      createToolCall('call-1', 'yielding_tool', 'inv-1'),
      createInvocationYield('inv-1', 'agent', ['call-1'], 0),
    ];

    let tree = buildInvocationTree(events);
    expect(tree[0].state).toBe('yielded');
    expect(findYieldedNodes(tree)).toHaveLength(1);

    events.push(
      createToolResult('call-1', 'yielding_tool', 'inv-1', 'approved'),
    );
    events.push(createInvocationResume('inv-1', 'agent', 0));

    tree = buildInvocationTree(events);
    expect(tree[0].state).toBe('running');

    events.push(createInvocationEnd('inv-1', 'agent', 'completed'));
    tree = buildInvocationTree(events);
    expect(tree[0].state).toBe('completed');
    expect(findYieldedNodes(tree)).toHaveLength(0);
  });

  test('nested sequential workflow with yield', () => {
    const events: Event[] = [
      createInvocationStart('inv-seq', 'sequence'),
      createInvocationStart('inv-step1', 'step1', 'inv-seq'),
      createToolCall('call-1', 'get_approval', 'inv-step1'),
      createInvocationYield('inv-step1', 'step1', ['call-1'], 0),
      createInvocationYield('inv-seq', 'sequence', ['call-1'], 0),
    ];

    const tree = buildInvocationTree(events);

    expect(tree).toHaveLength(1);
    expect(tree[0].agentName).toBe('sequence');
    expect(tree[0].state).toBe('yielded');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].state).toBe('yielded');

    const yieldedNodes = findYieldedNodes(tree);
    expect(yieldedNodes.length).toBeGreaterThanOrEqual(1);

    const path = getNodePath(tree, 'inv-step1');
    expect(path).toHaveLength(2);
    expect(path[0].agentName).toBe('sequence');
    expect(path[1].agentName).toBe('step1');
  });

  test('parallel branches with independent yields', () => {
    const events: Event[] = [
      createInvocationStart('inv-par', 'parallel'),
      createInvocationStart('inv-branch1', 'branch1', 'inv-par'),
      createInvocationStart('inv-branch2', 'branch2', 'inv-par'),
      createToolCall('call-b1', 'tool1', 'inv-branch1'),
      createToolCall('call-b2', 'tool2', 'inv-branch2'),
      createInvocationYield('inv-branch1', 'branch1', ['call-b1'], 0),
      createInvocationEnd('inv-branch2', 'branch2', 'completed'),
    ];

    const tree = buildInvocationTree(events);

    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].state).toBe('yielded');
    expect(tree[0].children[1].state).toBe('completed');

    const yieldedNodes = findYieldedNodes(tree);
    expect(yieldedNodes).toHaveLength(1);
    expect(yieldedNodes[0].invocationId).toBe('inv-branch1');
  });
});
