import type {
  Event,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
  InvocationKind,
  ThoughtDeltaEvent,
  AssistantDeltaEvent,
  AssistantEvent,
  ThoughtEvent,
  ModelStartEvent,
  ModelEndEvent,
  ContextMessageSummary,
  ContextToolSummary,
  HandoffOrigin,
  HandoffTarget,
  ToolCallEvent,
} from '../types';
import type { InvocationState } from '../session/resume';
import type { CLIEvent } from './hooks/useAgent';
import { calculateCost } from '../providers/pricing';

export type { InvocationState };

export interface StreamingMetadata {
  chunkCount: number;
  deltaEvents: (ThoughtDeltaEvent | AssistantDeltaEvent)[];
}

export interface DeltaBatchEvent {
  id: string;
  type: 'delta_batch';
  createdAt: number;
  deltaType: 'thought_delta' | 'assistant_delta';
  count: number;
  finalText: string;
  events: (ThoughtDeltaEvent | AssistantDeltaEvent)[];
}

export type AugmentedAssistantEvent = AssistantEvent;
export type AugmentedThoughtEvent = ThoughtEvent;

export function getStreamingMetadata(
  blocks: InvocationBlock[],
  eventId: string,
): StreamingMetadata | undefined {
  for (const block of blocks) {
    for (const contextBlock of block.contextBlocks) {
      const metadata = contextBlock.streamingMetadata?.get(eventId);
      if (metadata) return metadata;
    }
    const childResult = getStreamingMetadata(block.children, eventId);
    if (childResult) return childResult;
  }
  return undefined;
}

export interface ContextMessageItem {
  id: string;
  type: 'context_message';
  parentContextId: string;
  message: ContextMessageSummary;
  index: number;
}

export interface ContextToolItem {
  id: string;
  type: 'context_tool';
  parentContextId: string;
  tool: ContextToolSummary;
  index: number;
}

export interface ContextSchemaItem {
  id: string;
  type: 'context_schema';
  parentContextId: string;
  schemaName: string;
}

export type ContextChildItem =
  | ContextMessageItem
  | ContextToolItem
  | ContextSchemaItem;

export interface PendingContextEnd {
  id: string;
  type: 'pending_context_end';
  contextId: string;
}

export interface PendingBlockEnd {
  id: string;
  type: 'pending_block_end';
  invocationId: string;
}

export type PendingBracket = PendingContextEnd | PendingBlockEnd;

export type DisplayEvent =
  | Event
  | DeltaBatchEvent
  | ContextChildItem
  | PendingBracket;

export interface ContextBlock {
  contextEvent?: ModelStartEvent;
  responseEvent?: ModelEndEvent;
  messageItems: ContextMessageItem[];
  toolItems: ContextToolItem[];
  schemaItem?: ContextSchemaItem;
  producedEvents: DisplayEvent[];
  postEvents: DisplayEvent[];
  hasError?: boolean;
  cost?: number;
  streamingMetadata?: Map<string, StreamingMetadata>;
}

export interface InvocationBlock {
  invocationId: string;
  agentName: string;
  kind: InvocationKind;
  parentInvocationId?: string;
  startTime?: number;
  endTime?: number;
  duration?: number;
  loopIteration?: number;
  loopMax?: number;
  state: InvocationState;
  pendingCallIds?: string[];
  yieldIndex?: number;
  events: DisplayEvent[];
  contextBlocks: ContextBlock[];
  preContextEvents: DisplayEvent[];
  postChildEvents: DisplayEvent[];
  children: InvocationBlock[];
  childMap?: Map<string, InvocationBlock>;
  handoffOrigin?: HandoffOrigin;
  handoffTarget?: HandoffTarget;
  transferPredecessor?: InvocationBlock;
  transferSuccessor?: InvocationBlock;
  spawnedFromCallId?: string;
  hasError?: boolean;
  cost?: number;
}

const INVOCATION_EVENT_TYPES = new Set(['invocation_start', 'invocation_end']);

function collapseDeltaEvents(
  events: CLIEvent[],
  idPrefix: string,
): DisplayEvent[] {
  const result: DisplayEvent[] = [];
  let i = 0;
  let batchIndex = 0;

  while (i < events.length) {
    const event = events[i];

    if (event.type === 'thought_delta' || event.type === 'assistant_delta') {
      const deltaType = event.type;
      const batchedEvents: (ThoughtDeltaEvent | AssistantDeltaEvent)[] = [];
      let finalText = '';

      while (i < events.length && events[i].type === deltaType) {
        const delta = events[i] as ThoughtDeltaEvent | AssistantDeltaEvent;
        batchedEvents.push(delta);
        finalText = delta.text;
        i++;
      }

      const batchEvent: DeltaBatchEvent = {
        id: `${idPrefix}-delta-batch-${batchIndex++}`,
        type: 'delta_batch',
        createdAt: (event as ThoughtDeltaEvent | AssistantDeltaEvent).createdAt,
        deltaType,
        count: batchedEvents.length,
        finalText,
        events: batchedEvents,
      };
      result.push(batchEvent);
    } else {
      result.push(event as Event);
      i++;
    }
  }

  return result;
}

function collapseBlockDeltas(block: InvocationBlock): void {
  block.events = collapseDeltaEvents(
    block.events as CLIEvent[],
    block.invocationId,
  );
  for (const child of block.children) {
    collapseBlockDeltas(child);
  }
}

function buildContextBlocksAndPreContext(block: InvocationBlock): void {
  const events = block.events;
  const contextBlocks: ContextBlock[] = [];
  const preContextEvents: DisplayEvent[] = [];
  const postChildEvents: DisplayEvent[] = [];
  let currentContextBlock: ContextBlock | null = null;

  for (const event of events) {
    if (event.type === 'model_start') {
      if (currentContextBlock) {
        contextBlocks.push(currentContextBlock);
      }
      const ctx = event as ModelStartEvent;
      const messageItems: ContextMessageItem[] = ctx.messages.map((msg, i) => ({
        id: `${ctx.id}-msg-${i}`,
        type: 'context_message' as const,
        parentContextId: ctx.id,
        message: msg,
        index: i,
      }));
      const toolItems: ContextToolItem[] = ctx.tools.map((tool, i) => ({
        id: `${ctx.id}-tool-${i}`,
        type: 'context_tool' as const,
        parentContextId: ctx.id,
        tool,
        index: i,
      }));
      const schemaItem: ContextSchemaItem | undefined = ctx.outputSchema
        ? {
            id: `${ctx.id}-schema`,
            type: 'context_schema' as const,
            parentContextId: ctx.id,
            schemaName: ctx.outputSchema,
          }
        : undefined;

      currentContextBlock = {
        contextEvent: ctx,
        messageItems,
        toolItems,
        schemaItem,
        producedEvents: [],
        postEvents: [],
      };
    } else if (event.type === 'model_end') {
      if (currentContextBlock) {
        const endEvent = event as ModelEndEvent;
        currentContextBlock.responseEvent = endEvent;
        if (endEvent.error || endEvent.finishReason === 'error') {
          currentContextBlock.hasError = true;
        }
        if (endEvent.usage && endEvent.modelName) {
          const cost = calculateCost(endEvent.usage, endEvent.modelName);
          if (cost !== null) {
            currentContextBlock.cost = cost;
          }
        }
      }
    } else if (INVOCATION_EVENT_TYPES.has(event.type)) {
      continue;
    } else if (currentContextBlock) {
      if (
        event.type === 'invocation_yield' ||
        event.type === 'invocation_resume'
      ) {
        currentContextBlock.postEvents.push(event);
      } else {
        currentContextBlock.producedEvents.push(event);
      }
    } else if (
      event.type === 'invocation_yield' ||
      event.type === 'invocation_resume'
    ) {
      postChildEvents.push(event);
    } else {
      preContextEvents.push(event);
    }
  }

  if (currentContextBlock) {
    contextBlocks.push(currentContextBlock);
  }

  block.contextBlocks = contextBlocks;
  block.preContextEvents = preContextEvents;
  block.postChildEvents = postChildEvents;

  for (const child of block.children) {
    buildContextBlocksAndPreContext(child);
  }

  const hasContextError = contextBlocks.some((ctx) => ctx.hasError);
  const hasChildError = block.children.some((child) => child.hasError);
  if (hasContextError || hasChildError) {
    block.hasError = true;
  }

  let totalCost = 0;
  for (const ctx of contextBlocks) {
    if (ctx.cost !== undefined) {
      totalCost += ctx.cost;
    }
  }
  for (const child of block.children) {
    if (child.cost !== undefined) {
      totalCost += child.cost;
    }
  }
  if (totalCost > 0) {
    block.cost = totalCost;
  }
}

function linkDeltasToFinalEvents(block: InvocationBlock): void {
  for (const contextBlock of block.contextBlocks) {
    const events = contextBlock.producedEvents;
    const deltaBatches: DeltaBatchEvent[] = [];
    const streamingMap = new Map<string, StreamingMetadata>();

    for (const event of events) {
      if (event.type === 'delta_batch') {
        deltaBatches.push(event as DeltaBatchEvent);
      } else if (event.type === 'assistant') {
        const assistantDelta = deltaBatches.find(
          (d) => d.deltaType === 'assistant_delta',
        );
        if (assistantDelta) {
          streamingMap.set((event as { id: string }).id, {
            chunkCount: assistantDelta.count,
            deltaEvents: assistantDelta.events,
          });
        }
      } else if (event.type === 'thought') {
        const thoughtDelta = deltaBatches.find(
          (d) => d.deltaType === 'thought_delta',
        );
        if (thoughtDelta) {
          streamingMap.set((event as { id: string }).id, {
            chunkCount: thoughtDelta.count,
            deltaEvents: thoughtDelta.events,
          });
        }
      }
    }

    if (streamingMap.size > 0) {
      contextBlock.streamingMetadata = streamingMap;
    }
  }

  for (const child of block.children) {
    linkDeltasToFinalEvents(child);
  }
}

export function buildInvocationBlocks(
  events: readonly CLIEvent[],
): InvocationBlock[] {
  const blockMap = new Map<string, InvocationBlock>();
  const seenEventIds = new Set<string>();
  const roots: InvocationBlock[] = [];
  const preInvocationEvents: CLIEvent[] = [];
  const pendingTransferLinks: Array<{
    block: InvocationBlock;
    sourceInvocationId: string;
  }> = [];
  let currentBlockId: string | null = null;

  for (const event of events) {
    const eventId = (event as { id?: string }).id;
    if (eventId && seenEventIds.has(eventId)) {
      if (event.type === 'invocation_start') {
        currentBlockId = (event as InvocationStartEvent).invocationId;
      }
      continue;
    }
    if (eventId) {
      seenEventIds.add(eventId);
    }

    switch (event.type) {
      case 'invocation_start': {
        const e = event as InvocationStartEvent;
        const block: InvocationBlock = {
          invocationId: e.invocationId,
          agentName: e.agentName,
          kind: e.kind,
          parentInvocationId: e.parentInvocationId,
          startTime: e.createdAt,
          state: 'running',
          events: [event],
          contextBlocks: [],
          preContextEvents: [],
          postChildEvents: [],
          children: [],
          handoffOrigin: e.handoffOrigin,
          spawnedFromCallId:
            e.handoffOrigin?.type === 'spawn'
              ? e.handoffOrigin.callId
              : undefined,
        };
        blockMap.set(e.invocationId, block);
        currentBlockId = e.invocationId;

        if (e.parentInvocationId) {
          const parent = blockMap.get(e.parentInvocationId);
          if (parent) {
            parent.events.push(event);
            if (!parent.childMap) parent.childMap = new Map();
            parent.childMap.set(e.invocationId, block);

            if (parent.kind === 'loop') {
              block.loopIteration = parent.children.length + 1;
            }
            parent.children.push(block);
          }
        } else if (e.handoffOrigin?.type === 'transfer') {
          pendingTransferLinks.push({
            block,
            sourceInvocationId: e.handoffOrigin.invocationId,
          });
        } else {
          roots.push(block);
        }
        break;
      }
      case 'invocation_end': {
        const e = event as InvocationEndEvent;
        const block = blockMap.get(e.invocationId);
        if (block) {
          block.endTime = e.createdAt;
          block.state = e.reason;
          if (block.startTime) {
            block.duration = e.createdAt - block.startTime;
          }
          if (e.handoffTarget) {
            block.handoffTarget = e.handoffTarget;
          }
          if (e.reason === 'error') {
            block.hasError = true;
          }
          block.events.push(event);
        }
        if (currentBlockId === e.invocationId) {
          currentBlockId = e.parentInvocationId ?? null;
        }
        break;
      }
      case 'invocation_yield': {
        const e = event as InvocationYieldEvent;
        const block = blockMap.get(e.invocationId);
        if (block) {
          block.state = 'yielded';
          block.pendingCallIds = e.pendingCallIds;
          block.yieldIndex = e.yieldIndex;
          block.events.push(event);
        }
        break;
      }
      case 'invocation_resume': {
        const e = event as InvocationResumeEvent;
        const block = blockMap.get(e.invocationId);
        if (block) {
          block.state = 'running';
          block.events.push(event);
          currentBlockId = e.invocationId;
        }
        break;
      }
      default: {
        const invocationId = (event as { invocationId?: string }).invocationId;
        if (invocationId) {
          const block = blockMap.get(invocationId);
          if (block) {
            block.events.push(event as DisplayEvent);
          }
        } else if (currentBlockId) {
          const block = blockMap.get(currentBlockId);
          if (block) {
            block.events.push(event as DisplayEvent);
          }
        } else {
          preInvocationEvents.push(event);
        }
        break;
      }
    }
  }

  for (const block of blockMap.values()) {
    if (block.kind === 'loop' && block.children.length > 0) {
      block.loopMax = block.children.length;
      for (const child of block.children) {
        child.loopMax = block.children.length;
      }
    }
  }

  for (const { block, sourceInvocationId } of pendingTransferLinks) {
    const sourceBlock = blockMap.get(sourceInvocationId);
    if (sourceBlock) {
      block.transferPredecessor = sourceBlock;
      sourceBlock.transferSuccessor = block;
      const sourceRootIndex = roots.indexOf(sourceBlock);
      if (sourceRootIndex >= 0) {
        roots.splice(sourceRootIndex + 1, 0, block);
      } else {
        roots.push(block);
      }
    } else {
      roots.push(block);
    }
  }

  if (preInvocationEvents.length > 0) {
    const collapsedPreEvents = collapseDeltaEvents(preInvocationEvents, 'pre');
    if (roots.length > 0) {
      roots[0].events = [...collapsedPreEvents, ...roots[0].events];
    } else {
      const sessionBlock: InvocationBlock = {
        invocationId: 'session',
        agentName: 'Session',
        kind: 'agent',
        state: 'running',
        events: collapsedPreEvents,
        contextBlocks: [],
        preContextEvents: [],
        postChildEvents: [],
        children: [],
      };
      roots.unshift(sessionBlock);
    }
  }

  for (const root of roots) {
    collapseBlockDeltas(root);
    buildContextBlocksAndPreContext(root);
    linkDeltasToFinalEvents(root);
  }

  return roots;
}

export function getEventsInDisplayOrder(
  blocks: InvocationBlock[],
  expandedContextIds: Set<string> = new Set(),
): DisplayEvent[] {
  const result: DisplayEvent[] = [];

  function outputContextBlocks(contextBlocks: ContextBlock[]): void {
    for (const ctx of contextBlocks) {
      if (ctx.contextEvent) {
        result.push(ctx.contextEvent);
        const isExpanded = expandedContextIds.has(ctx.contextEvent.id);
        if (isExpanded) {
          for (const tool of ctx.toolItems) {
            result.push(tool);
          }
          if (ctx.schemaItem) {
            result.push(ctx.schemaItem);
          }
          for (const msg of ctx.messageItems) {
            result.push(msg);
          }
        }
      }
      const hasAssistantEvent = ctx.producedEvents.some(
        (e) => e.type === 'assistant',
      );
      const hasThoughtEvent = ctx.producedEvents.some(
        (e) => e.type === 'thought',
      );
      for (const event of ctx.producedEvents) {
        if (event.type === 'delta_batch') {
          const batch = event as DeltaBatchEvent;
          if (batch.deltaType === 'assistant_delta' && hasAssistantEvent)
            continue;
          if (batch.deltaType === 'thought_delta' && hasThoughtEvent) continue;
        }
        result.push(event);
      }
      if (ctx.responseEvent) {
        result.push(ctx.responseEvent);
      }
      for (const event of ctx.postEvents) {
        result.push(event);
      }
    }
  }

  function traverse(block: InvocationBlock): void {
    const startEvent = block.events.find((e) => e.type === 'invocation_start');
    if (startEvent) result.push(startEvent);

    if (block.kind === 'loop' && block.childMap) {
      for (const event of block.events) {
        if (event.type === 'invocation_start') {
          const childBlock = block.childMap.get(
            (event as InvocationStartEvent).invocationId,
          );
          if (childBlock) {
            traverse(childBlock);
          }
        } else if (!INVOCATION_EVENT_TYPES.has(event.type)) {
          result.push(event);
        }
      }
    } else {
      for (const event of block.preContextEvents) {
        result.push(event);
      }

      const remainingChildren = new Set(block.children);

      for (const contextBlock of block.contextBlocks) {
        outputContextBlocks([contextBlock]);

        const toolCallIds = new Set(
          contextBlock.producedEvents
            .filter((e): e is ToolCallEvent => e.type === 'tool_call')
            .map((e) => e.callId),
        );

        for (const child of remainingChildren) {
          const origin = child.handoffOrigin;
          const callId =
            origin && origin.type !== 'transfer' ? origin.callId : undefined;
          if (callId && toolCallIds.has(callId)) {
            traverse(child);
            remainingChildren.delete(child);
          }
        }
      }

      for (const child of remainingChildren) {
        traverse(child);
      }
    }

    for (const event of block.postChildEvents) {
      result.push(event);
    }

    const endEvent = block.events.find((e) => e.type === 'invocation_end');
    if (endEvent) result.push(endEvent);
  }

  for (const root of blocks) {
    traverse(root);
  }

  return result;
}

export function getPendingBrackets(
  blocks: InvocationBlock[],
): PendingBracket[] {
  const result: PendingBracket[] = [];

  function traverse(block: InvocationBlock): void {
    for (const contextBlock of block.contextBlocks) {
      if (contextBlock.contextEvent && !contextBlock.responseEvent) {
        result.push({
          id: `pending-ctx-end-${contextBlock.contextEvent.id}`,
          type: 'pending_context_end',
          contextId: contextBlock.contextEvent.id,
        });
      }
    }

    for (const child of block.children) {
      traverse(child);
    }

    const hasEndEvent = block.events.some((e) => e.type === 'invocation_end');
    if (!hasEndEvent && block.state !== 'transferred') {
      result.push({
        id: `pending-block-end-${block.invocationId}`,
        type: 'pending_block_end',
        invocationId: block.invocationId,
      });
    }
  }

  for (const root of blocks) {
    traverse(root);
  }

  return result;
}
