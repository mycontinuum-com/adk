import React, { memo, useMemo } from 'react';
// @ts-ignore
import { Box, Text } from 'ink';
import type { DisplayEvent, DeltaBatchEvent } from '../blocks';
import type { ToolCallEvent, ToolResultEvent, ThoughtEvent, AssistantEvent } from '../../types';
import { getEventSummary, isHiddenEvent, truncate, type EventColor, type EventSummary } from '../event-display';
import { SyncedSpinner } from './SpinnerContext';
import { useTerminalWidth } from './TerminalContext';
import { renderJsonLine, renderThoughtText, renderToolCallLine, renderToolResultLine, stripJsonNewlines } from '../text-formatting';
import { LABEL_WIDTH, INDENT_WIDTH, DEFAULT_TERMINAL_WIDTH } from '../constants';

const RESET = '\x1b[0m';
const OUTER_PADDING = 2;
const FIXED_OVERHEAD = 16;

const eventSummaryCache = new Map<string, EventSummary>();
const MAX_CACHE_SIZE = 5000;

function getCachedEventSummary(event: DisplayEvent): EventSummary {
  const eventId = (event as { id?: string }).id;
  if (!eventId || event.type === 'delta_batch') {
    return getEventSummary(event);
  }
  
  const cached = eventSummaryCache.get(eventId);
  if (cached) return cached;
  
  if (eventSummaryCache.size >= MAX_CACHE_SIZE) {
    const firstKey = eventSummaryCache.keys().next().value;
    if (firstKey) eventSummaryCache.delete(firstKey);
  }
  
  const summary = getEventSummary(event);
  eventSummaryCache.set(eventId, summary);
  return summary;
}

interface EventLineProps {
  event: DisplayEvent;
  isSelected?: boolean;
  pendingCallIds?: Set<string>;
  executingCallIds?: Set<string>;
  depth?: number;
  terminalWidth?: number;
  skipHighlighting?: boolean;
}

function getEventCallId(event: DisplayEvent): string | undefined {
  if (event.type === 'tool_call') {
    return (event as ToolCallEvent).callId;
  }
  return undefined;
}

function arePropsEqual(prev: EventLineProps, next: EventLineProps): boolean {
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.depth !== next.depth) return false;
  if (prev.terminalWidth !== next.terminalWidth) return false;
  if (prev.skipHighlighting !== next.skipHighlighting) return false;
  
  const prevId = (prev.event as { id?: string }).id;
  const nextId = (next.event as { id?: string }).id;
  if (prevId !== nextId) return false;
  
  if (prev.event.type === 'delta_batch') {
    const prevBatch = prev.event as DeltaBatchEvent;
    const nextBatch = next.event as DeltaBatchEvent;
    if (prevBatch.count !== nextBatch.count) return false;
    if (prevBatch.finalText !== nextBatch.finalText) return false;
  }
  
  const callId = getEventCallId(prev.event);
  if (callId) {
    const prevPending = prev.pendingCallIds?.has(callId) ?? false;
    const nextPending = next.pendingCallIds?.has(callId) ?? false;
    if (prevPending !== nextPending) return false;
    
    const prevExecuting = prev.executingCallIds?.has(callId) ?? false;
    const nextExecuting = next.executingCallIds?.has(callId) ?? false;
    if (prevExecuting !== nextExecuting) return false;
  }
  
  return true;
}

function EventLineInner({
  event,
  isSelected = false,
  pendingCallIds,
  executingCallIds,
  depth = 0,
  terminalWidth = DEFAULT_TERMINAL_WIDTH,
  skipHighlighting = false,
}: EventLineProps): React.ReactElement | null {
  if (isHiddenEvent(event)) {
    return null;
  }

  const summary = getCachedEventSummary(event);
  const selectionIndicator = isSelected ? '▸' : ' ';
  const indentWidth = depth * INDENT_WIDTH;
  const availableTextWidth = Math.max(20, terminalWidth - OUTER_PADDING - indentWidth - FIXED_OVERHEAD);

  let displayColor: EventColor = summary.color;
  let isExecuting = false;
  let isPendingYield = false;
  let isStreaming = false;

  if (event.type === 'tool_call') {
    const toolCall = event as ToolCallEvent;
    if (toolCall.yields) {
      if (pendingCallIds?.has(toolCall.callId)) {
        isPendingYield = true;
        displayColor = 'yellowBright';
      } else {
        displayColor = 'cyanBright';
      }
    }
    if (executingCallIds?.has(toolCall.callId)) {
      isExecuting = true;
    }
  } else if (event.type === 'delta_batch') {
    isStreaming = true;
  }

  const showSpinner = isExecuting || isPendingYield || isStreaming;
  const spinnerWidth = showSpinner ? 2 : 0;
  const padding = ' '.repeat(Math.max(0, LABEL_WIDTH - summary.label.length - spinnerWidth));
  
  const isThought = event.type === 'thought' || (event.type === 'delta_batch' && (event as DeltaBatchEvent).deltaType === 'thought_delta');
  const shouldDim = !!(summary.dimmed && !isPendingYield && (!isStreaming || isThought));
  const isAssistant = event.type === 'assistant' || (event.type === 'delta_batch' && (event as DeltaBatchEvent).deltaType === 'assistant_delta');
  const isToolCall = event.type === 'tool_call';
  const isToolResult = event.type === 'tool_result';

  let formattedTextNode: React.ReactNode = null;
  if (summary.text) {
    let textToRender = summary.text;
    
    if (isAssistant) {
      const rawText = event.type === 'delta_batch' 
        ? (event as DeltaBatchEvent).finalText 
        : (event as AssistantEvent).text;
      const isJson = rawText.trimStart().startsWith('{') || rawText.trimStart().startsWith('[');
      if (isJson) {
        const compact = stripJsonNewlines(rawText);
        textToRender = truncate(compact, availableTextWidth);
        formattedTextNode = renderJsonLine(textToRender, displayColor, shouldDim, skipHighlighting);
      }
    }
    
    if (isToolCall && !formattedTextNode) {
      const toolCall = event as ToolCallEvent;
      const argsStr = toolCall.args ? stripJsonNewlines(JSON.stringify(toolCall.args)) : '';
      const fullText = argsStr ? `${toolCall.name} ${argsStr}` : toolCall.name;
      textToRender = truncate(fullText, availableTextWidth);
      formattedTextNode = renderToolCallLine(textToRender, displayColor, shouldDim, skipHighlighting);
    }
    
    if (isToolResult && !formattedTextNode) {
      const toolResult = event as ToolResultEvent;
      if (!toolResult.error && toolResult.result !== undefined) {
        const resultStr = typeof toolResult.result === 'string' 
          ? toolResult.result 
          : stripJsonNewlines(JSON.stringify(toolResult.result));
        const fullText = `${toolResult.name} → ${resultStr}`;
        textToRender = truncate(fullText, availableTextWidth);
        formattedTextNode = renderToolResultLine(textToRender, displayColor, shouldDim, skipHighlighting);
      }
    }
    
    if (isThought && !formattedTextNode) {
      const rawText = event.type === 'delta_batch'
        ? (event as DeltaBatchEvent).finalText
        : (event as ThoughtEvent).text;
      if (rawText) {
        const singleLine = rawText.replace(/\s+/g, ' ').trim();
        textToRender = truncate(singleLine, availableTextWidth);
        formattedTextNode = renderThoughtText(textToRender, shouldDim, skipHighlighting);
      }
    }
    
    if (!formattedTextNode) {
      textToRender = truncate(summary.text, availableTextWidth);
      formattedTextNode = <Text color={summary.textColor} dimColor={shouldDim}>{textToRender || ' '}</Text>;
    }
  }

  const content = (
    <>
      <Text dimColor>├─</Text>
      <Text> </Text><Text color={displayColor} dimColor={shouldDim}>{summary.label}</Text>
      {showSpinner && (
        <>
          <Text> </Text>
          <SyncedSpinner color={displayColor} />
        </>
      )}
      {formattedTextNode && <><Text dimColor={shouldDim}>{padding} </Text>{formattedTextNode}</>}
    </>
  );

  return (
    <Box>
      <Text>{RESET}{selectionIndicator}</Text>
      {content}
    </Box>
  );
}

const MemoizedEventLine = memo(EventLineInner, arePropsEqual);

export function EventLine(props: Omit<EventLineProps, 'terminalWidth'>): React.ReactElement | null {
  const terminalWidth = useTerminalWidth();
  
  return <MemoizedEventLine {...props} terminalWidth={terminalWidth} skipHighlighting={props.skipHighlighting} />;
}
