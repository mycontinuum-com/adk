import React, { useMemo } from 'react';
// @ts-ignore
import { Box, Text } from 'ink';
import type { InvocationBlock, DisplayEvent, ContextBlock, DeltaBatchEvent } from '../blocks';
import type { ToolCallEvent, UserEvent, AssistantEvent, ThoughtEvent } from '../../types';
import { EventLine } from './EventLine';
import { isHiddenEvent, truncate, getEventConfig } from '../event-display';
import { SyncedSpinner } from './SpinnerContext';
import { useTerminalWidth } from './TerminalContext';
import { formatCost } from '../../providers/pricing';
import {
  renderJsonLine,
  renderThoughtText,
  renderToolCallLine,
  stripJsonNewlines,
  formatThoughtTextMultiLine,
} from '../text-formatting';
import {
  LABEL_WIDTH,
  INDENT_WIDTH,
  MIN_TEXT_WIDTH,
  MIN_CONTINUATION_WIDTH,
  MAX_VISUAL_LINES_PER_EVENT,
  CLEAN_MODE_EVENT_TYPES,
} from '../constants';

const RESET = '\x1b[0m';

function getIndent(depth: number): string {
  return ' '.repeat(depth * INDENT_WIDTH);
}

function formatThoughtTextForCalc(text: string): string {
  return text
    .replace(/\n\n+/g, '\n')
    .replace(/([^\n])\*\*([A-Z])/g, '$1\n**$2');
}

function wrapTextLines(text: string, maxWidth: number): string[] {
  const wrapLine = (sourceLine: string): string[] => {
    if (sourceLine.length <= maxWidth) return [sourceLine];
    
    const leadingMatch = sourceLine.match(/^(\s*)/);
    const leadingSpaces = leadingMatch ? leadingMatch[1] : '';
    const leadingLen = leadingSpaces.length;
    
    const findWrapPoint = (textToWrap: string, width: number): number => {
      if (textToWrap.length <= width) return textToWrap.length;
      const lastSpace = textToWrap.lastIndexOf(' ', width);
      if (lastSpace > width * 0.4) return lastSpace;
      return width;
    };
    
    const wrapped: string[] = [];
    let remaining = sourceLine;
    
    const firstWrap = findWrapPoint(remaining, maxWidth);
    wrapped.push(remaining.slice(0, firstWrap));
    remaining = remaining.slice(firstWrap).trimStart();
    
    const continuationWidth = Math.max(MIN_CONTINUATION_WIDTH, maxWidth - leadingLen);
    while (remaining.length > 0) {
      const wrapAt = findWrapPoint(remaining, continuationWidth);
      wrapped.push(leadingSpaces + remaining.slice(0, wrapAt));
      remaining = remaining.slice(wrapAt).trimStart();
    }
    
    return wrapped;
  };

  const sourceLines = text.split('\n');
  const allWrapped: string[] = [];
  for (const sourceLine of sourceLines) {
    allWrapped.push(...wrapLine(sourceLine));
  }
  return allWrapped;
}

function calculateCleanModeVisualLines(
  line: FlattenedLine,
  terminalWidth: number,
): number {
  if (line.type === 'block_start' || line.type === 'block_end') {
    return 1;
  }
  if (line.type !== 'event' || !line.event) {
    return 1;
  }

  const eventType = line.event.type;
  const isCleanModeType = eventType === 'user' || eventType === 'assistant' || eventType === 'thought' || eventType === 'delta_batch' || eventType === 'tool_call';

  if (!isCleanModeType) {
    return 0;
  }

  let rawText: string;
  if (eventType === 'delta_batch') {
    rawText = (line.event as { finalText: string }).finalText;
  } else if (eventType === 'tool_call') {
    const toolCall = line.event as { name: string; args?: Record<string, unknown> };
    const argsStr = toolCall.args ? JSON.stringify(toolCall.args) : '';
    rawText = argsStr ? `${toolCall.name} ${argsStr}` : toolCall.name;
  } else {
    rawText = (line.event as { text: string }).text;
  }

  const isThoughtType = eventType === 'thought' || (eventType === 'delta_batch' && (line.event as { deltaType?: string }).deltaType === 'thought_delta');
  if (isThoughtType && (!rawText || rawText.trim() === '')) {
    return 0;
  }

  const isInsideModelContext = eventType !== 'user';
  const depth = isInsideModelContext ? Math.max(0, line.depth - 1) : line.depth;
  const indentWidth = depth * INDENT_WIDTH;
  const labelWidth = LABEL_WIDTH;
  const prefixWidth = indentWidth + 1 + 3 + labelWidth + 1;
  const maxTextWidth = Math.max(MIN_TEXT_WIDTH, terminalWidth - prefixWidth - 2);

  let text = rawText;
  const isJson = rawText.trimStart().startsWith('{') || rawText.trimStart().startsWith('[');

  if (isThoughtType) {
    const singleLineThought = rawText.replace(/\s+/g, ' ').trim();
    if (singleLineThought.length <= maxTextWidth) {
      text = singleLineThought;
    } else {
      text = formatThoughtTextForCalc(rawText);
    }
  } else if (isJson) {
    const compactJson = stripJsonNewlines(rawText);
    if (compactJson.length <= maxTextWidth) {
      text = compactJson;
    } else {
      try {
        const parsed = JSON.parse(rawText.trim());
        text = JSON.stringify(parsed, null, 2);
      } catch {
        text = rawText;
      }
    }
  } else {
    const singleLine = rawText.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxTextWidth) {
      text = singleLine;
    }
  }

  const lineCount = wrapTextLines(text, maxTextWidth).length;
  return Math.min(lineCount, MAX_VISUAL_LINES_PER_EVENT);
}


function isLineVisibleInCleanMode(line: FlattenedLine): boolean {
  if (line.type === 'block_start' || line.type === 'block_end') {
    return true;
  }
  if (line.type === 'event' && line.event) {
    if (!CLEAN_MODE_EVENT_TYPES.has(line.event.type)) {
      return false;
    }
    if (line.event.type === 'thought') {
      const text = (line.event as { text?: string }).text;
      if (!text || text.trim() === '') {
        return false;
      }
    }
    if (line.event.type === 'delta_batch') {
      const deltaEvent = line.event as { deltaType?: string; finalText?: string };
      if (deltaEvent.deltaType === 'thought_delta') {
        if (!deltaEvent.finalText || deltaEvent.finalText.trim() === '') {
          return false;
        }
      }
    }
    return true;
  }
  return false;
}


function formatThoughtText(text: string): string {
  return text
    .replace(/\n\n+/g, '\n')
    .replace(/([^\n])\*\*([A-Z])/g, '$1\n**$2');
}

const OUTPUT_EVENT_TYPES = new Set([
  'thought',
  'thought_delta',
  'assistant',
  'assistant_delta',
  'delta_batch',
  'tool_call',
  'tool_result',
  'state_change',
]);

function countBlockEvents(block: InvocationBlock): number {
  let count = 0;
  for (const ctx of block.contextBlocks) {
    for (const event of ctx.producedEvents) {
      if (!OUTPUT_EVENT_TYPES.has(event.type)) continue;
      if (event.type === 'delta_batch') {
        count += (event as { count: number }).count;
      } else {
        count++;
      }
    }
  }
  for (const child of block.children) {
    count += countBlockEvents(child);
  }
  return count;
}

function isBlockActive(block: InvocationBlock): boolean {
  if (block.state === 'running' || block.state === 'yielded') {
    return true;
  }
  for (const child of block.children) {
    if (isBlockActive(child)) {
      return true;
    }
  }
  return false;
}

interface TraceViewProps {
  blocks: InvocationBlock[];
  showDurations?: boolean;
  showIds?: boolean;
  selectedIndex?: number;
  selectableEvents?: DisplayEvent[];
  expandedContextIds?: Set<string>;
  maxHeight?: number;
  scrollOffset?: number;
  pendingCallIds?: Set<string>;
  executingCallIds?: Set<string>;
  contentMode?: boolean;
  precomputedLines?: FlattenedLine[];
  precomputedVisualHeights?: number[];
  precomputedVisualStarts?: number[];
}

type LineType =
  | 'block_start'
  | 'event'
  | 'child_start'
  | 'block_end'
  | 'context_start'
  | 'context_end'
  | 'context_child'
  | 'context_separator';

interface FlattenedLine {
  key: string;
  type: LineType;
  block?: InvocationBlock;
  event?: DisplayEvent;
  contextBlock?: ContextBlock;
  depth: number;
  eventIndex?: number;
}

function flattenBlocks(
  blocks: InvocationBlock[],
  selectableEvents: DisplayEvent[],
  expandedContextIds: Set<string> = new Set(),
  depth: number = 0,
): FlattenedLine[] {
  const lines: FlattenedLine[] = [];
  const selectableIds = new Set(selectableEvents.map((e) => (e as { id?: string }).id));

  function getSelectableIndex(eventId: string | undefined): number | undefined {
    if (!eventId || !selectableIds.has(eventId)) return undefined;
    return selectableEvents.findIndex((e) => (e as { id?: string }).id === eventId);
  }

  function addEvent(event: DisplayEvent, d: number): void {
    if (isHiddenEvent(event)) return;
    const eventId = (event as { id?: string }).id;
    lines.push({
      key: `event-${eventId ?? lines.length}`,
      type: 'event',
      event,
      depth: d,
      eventIndex: getSelectableIndex(eventId),
    });
  }

  function addContextBlocks(contextBlocks: ContextBlock[], d: number): void {
    for (const contextBlock of contextBlocks) {
      const ctx = contextBlock.contextEvent;
      const ctxId = ctx?.id ?? `ctx-${lines.length}`;
      const isExpanded = ctx ? expandedContextIds.has(ctx.id) : false;
      lines.push({
        key: `ctx-start-${ctxId}`,
        type: 'context_start',
        contextBlock,
        depth: d,
        eventIndex: ctx ? getSelectableIndex(ctx.id) : undefined,
        event: ctx,
      });

      if (isExpanded && ctx) {
        for (const toolItem of contextBlock.toolItems) {
          lines.push({
            key: `ctx-child-${toolItem.id}`,
            type: 'context_child',
            event: toolItem,
            depth: d + 1,
            eventIndex: getSelectableIndex(toolItem.id),
          });
        }

        if (contextBlock.schemaItem) {
          lines.push({
            key: `ctx-child-${contextBlock.schemaItem.id}`,
            type: 'context_child',
            event: contextBlock.schemaItem,
            depth: d + 1,
            eventIndex: getSelectableIndex(contextBlock.schemaItem.id),
          });
        }

        for (const msgItem of contextBlock.messageItems) {
          lines.push({
            key: `ctx-child-${msgItem.id}`,
            type: 'context_child',
            event: msgItem,
            depth: d + 1,
            eventIndex: getSelectableIndex(msgItem.id),
          });
        }

        if (contextBlock.producedEvents.length > 0) {
          lines.push({ key: `ctx-sep-${ctxId}`, type: 'context_separator', depth: d });
        }
      }

      const hasAssistantEvent = contextBlock.producedEvents.some((e) => e.type === 'assistant');
      const hasThoughtEvent = contextBlock.producedEvents.some((e) => e.type === 'thought');
      for (const event of contextBlock.producedEvents) {
        if (isHiddenEvent(event)) continue;
        if (event.type === 'delta_batch') {
          const batch = event as { deltaType: string };
          if (batch.deltaType === 'assistant_delta' && hasAssistantEvent) continue;
          if (batch.deltaType === 'thought_delta' && hasThoughtEvent) continue;
        }
        const eventId = (event as { id?: string }).id;
        lines.push({
          key: `event-${eventId ?? lines.length}`,
          type: 'event',
          event,
          depth: d + 1,
          eventIndex: getSelectableIndex(eventId),
        });
      }

      const responseId = contextBlock.responseEvent?.id;
      const pendingCtxEndId = contextBlock.contextEvent
        ? `pending-ctx-end-${contextBlock.contextEvent.id}`
        : undefined;
      lines.push({
        key: `ctx-end-${ctxId}`,
        type: 'context_end',
        contextBlock,
        depth: d,
        eventIndex: responseId
          ? getSelectableIndex(responseId)
          : getSelectableIndex(pendingCtxEndId),
      });

      for (const event of contextBlock.postEvents) {
        if (isHiddenEvent(event)) continue;
        const eventId = (event as { id?: string }).id;
        lines.push({
          key: `event-${eventId ?? lines.length}`,
          type: 'event',
          event,
          depth: d,
          eventIndex: getSelectableIndex(eventId),
        });
      }
    }
  }

  function addBlock(block: InvocationBlock, d: number): void {
    const startEvent = block.events.find((e) => e.type === 'invocation_start');
    const endEvent = block.events.find((e) => e.type === 'invocation_end');

    lines.push({
      key: `block-start-${block.invocationId}`,
      type: 'block_start',
      block,
      depth: d,
      eventIndex: startEvent ? getSelectableIndex((startEvent as { id?: string }).id) : undefined,
    });

    if (block.kind === 'loop' && block.childMap) {
      for (const event of block.events) {
        if (event.type === 'invocation_start') {
          const childBlock = block.childMap.get((event as { invocationId: string }).invocationId);
          if (childBlock) {
            addBlock(childBlock, d + 1);
          }
        } else if (event.type !== 'invocation_end') {
          addEvent(event, d + 1);
        }
      }
    } else {
      for (const event of block.preContextEvents) {
        addEvent(event, d + 1);
      }

      const remainingChildren = new Set(block.children);

      for (const contextBlock of block.contextBlocks) {
        addContextBlocks([contextBlock], d + 1);

        const toolCallIds = new Set(
          contextBlock.producedEvents
            .filter((e): e is ToolCallEvent => e.type === 'tool_call')
            .map((e) => e.callId),
        );

        for (const child of remainingChildren) {
          const origin = child.handoffOrigin;
          const callId = origin && origin.type !== 'transfer' ? origin.callId : undefined;
          if (callId && toolCallIds.has(callId)) {
            addBlock(child, d + 1);
            remainingChildren.delete(child);
          }
        }
      }

      for (const child of remainingChildren) {
        addBlock(child, d + 1);
      }

      for (const event of block.postChildEvents) {
        addEvent(event, d + 1);
      }
    }

    const pendingBlockEndId = `pending-block-end-${block.invocationId}`;
    lines.push({
      key: `block-end-${block.invocationId}`,
      type: 'block_end',
      block,
      depth: d,
      eventIndex: endEvent
        ? getSelectableIndex((endEvent as { id?: string }).id)
        : getSelectableIndex(pendingBlockEndId),
    });
  }

  for (const block of blocks) {
    addBlock(block, depth);
  }

  return lines;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TraceView({
  blocks,
  showDurations = true,
  showIds = false,
  selectedIndex,
  selectableEvents = [],
  expandedContextIds = new Set(),
  maxHeight,
  scrollOffset = 0,
  pendingCallIds,
  executingCallIds,
  contentMode = false,
  precomputedLines,
  precomputedVisualHeights,
  precomputedVisualStarts,
}: TraceViewProps): React.ReactElement {
  const terminalWidth = useTerminalWidth();
  
  const lines = useMemo(() => {
    if (precomputedLines) return precomputedLines;
    const allLines = flattenBlocks(blocks, selectableEvents, expandedContextIds);
    if (!contentMode) return allLines;
    return allLines.filter(isLineVisibleInCleanMode);
  }, [precomputedLines, blocks, selectableEvents, expandedContextIds, contentMode]);

  const totalVisualLines = useMemo(() => {
    if (precomputedVisualHeights) {
      return precomputedVisualHeights.reduce((sum, h) => sum + h, 0);
    }
    if (!contentMode) return lines.length;
    let total = 0;
    for (const line of lines) {
      total += calculateCleanModeVisualLines(line, terminalWidth);
    }
    return total;
  }, [precomputedVisualHeights, lines, contentMode, terminalWidth]);

  const visualLineHeights = useMemo(() => {
    if (precomputedVisualHeights) return precomputedVisualHeights;
    if (!contentMode) return null;
    return lines.map(line => calculateCleanModeVisualLines(line, terminalWidth));
  }, [precomputedVisualHeights, lines, contentMode, terminalWidth]);

  const visualLineStarts = useMemo(() => {
    if (precomputedVisualStarts) return precomputedVisualStarts;
    if (!contentMode) return null;
    if (!visualLineHeights) return null;
    const starts: number[] = [];
    let cumulative = 0;
    for (const height of visualLineHeights) {
      starts.push(cumulative);
      cumulative += height;
    }
    return starts;
  }, [precomputedVisualStarts, visualLineHeights, contentMode]);

  const contentHeight = useMemo(() => {
    if (maxHeight === undefined) return undefined;
    const atTop = scrollOffset === 0;
    const conservativeHeight = maxHeight - (atTop ? 1 : 2);
    const atBottom = scrollOffset + conservativeHeight >= totalVisualLines - 1;
    if (atTop && atBottom) {
      return maxHeight;
    } else if (atTop) {
      return maxHeight - 1;
    } else if (atBottom) {
      return maxHeight - 1;
    } else {
      return maxHeight - 2;
    }
  }, [maxHeight, scrollOffset, totalVisualLines]);

  const clampedScrollOffset = contentHeight !== undefined
    ? Math.min(scrollOffset, Math.max(0, totalVisualLines - contentHeight))
    : scrollOffset;

  const { visibleLines, linesAbove, linesBelow, renderedVisualLines, partialLine, partialLineMaxVisual, partialLineIsTruncated, topPartialSkipLines } = useMemo(() => {
    if (contentHeight === undefined || lines.length === 0) {
      return { visibleLines: lines, linesAbove: 0, linesBelow: 0, renderedVisualLines: 0, partialLine: null, partialLineMaxVisual: 0, partialLineIsTruncated: false, topPartialSkipLines: 0 };
    }

    const viewportStart = clampedScrollOffset;
    const isSimpleMode = !contentMode && !visualLineHeights;

    let startIdx = 0;
    let topSkip = 0;
    
    if (isSimpleMode) {
      startIdx = Math.min(Math.floor(viewportStart), lines.length - 1);
      startIdx = Math.max(0, startIdx);
    } else {
      for (let i = 0; i < lines.length; i++) {
        const lineStart = visualLineStarts?.[i] ?? i;
        const lineHeight = visualLineHeights?.[i] ?? 1;
        const lineEnd = lineStart + lineHeight;
        
        if (lineEnd <= viewportStart) {
          startIdx = i + 1;
        } else if (lineStart < viewportStart) {
          startIdx = i;
          topSkip = viewportStart - lineStart;
          break;
        } else {
          break;
        }
      }
    }

    let endIdx = startIdx;
    let usedHeight = 0;
    
    if (isSimpleMode) {
      endIdx = Math.min(startIdx + contentHeight, lines.length);
      usedHeight = endIdx - startIdx;
    } else {
      for (let i = startIdx; i < lines.length; i++) {
        const lineHeight = visualLineHeights?.[i] ?? 1;
        const effectiveHeight = i === startIdx ? lineHeight - topSkip : lineHeight;
        
        if (usedHeight + effectiveHeight <= contentHeight) {
          usedHeight += effectiveHeight;
          endIdx = i + 1;
        } else {
          break;
        }
      }
    }

    const remainingSpace = contentHeight - usedHeight;
    let partial: FlattenedLine | null = null;
    let partialMax = 0;
    let partialFullHeight = 0;
    let partialIsTruncated = false;
    
    if (contentMode && !isSimpleMode && endIdx < lines.length && remainingSpace >= 1) {
      partial = lines[endIdx];
      partialFullHeight = visualLineHeights?.[endIdx] ?? 1;
      
      if (partialFullHeight <= remainingSpace) {
        partialMax = partialFullHeight;
        partialIsTruncated = false;
      } else if (remainingSpace >= 2) {
        partialMax = remainingSpace - 1;
        partialIsTruncated = true;
      } else {
        partial = null;
      }
    }

    const above = clampedScrollOffset;
    const partialRenderedHeight = partial ? (partialIsTruncated ? partialMax + 1 : partialMax) : 0;
    const below = isSimpleMode
      ? totalVisualLines - endIdx
      : (partial 
          ? totalVisualLines - (visualLineStarts?.[endIdx] ?? endIdx) - partialRenderedHeight
          : (endIdx < lines.length ? totalVisualLines - (visualLineStarts?.[endIdx] ?? endIdx) : 0));

    return {
      visibleLines: lines.slice(startIdx, endIdx),
      linesAbove: above,
      linesBelow: Math.max(0, below),
      renderedVisualLines: usedHeight + partialRenderedHeight,
      partialLine: partial,
      partialLineMaxVisual: partialMax,
      partialLineIsTruncated: partialIsTruncated,
      topPartialSkipLines: topSkip,
    };
  }, [lines, contentHeight, clampedScrollOffset, visualLineStarts, visualLineHeights, totalVisualLines, contentMode]);

  const hasScrollableContent = contentHeight !== undefined && totalVisualLines > contentHeight;
  const showMoreAbove = hasScrollableContent && linesAbove > 1;
  const showMoreBelow = hasScrollableContent && linesBelow > 1;

  return (
    <Box flexDirection="column">
      {showMoreAbove && (
        <Text dimColor> ↑ {linesAbove} more above</Text>
      )}
      {visibleLines.map((line, idx) => {
        const indent = getIndent(line.depth);

        if (line.type === 'block_start' && line.block) {
          const isSelected = line.eventIndex === selectedIndex;
          const handoffType = line.block.handoffOrigin?.type;
          const isSpawn = handoffType === 'spawn';
          const isDispatch = handoffType === 'dispatch';
          const isTransfer = handoffType === 'transfer';
          const isRunning = line.block.state === 'running';
          const isYielded = line.block.state === 'yielded';
          const hasError = line.block.hasError;
          const loopLabel = line.block.loopIteration !== undefined && line.block.loopMax !== undefined
            ? ` ${line.block.loopIteration}/${line.block.loopMax}`
            : null;
          
          const kindIndicator = {
            agent: <Text color="gray" dimColor> ◆ agent</Text>,
            step: <Text color="gray" dimColor> ▸ step</Text>,
            sequence: <Text color="gray" dimColor> → sequence</Text>,
            parallel: <Text color="gray" dimColor> ║ parallel</Text>,
            loop: <Text color="gray" dimColor> ○ loop</Text>,
          }[line.block.kind] ?? null;

          let edgeIndicator: React.ReactNode = null;
          if (isSpawn) {
            edgeIndicator = <Text color="gray" dimColor>:spawn</Text>;
          } else if (isDispatch) {
            edgeIndicator = <Text color="gray" dimColor>:dispatch</Text>;
          } else if (isTransfer) {
            edgeIndicator = <Text color="gray" dimColor>:transfer</Text>;
          }
          
          const startChar = isSpawn || isDispatch ? '╠═' : '┌─';
          const startColor = hasError ? 'redBright' : (isRunning || isYielded) ? 'yellowBright' : 'cyanBright';
          
          const blockActive = isBlockActive(line.block);
          const eventCount = blockActive ? countBlockEvents(line.block) : 0;
          
          const showBlockMeta = !contentMode;
          return (
            <Box key={line.key}>
              <Text>{RESET}{indent}{isSelected ? '▸' : ' '}</Text>
              <Text color={startColor}>{startChar}</Text>
              <Text> </Text>
              <Text bold={!contentMode} dimColor={contentMode}>{line.block.agentName}</Text>
              {showIds && <Text color="gray" dimColor> ({line.block.invocationId})</Text>}
              {showBlockMeta && kindIndicator}
              {showBlockMeta && edgeIndicator}
              {showBlockMeta && loopLabel && <Text color="gray" dimColor>{loopLabel}</Text>}
              {showBlockMeta && blockActive && eventCount > 0 && <Text color="gray" dimColor> [{eventCount}]</Text>}
              {(isRunning || isYielded) && !hasError && <Text> <SyncedSpinner /></Text>}
            </Box>
          );
        }

        if (line.type === 'event' && line.event) {
          const isSelected = line.eventIndex === selectedIndex;
          const eventType = line.event.type;
          const isCleanModeType = eventType === 'user' || eventType === 'assistant' || eventType === 'thought' || eventType === 'delta_batch' || eventType === 'tool_call';
          const useCleanModeRendering = eventType === 'user' || eventType === 'assistant' || eventType === 'thought' || eventType === 'delta_batch' || eventType === 'tool_call';
          
          if (contentMode && !isCleanModeType) {
            return null;
          }
          
          if (contentMode && useCleanModeRendering) {
            let rawText: string;
            let displayLabel: string;
            let displayColor: string;
            let isPendingYield = false;
            
            if (eventType === 'delta_batch') {
              const deltaBatch = line.event as DeltaBatchEvent;
              rawText = deltaBatch.finalText;
              const isThoughtDelta = deltaBatch.deltaType === 'thought_delta';
              displayLabel = isThoughtDelta ? 'think' : 'output';
              displayColor = isThoughtDelta ? 'gray' : 'greenBright';
            } else if (eventType === 'tool_call') {
              const toolCall = line.event as ToolCallEvent;
              const argsStr = toolCall.args ? JSON.stringify(toolCall.args) : '';
              rawText = argsStr ? `${toolCall.name} ${argsStr}` : toolCall.name;
              displayLabel = 'call';
              isPendingYield = !!(toolCall.yields && pendingCallIds?.has(toolCall.callId));
              displayColor = isPendingYield ? 'yellowBright' : 'cyanBright';
            } else {
              rawText = (line.event as UserEvent | AssistantEvent | ThoughtEvent).text;
              const config = getEventConfig(line.event);
              displayLabel = config.label;
              displayColor = config.color;
            }
            
            const isThoughtType = eventType === 'thought' || (eventType === 'delta_batch' && (line.event as DeltaBatchEvent).deltaType === 'thought_delta');
            if (isThoughtType && (!rawText || rawText.trim() === '')) {
              return null;
            }
            
            const isStreaming = eventType === 'delta_batch';
            const showSpinner = isStreaming || isPendingYield;
            const spinnerWidth = showSpinner ? 2 : 0;
            const isInsideModelContext = eventType !== 'user';
            const contentModeIndent = isInsideModelContext ? getIndent(Math.max(0, line.depth - 1)) : indent;
            const selectionIndicator = isSelected ? '▸' : ' ';
            const labelWidth = LABEL_WIDTH;
            const labelPadding = ' '.repeat(Math.max(0, labelWidth - displayLabel.length - spinnerWidth));
            const continuationPadding = ' '.repeat(labelWidth + 1);
            const indentWidth = contentModeIndent.length;
            const prefixWidth = indentWidth + 1 + 3 + labelWidth + 1;
            const maxTextWidth = Math.max(MIN_TEXT_WIDTH, terminalWidth - prefixWidth - 2);
            
            let text = rawText;
            const isJson = rawText.trimStart().startsWith('{') || rawText.trimStart().startsWith('[');
            
            if (isThoughtType) {
              const singleLineThought = rawText.replace(/\s+/g, ' ').trim();
              if (singleLineThought.length <= maxTextWidth) {
                text = singleLineThought;
              } else {
                text = formatThoughtTextMultiLine(rawText);
              }
            } else if (isJson) {
              const compactJson = stripJsonNewlines(rawText);
              if (compactJson.length <= maxTextWidth) {
                text = compactJson;
              } else {
                try {
                  const parsed = JSON.parse(rawText.trim());
                  text = JSON.stringify(parsed, null, 2);
                } catch {
                  text = rawText;
                }
              }
            } else {
              const singleLine = rawText.replace(/\s+/g, ' ').trim();
              if (singleLine.length <= maxTextWidth) {
                text = singleLine;
              }
            }
            
            const wrapLine = (sourceLine: string): string[] => {
              if (sourceLine.length <= maxTextWidth) return [sourceLine];
              
              const leadingMatch = sourceLine.match(/^(\s*)/);
              const leadingSpaces = leadingMatch ? leadingMatch[1] : '';
              const leadingLen = leadingSpaces.length;
              
              const findWrapPoint = (textToWrap: string, width: number): number => {
                if (textToWrap.length <= width) return textToWrap.length;
                const lastSpace = textToWrap.lastIndexOf(' ', width);
                if (lastSpace > width * 0.4) return lastSpace;
                return width;
              };
              
              const wrapped: string[] = [];
              let remaining = sourceLine;
              
              const firstWrap = findWrapPoint(remaining, maxTextWidth);
              wrapped.push(remaining.slice(0, firstWrap));
              remaining = remaining.slice(firstWrap).trimStart();
              
              const continuationWidth = Math.max(10, maxTextWidth - leadingLen);
              while (remaining.length > 0) {
                const wrapAt = findWrapPoint(remaining, continuationWidth);
                wrapped.push(leadingSpaces + remaining.slice(0, wrapAt));
                remaining = remaining.slice(wrapAt).trimStart();
              }
              
              return wrapped;
            };
            
            const sourceLines = text.split('\n');
            const allLines: { text: string; isFirst: boolean; isFirstOfSource: boolean }[] = [];
            sourceLines.forEach((sourceLine, srcIdx) => {
              const wrapped = wrapLine(sourceLine);
              wrapped.forEach((wrappedLine, wrapIdx) => {
                allLines.push({
                  text: wrappedLine,
                  isFirst: srcIdx === 0 && wrapIdx === 0,
                  isFirstOfSource: wrapIdx === 0,
                });
              });
            });
            
            const isAssistantType = eventType === 'assistant' || (eventType === 'delta_batch' && (line.event as DeltaBatchEvent).deltaType === 'assistant_delta');
            const isToolCallType = eventType === 'tool_call';
            const jsonKeyColor = isAssistantType ? 'greenBright' : isToolCallType ? displayColor : null;
            const isDimmedLabel = (isThoughtType || isToolCallType) && !isPendingYield && !isStreaming;
            
            const skipTopLines = idx === 0 ? topPartialSkipLines : 0;
            const willTruncate = allLines.length > MAX_VISUAL_LINES_PER_EVENT && skipTopLines === 0;
            const cappedTotalLines = willTruncate 
              ? MAX_VISUAL_LINES_PER_EVENT - 1
              : Math.min(allLines.length, MAX_VISUAL_LINES_PER_EVENT);
            const remainingLines = Math.max(0, cappedTotalLines - skipTopLines);
            const linesToRender = allLines.slice(skipTopLines, skipTopLines + remainingLines);
            const isTopPartial = skipTopLines > 0;
            const hiddenLinesCount = allLines.length - cappedTotalLines;
            
            return (
              <Box key={line.key} flexDirection="column">
                {linesToRender.map((lineData, lineIdx) => {
                  const isFirstRenderedLine = lineIdx === 0;
                  const showAsFirst = lineData.isFirst && !isTopPartial;
                  return (
                    <Box key={`${line.key}-${lineIdx}`}>
                      <Text>{RESET}{contentModeIndent}</Text>
                      <Text>{isFirstRenderedLine && isSelected ? selectionIndicator : ' '}</Text>
                      <Text dimColor>{showAsFirst ? '├─ ' : '│  '}</Text>
                      {showAsFirst ? (
                        <Text dimColor={isDimmedLabel && !isPendingYield}><Text color={displayColor} dimColor={isToolCallType && !isPendingYield}>{displayLabel}</Text>{showSpinner && <><Text> </Text><SyncedSpinner color={displayColor} /></>}{labelPadding} </Text>
                      ) : (
                        <Text dimColor>{continuationPadding}</Text>
                      )}
                      {isThoughtType ? renderThoughtText(lineData.text, true) : isToolCallType ? renderToolCallLine(lineData.text, displayColor, isDimmedLabel) : jsonKeyColor ? renderJsonLine(lineData.text, jsonKeyColor, isDimmedLabel) : <Text dimColor={isDimmedLabel}>{lineData.text || ' '}</Text>}
                    </Box>
                  );
                })}
                {hiddenLinesCount > 0 && skipTopLines === 0 && (
                  <Box key={`${line.key}-truncated`}>
                    <Text>{RESET}{contentModeIndent}</Text>
                    <Text> </Text>
                    <Text dimColor>│  </Text>
                    <Text dimColor>{continuationPadding}... ({hiddenLinesCount} more lines)</Text>
                  </Box>
                )}
              </Box>
            );
          }
          
          const isInsideModelContext = eventType !== 'user';
          const eventIndent = (contentMode && isInsideModelContext) ? getIndent(Math.max(0, line.depth - 1)) : indent;
          const eventDepth = (contentMode && isInsideModelContext) ? Math.max(0, line.depth - 1) : line.depth;
          const skipHighlight = line.event.type === 'tool_result';
          return (
            <Box key={line.key}>
              <Text>{RESET}{eventIndent}</Text>
              <EventLine event={line.event} isSelected={isSelected} pendingCallIds={pendingCallIds} executingCallIds={executingCallIds} depth={eventDepth} skipHighlighting={skipHighlight} />
            </Box>
          );
        }


        if (line.type === 'context_start' && line.contextBlock) {
          if (contentMode) return null;
          const isSelected = line.eventIndex === selectedIndex;
          const isPending = !line.contextBlock.responseEvent;
          const hasError = line.contextBlock.hasError;
          const bracketColor = hasError ? 'redBright' : isPending ? 'yellowBright' : 'magentaBright';
          return (
            <Box key={line.key}>
              <Text>
                {RESET}{indent}{isSelected ? '▸' : ' '}
                <Text color={bracketColor}>┌─</Text>{' '}
                <Text color='magentaBright'>model</Text>
                {isPending && !hasError && (
                  <>
                    <Text> </Text>
                    <SyncedSpinner color="magentaBright" />
                  </>
                )}
              </Text>
            </Box>
          );
        }

        if (line.type === 'context_child' && line.event) {
          if (contentMode) return null;
          const isSelected = line.eventIndex === selectedIndex;
          const skipHighlight = line.event.type === 'tool_result';
          return (
            <Box key={line.key}>
              <Text>{RESET}{indent}</Text>
              <EventLine event={line.event} isSelected={isSelected} pendingCallIds={pendingCallIds} executingCallIds={executingCallIds} depth={line.depth} skipHighlighting={skipHighlight} />
            </Box>
          );
        }

        if (line.type === 'context_separator') {
          if (contentMode) return null;
          return (
            <Box key={line.key}>
              <Text>{RESET}{indent} <Text color="magentaBright">├─</Text></Text>
            </Box>
          );
        }

        if (line.type === 'context_end' && line.contextBlock) {
          if (contentMode) return null;
          const response = line.contextBlock.responseEvent;
          const isPending = !response;
          const hasError = line.contextBlock.hasError;
          const isSelected = line.eventIndex === selectedIndex;
          const bracketColor = hasError ? 'redBright' : isPending ? 'yellowBright' : 'magentaBright';
          const durationStr = response ? formatDuration(response.durationMs) : '';
          const costStr = line.contextBlock.cost !== undefined ? ` • ${formatCost(line.contextBlock.cost)}` : '';
          const prefixLen = indent.length + 4 + durationStr.length + costStr.length + 3;
          const errorMaxLen = Math.max(20, terminalWidth - prefixLen);
          return (
            <Box key={line.key}>
              <Text>
                {RESET}{indent}{isSelected ? '▸' : ' '}
                <Text color={bracketColor}>└─</Text>
                {!isPending && (
                <Text color="gray" dimColor>
                  {' '}{durationStr}{costStr}
                </Text>
                )}
                {Boolean(response?.error) && (
                  <Text color="redBright"> • {truncate(response!.error!, errorMaxLen)}</Text>
                )}
              </Text>
            </Box>
          );
        }

        if (line.type === 'block_end' && line.block) {
          const block = line.block;
          const isRunning = block.state === 'running';
          const isYielded = block.state === 'yielded';
          const hasError = block.hasError;
          const isSelected = line.eventIndex === selectedIndex;
          const isSpawnOrDispatch = block.handoffOrigin?.type === 'spawn' || block.handoffOrigin?.type === 'dispatch';
          const isTransferred = block.state === 'transferred';
          const endChar = isSpawnOrDispatch ? '╚═' : '└─';
          const endColor = hasError ? 'redBright' : (isRunning || isYielded) ? 'yellowBright' : 'cyanBright';
          
          const endEvent = block.events.find((e) => e.type === 'invocation_end') as { error?: string } | undefined;
          const errorMsg = endEvent?.error;
          const childHasError = block.children.some((c) => c.hasError) || 
                                block.contextBlocks.some((c) => c.hasError);
          const showError = Boolean(errorMsg) && !childHasError;
          const costStr = block.cost !== undefined ? formatCost(block.cost) : '';
          
          let statusContent: React.ReactNode;
          if (contentMode) {
            statusContent = null;
          } else if (isRunning || isYielded) {
            statusContent = Boolean(costStr) ? <Text color="gray" dimColor>{costStr}</Text> : null;
          } else if (isTransferred && block.handoffTarget) {
            const durationStr = showDurations && block.duration !== undefined
              ? formatDuration(block.duration)
              : '';
            statusContent = (
              <>
                <Text color="yellowBright" dimColor>{block.handoffTarget.agentName}</Text>
                {Boolean(durationStr) && <Text color="gray" dimColor> • {durationStr}</Text>}
                {Boolean(costStr) && <Text color="gray" dimColor> • {costStr}</Text>}
              </>
            );
          } else if (showDurations && block.duration !== undefined) {
            statusContent = (
              <>
                <Text color="gray" dimColor>{formatDuration(block.duration)}</Text>
                {Boolean(costStr) && <Text color="gray" dimColor> • {costStr}</Text>}
              </>
            );
          } else {
            statusContent = (
              <>
                <Text color="gray" dimColor>{block.state}</Text>
                {Boolean(costStr) && <Text color="gray" dimColor> • {costStr}</Text>}
              </>
            );
          }
          
          return (
            <Box key={line.key}>
              <Text>{RESET}{indent}</Text>
              <Text>{isSelected ? '▸' : ' '}</Text>
              <Text color={endColor}>{endChar}</Text>
              <Text> </Text>
              {statusContent}
              {showError && (
                <Text color="redBright"> • {truncate(errorMsg!, Math.max(20, terminalWidth - indent.length - 20))}</Text>
              )}
            </Box>
          );
        }

        return null;
      })}
      {partialLine && contentMode && partialLineMaxVisual > 0 && (() => {
        const line = partialLine;
        const indent = getIndent(line.depth);
        
        if (line.type === 'event' && line.event) {
          const event = line.event;
          const isSelected = line.eventIndex === selectedIndex;
          const config = getEventConfig(event);
          const labelColor = config?.color ?? 'gray';
          const label = config?.label ?? event.type;
          
          let text = '';
          if (event.type === 'delta_batch') {
            text = (event as DeltaBatchEvent).finalText;
          } else if (event.type === 'tool_call') {
            const toolCall = event as ToolCallEvent;
            const argsStr = toolCall.args ? JSON.stringify(toolCall.args) : '';
            text = argsStr ? `${toolCall.name} ${argsStr}` : toolCall.name;
          } else {
            text = (event as { text: string }).text;
          }
          
          const isThought = event.type === 'thought' || (event.type === 'delta_batch' && (event as DeltaBatchEvent).deltaType === 'thought_delta');
          if (isThought) {
            text = text.replace(/\n\n+/g, '\n');
          } else {
            try {
              const parsed = JSON.parse(text.trim());
              text = JSON.stringify(parsed, null, 2);
            } catch {
              // Not JSON
            }
          }
          
          const isInsideModelContext = event.type !== 'user';
          const depth = isInsideModelContext ? Math.max(0, line.depth - 1) : line.depth;
          const depthIndent = getIndent(depth);
          const paddedLabel = label.padEnd(LABEL_WIDTH);
          const prefixWidth = depth * INDENT_WIDTH + 1 + 3 + LABEL_WIDTH + 1;
          const maxTextWidth = Math.max(40, terminalWidth - prefixWidth - 2);
          
          const wrapLine = (sourceLine: string): string[] => {
            if (sourceLine.length <= maxTextWidth) return [sourceLine];
            const leadingMatch = sourceLine.match(/^(\s*)/);
            const leadingSpaces = leadingMatch ? leadingMatch[1] : '';
            const leadingLen = leadingSpaces.length;
            const findWrapPoint = (textToWrap: string, width: number): number => {
              if (textToWrap.length <= width) return textToWrap.length;
              const lastSpace = textToWrap.lastIndexOf(' ', width);
              if (lastSpace > width * 0.4) return lastSpace;
              return width;
            };
            const wrapped: string[] = [];
            let remaining = sourceLine;
            const firstWrap = findWrapPoint(remaining, maxTextWidth);
            wrapped.push(remaining.slice(0, firstWrap));
            remaining = remaining.slice(firstWrap).trimStart();
            const continuationWidth = Math.max(10, maxTextWidth - leadingLen);
            while (remaining.length > 0) {
              const wrapAt = findWrapPoint(remaining, continuationWidth);
              wrapped.push(leadingSpaces + remaining.slice(0, wrapAt));
              remaining = remaining.slice(wrapAt).trimStart();
            }
            return wrapped;
          };
          
          const sourceLines = text.split('\n');
          const allWrappedLines: { text: string; isFirst: boolean; isFirstOfSource: boolean }[] = [];
          sourceLines.forEach((sourceLine, srcIdx) => {
            const wrapped = wrapLine(sourceLine);
            wrapped.forEach((wrappedLine, wrapIdx) => {
              allWrappedLines.push({
                text: wrappedLine,
                isFirst: srcIdx === 0 && wrapIdx === 0,
                isFirstOfSource: wrapIdx === 0,
              });
            });
          });
          
          const linesToRender = allWrappedLines.slice(0, partialLineMaxVisual);
          
          return (
            <React.Fragment key={`partial-${line.key}`}>
              {linesToRender.map((wrappedLine, wrapIdx) => {
                const treeChar = wrappedLine.isFirstOfSource ? '│' : '│';
                const continueIndent = ' '.repeat(LABEL_WIDTH + 3);
                
                if (wrappedLine.isFirst) {
                  return (
                    <Box key={`partial-wrap-${wrapIdx}`}>
                      <Text>
                        {RESET}{depthIndent}{isSelected ? '▸' : ' '}
                        <Text color="gray" dimColor>{treeChar}</Text>
                        <Text color="gray" dimColor>─ </Text>
                        <Text color={labelColor}>{paddedLabel}</Text>
                        {isThought ? renderThoughtText(wrappedLine.text, true) : (
                          event.type === 'assistant' ? renderJsonLine(wrappedLine.text, labelColor, false) :
                          <Text>{wrappedLine.text || ' '}</Text>
                        )}
                      </Text>
                    </Box>
                  );
                } else {
                  return (
                    <Box key={`partial-wrap-${wrapIdx}`}>
                      <Text>
                        {RESET}{depthIndent} <Text color="gray" dimColor>{treeChar}</Text>
                        {continueIndent}
                        {isThought ? renderThoughtText(wrappedLine.text, true) : (
                          event.type === 'assistant' ? renderJsonLine(wrappedLine.text, labelColor, false) :
                          <Text>{wrappedLine.text || ' '}</Text>
                        )}
                      </Text>
                    </Box>
                  );
                }
              })}
              {partialLineIsTruncated && (
                <Box key="partial-truncated">
                  <Text>
                    {depthIndent} <Text color="gray" dimColor>│</Text>
                    {' '.repeat(LABEL_WIDTH + 3)}
                    <Text dimColor>...</Text>
                  </Text>
                </Box>
              )}
            </React.Fragment>
          );
        }
        return null;
      })()}
      {(() => {
        if (maxHeight === undefined) return null;
        if (!hasScrollableContent) return null;
        const topIndicatorLines = showMoreAbove ? 1 : 0;
        const bottomIndicatorLines = showMoreBelow ? 1 : 0;
        const totalUsed = topIndicatorLines + renderedVisualLines + bottomIndicatorLines;
        const paddingNeeded = maxHeight - totalUsed;
        if (paddingNeeded <= 0) return null;
        return Array.from({ length: paddingNeeded }, (_, i) => (
          <Box key={`padding-${i}`}><Text> </Text></Box>
        ));
      })()}
      {showMoreBelow && (
        <Text dimColor> ↓ {linesBelow} more below</Text>
      )}
    </Box>
  );
}

export { flattenBlocks, calculateCleanModeVisualLines };
export type { FlattenedLine };

export function buildEventIndexToLineMap(lines: FlattenedLine[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const eventIndex = lines[i].eventIndex;
    if (eventIndex !== undefined) {
      map.set(eventIndex, i);
    }
  }
  return map;
}

export function getLineIndexForEvent(
  lines: FlattenedLine[],
  eventIndex: number,
  lookupMap?: Map<number, number>,
): number {
  if (lookupMap) {
    return lookupMap.get(eventIndex) ?? 0;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].eventIndex === eventIndex) {
      return i;
    }
  }
  return 0;
}

export function findBlockEndEventIndex(
  lines: FlattenedLine[],
  currentLineIndex: number,
): number | undefined {
  if (currentLineIndex < 0 || currentLineIndex >= lines.length) {
    return undefined;
  }

  const currentLine = lines[currentLineIndex];
  const currentDepth = currentLine.depth;

  if (currentLine.type === 'block_end' || currentLine.type === 'context_end') {
    for (let i = currentLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.depth < currentDepth) {
        if (
          (line.type === 'block_end' || line.type === 'context_end') &&
          line.eventIndex !== undefined
        ) {
          return line.eventIndex;
        }
      }
      if (
        (line.type === 'block_end' || line.type === 'context_end') &&
        line.depth === currentDepth &&
        line.eventIndex !== undefined
      ) {
        return line.eventIndex;
      }
    }
    return undefined;
  }

  if (currentLine.type === 'block_start' && currentLine.block) {
    const invocationId = currentLine.block.invocationId;
    for (let i = currentLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.type === 'block_end' &&
        line.block?.invocationId === invocationId &&
        line.eventIndex !== undefined
      ) {
        return line.eventIndex;
      }
    }
    return undefined;
  }

  if (currentLine.type === 'context_start' && currentLine.contextBlock) {
    const contextId = currentLine.contextBlock.contextEvent?.id;
    for (let i = currentLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.type === 'context_end' &&
        line.contextBlock?.contextEvent?.id === contextId &&
        line.eventIndex !== undefined
      ) {
        return line.eventIndex;
      }
    }
    return undefined;
  }

  for (let i = currentLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (
      (line.type === 'block_end' || line.type === 'context_end') &&
      line.depth <= currentDepth &&
      line.eventIndex !== undefined
    ) {
      return line.eventIndex;
    }
  }

  return undefined;
}

export function findBlockStartEventIndex(
  lines: FlattenedLine[],
  currentLineIndex: number,
): number | undefined {
  if (currentLineIndex < 0 || currentLineIndex >= lines.length) {
    return undefined;
  }

  const currentLine = lines[currentLineIndex];
  const currentDepth = currentLine.depth;

  if (
    currentLine.type === 'block_start' ||
    currentLine.type === 'context_start'
  ) {
    for (let i = currentLineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.depth < currentDepth) {
        if (
          (line.type === 'block_start' || line.type === 'context_start') &&
          line.eventIndex !== undefined
        ) {
          return line.eventIndex;
        }
      }
      if (
        (line.type === 'block_start' || line.type === 'context_start') &&
        line.depth === currentDepth &&
        line.eventIndex !== undefined
      ) {
        return line.eventIndex;
      }
    }
    return undefined;
  }

  if (currentLine.type === 'block_end' && currentLine.block) {
    const invocationId = currentLine.block.invocationId;
    for (let i = currentLineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      if (
        line.type === 'block_start' &&
        line.block?.invocationId === invocationId &&
        line.eventIndex !== undefined
      ) {
        return line.eventIndex;
      }
    }
    return undefined;
  }

  if (currentLine.type === 'context_end' && currentLine.contextBlock) {
    const contextId = currentLine.contextBlock.contextEvent?.id;
    for (let i = currentLineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      if (
        line.type === 'context_start' &&
        line.contextBlock?.contextEvent?.id === contextId &&
        line.eventIndex !== undefined
      ) {
        return line.eventIndex;
      }
    }
    return undefined;
  }

  for (let i = currentLineIndex - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      (line.type === 'block_start' || line.type === 'context_start') &&
      line.depth <= currentDepth &&
      line.eventIndex !== undefined
    ) {
      return line.eventIndex;
    }
  }

  return undefined;
}
