import type {
  Event,
  ToolCallEvent,
  ToolYieldEvent,
  ToolInputEvent,
  ToolResultEvent,
} from '../../types';

export type InvocationState =
  | 'running'
  | 'completed'
  | 'error'
  | 'aborted'
  | 'max_steps'
  | 'transferred'
  | 'yielded';

export interface ToolEntry {
  call: ToolCallEvent;
  yield?: ToolYieldEvent;
  input?: ToolInputEvent;
  result?: ToolResultEvent;
}

export interface InvocationNode {
  invocationId: string;
  agentName: string;
  parentInvocationId?: string;
  state: InvocationState;
  yieldIndex?: number;
  pendingCallIds?: string[];
  children: InvocationNode[];
  toolCalls: Map<string, ToolEntry>;
}

export interface UnresolvedYield {
  agentName: string;
  callId: string;
}

export class InvocationTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationTreeError';
  }
}

export function buildInvocationTree(
  events: readonly Event[],
): InvocationNode[] {
  const nodeMap = new Map<string, InvocationNode>();
  const roots: InvocationNode[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'invocation_start': {
        const node: InvocationNode = {
          invocationId: event.invocationId,
          agentName: event.agentName,
          parentInvocationId: event.parentInvocationId,
          state: 'running',
          children: [],
          toolCalls: new Map(),
        };
        nodeMap.set(event.invocationId, node);
        if (event.parentInvocationId) {
          const parent = nodeMap.get(event.parentInvocationId);
          if (!parent) {
            throw new InvocationTreeError(
              `Child invocation '${event.invocationId}' references parent '${event.parentInvocationId}' that does not exist. Events may be out of order.`,
            );
          }
          parent.children.push(node);
        } else {
          roots.push(node);
        }
        break;
      }
      case 'invocation_end': {
        const node = nodeMap.get(event.invocationId);
        if (node) node.state = event.reason;
        break;
      }
      case 'invocation_yield': {
        const node = nodeMap.get(event.invocationId);
        if (node) {
          node.state = 'yielded';
          node.yieldIndex = event.yieldIndex;
          node.pendingCallIds = event.pendingCallIds;
        }
        break;
      }
      case 'invocation_resume': {
        const node = nodeMap.get(event.invocationId);
        if (node) {
          node.state = 'running';
          node.yieldIndex = event.yieldIndex;
          node.pendingCallIds = undefined;
        }
        break;
      }
      case 'tool_call': {
        if (event.invocationId) {
          nodeMap
            .get(event.invocationId)
            ?.toolCalls.set(event.callId, { call: event });
        }
        break;
      }
      case 'tool_yield': {
        if (event.invocationId) {
          const toolEntry = nodeMap
            .get(event.invocationId)
            ?.toolCalls.get(event.callId);
          if (toolEntry) toolEntry.yield = event;
        }
        break;
      }
      case 'tool_input': {
        for (const node of nodeMap.values()) {
          const toolEntry = node.toolCalls.get(event.callId);
          if (toolEntry) {
            toolEntry.input = event;
            break;
          }
        }
        break;
      }
      case 'tool_result': {
        if (event.invocationId) {
          const toolEntry = nodeMap
            .get(event.invocationId)
            ?.toolCalls.get(event.callId);
          if (toolEntry) toolEntry.result = event;
        }
        break;
      }
    }
  }

  return roots;
}

export function findYieldedNodes(nodes: InvocationNode[]): InvocationNode[] {
  const collect = (node: InvocationNode): InvocationNode[] =>
    node.state === 'yielded'
      ? [node, ...node.children.flatMap(collect)]
      : node.children.flatMap(collect);
  return nodes.flatMap(collect);
}

export function getUnresolvedYields(node: InvocationNode): UnresolvedYield[] {
  const unresolved: UnresolvedYield[] = [];

  if (node.state === 'yielded' && node.pendingCallIds) {
    for (const callId of node.pendingCallIds) {
      const toolEntry = node.toolCalls.get(callId);
      if (!toolEntry?.input) {
        unresolved.push({ agentName: node.agentName, callId });
      }
    }
  }

  for (const child of node.children) {
    unresolved.push(...getUnresolvedYields(child));
  }

  return unresolved;
}

export function hasUnresolvedYields(node: InvocationNode): boolean {
  if (node.state === 'yielded' && node.pendingCallIds) {
    const hasUnresolved = node.pendingCallIds.some((callId) => {
      const toolEntry = node.toolCalls.get(callId);
      return toolEntry !== undefined && !toolEntry.input;
    });
    if (hasUnresolved) return true;
  }

  for (const child of node.children) {
    if (hasUnresolvedYields(child)) return true;
  }

  return false;
}

export function findNode(
  nodes: InvocationNode[],
  invocationId: string,
): InvocationNode | undefined {
  for (const root of nodes) {
    if (root.invocationId === invocationId) return root;
    const found = findNode(root.children, invocationId);
    if (found) return found;
  }
  return undefined;
}

export function getNodePath(
  nodes: InvocationNode[],
  invocationId: string,
): InvocationNode[] {
  for (const root of nodes) {
    const path = findPath(root, invocationId, []);
    if (path) return path;
  }
  return [];
}

function findPath(
  node: InvocationNode,
  id: string,
  path: InvocationNode[],
): InvocationNode[] | null {
  const currentPath = [...path, node];
  if (node.invocationId === id) return currentPath;
  for (const child of node.children) {
    const result = findPath(child, id, currentPath);
    if (result) return result;
  }
  return null;
}
