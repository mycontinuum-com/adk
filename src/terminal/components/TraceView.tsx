// @ts-ignore
import { Box, Text } from 'ink'
import React, { useMemo } from 'react'

import type { ToolCallEvent } from '../../types'
import type { InvocationBlock, DisplayEvent, ContextBlock } from '../blocks'

import {
  LABEL_WIDTH,
  INDENT_WIDTH,
  MIN_TEXT_WIDTH,
  MIN_CONTINUATION_WIDTH,
  MAX_VISUAL_LINES_PER_EVENT,
  CLEAN_MODE_EVENT_TYPES,
} from '../constants'
import { isHiddenEvent } from '../event-display'
import { stripJsonNewlines } from '../text-formatting'
import { useTerminalWidth } from './TerminalContext'
import { findWrapPoint } from './trace-helpers'
import { computeTraceViewport } from './trace-viewport'
import { TraceLineRow, TracePartialEventLine } from './TraceLineViews'

const EMPTY_SELECTABLE_EVENTS: DisplayEvent[] = []
const EMPTY_EXPANDED_CONTEXT_IDS = new Set<string>()

function formatThoughtTextForCalc(text: string): string {
  return text.replace(/\n\n+/g, '\n').replace(/([^\n])\*\*([A-Z])/g, '$1\n**$2')
}

function wrapTextLines(text: string, maxWidth: number): string[] {
  const wrapLine = (sourceLine: string): string[] => {
    if (sourceLine.length <= maxWidth) return [sourceLine]

    const leadingMatch = sourceLine.match(/^(\s*)/)
    const leadingSpaces = leadingMatch ? leadingMatch[1] : ''
    const leadingLen = leadingSpaces.length

    const wrapped: string[] = []
    let remaining = sourceLine

    const firstWrap = findWrapPoint(remaining, maxWidth)
    wrapped.push(remaining.slice(0, firstWrap))
    remaining = remaining.slice(firstWrap).trimStart()

    const continuationWidth = Math.max(MIN_CONTINUATION_WIDTH, maxWidth - leadingLen)
    while (remaining.length > 0) {
      const wrapAt = findWrapPoint(remaining, continuationWidth)
      wrapped.push(leadingSpaces + remaining.slice(0, wrapAt))
      remaining = remaining.slice(wrapAt).trimStart()
    }

    return wrapped
  }

  const sourceLines = text.split('\n')
  const allWrapped: string[] = []
  for (const sourceLine of sourceLines) {
    allWrapped.push(...wrapLine(sourceLine))
  }
  return allWrapped
}

/** The text a clean-mode event line shows before wrapping. */
function cleanModeRawText(event: DisplayEvent): string {
  const eventType = event.type
  if (eventType === 'delta_batch') {
    return (event as { finalText: string }).finalText
  }
  if (eventType === 'tool_call') {
    const toolCall = event as { name: string; args?: Record<string, unknown> }
    const argsStr = toolCall.args ? JSON.stringify(toolCall.args) : ''
    return argsStr ? `${toolCall.name} ${argsStr}` : toolCall.name
  }
  if (eventType === 'tool_input') {
    const toolInput = event as { name: string; input: unknown }
    const inputStr = toolInput.input ? JSON.stringify(toolInput.input) : ''
    return inputStr ? `${toolInput.name} ${inputStr}` : toolInput.name
  }
  return (event as { text: string }).text
}

/** Collapses short text to one line and expands long JSON, matching how the line renders. */
function cleanModeDisplayText(rawText: string, isThoughtType: boolean, maxTextWidth: number) {
  let text = rawText
  const isJson = rawText.trimStart().startsWith('{') || rawText.trimStart().startsWith('[')

  if (isThoughtType) {
    const singleLineThought = rawText.replace(/\s+/g, ' ').trim()
    if (singleLineThought.length <= maxTextWidth) {
      text = singleLineThought
    } else {
      text = formatThoughtTextForCalc(rawText)
    }
  } else if (isJson) {
    const compactJson = stripJsonNewlines(rawText)
    if (compactJson.length <= maxTextWidth) {
      text = compactJson
    } else {
      try {
        const parsed = JSON.parse(rawText.trim())
        text = JSON.stringify(parsed, null, 2)
      } catch {
        text = rawText
      }
    }
  } else {
    const singleLine = rawText.replace(/\s+/g, ' ').trim()
    if (singleLine.length <= maxTextWidth) {
      text = singleLine
    }
  }
  return text
}

function calculateCleanModeVisualLines(line: FlattenedLine, terminalWidth: number): number {
  if (line.type === 'block_start' || line.type === 'block_end') {
    return 1
  }
  if (line.type !== 'event' || !line.event) {
    return 1
  }

  const eventType = line.event.type
  const isCleanModeType =
    eventType === 'user' ||
    eventType === 'assistant' ||
    eventType === 'thought' ||
    eventType === 'delta_batch' ||
    eventType === 'tool_call' ||
    eventType === 'tool_input'

  if (!isCleanModeType) {
    return 0
  }

  const rawText = cleanModeRawText(line.event)

  const isThoughtType =
    eventType === 'thought' ||
    (eventType === 'delta_batch' &&
      (line.event as { deltaType?: string }).deltaType === 'thought_delta')
  if (isThoughtType && (!rawText || rawText.trim() === '')) {
    return 0
  }

  const isInsideModelContext = eventType !== 'user'
  const depth = isInsideModelContext ? Math.max(0, line.depth - 1) : line.depth
  const indentWidth = depth * INDENT_WIDTH
  const labelWidth = LABEL_WIDTH
  const prefixWidth = indentWidth + 1 + 3 + labelWidth + 1
  const maxTextWidth = Math.max(MIN_TEXT_WIDTH, terminalWidth - prefixWidth - 2)

  const text = cleanModeDisplayText(rawText, isThoughtType, maxTextWidth)

  const lineCount = wrapTextLines(text, maxTextWidth).length
  return Math.min(lineCount, MAX_VISUAL_LINES_PER_EVENT)
}

function isLineVisibleInCleanMode(line: FlattenedLine): boolean {
  if (line.type === 'block_start' || line.type === 'block_end') {
    return true
  }
  if (line.type === 'event' && line.event) {
    if (!CLEAN_MODE_EVENT_TYPES.has(line.event.type)) {
      return false
    }
    if (line.event.type === 'thought') {
      const text = (line.event as { text?: string }).text
      if (!text || text.trim() === '') {
        return false
      }
    }
    if (line.event.type === 'delta_batch') {
      const deltaEvent = line.event as { deltaType?: string; finalText?: string }
      if (deltaEvent.deltaType === 'thought_delta') {
        if (!deltaEvent.finalText || deltaEvent.finalText.trim() === '') {
          return false
        }
      }
    }
    return true
  }
  return false
}

interface TraceViewProps {
  blocks: InvocationBlock[]
  showDurations?: boolean
  showIds?: boolean
  selectedIndex?: number
  selectableEvents?: DisplayEvent[]
  expandedContextIds?: Set<string>
  maxHeight?: number
  scrollOffset?: number
  yieldedToolIds?: Set<string>
  executingCallIds?: Set<string>
  contentMode?: boolean
  precomputedLines?: FlattenedLine[]
  precomputedVisualHeights?: number[]
  precomputedVisualStarts?: number[]
}

type LineType =
  | 'block_start'
  | 'event'
  | 'child_start'
  | 'block_end'
  | 'context_start'
  | 'context_end'
  | 'context_child'
  | 'context_separator'

interface FlattenedLine {
  key: string
  type: LineType
  block?: InvocationBlock
  event?: DisplayEvent
  contextBlock?: ContextBlock
  depth: number
  eventIndex?: number
}

function flattenBlocks(
  blocks: InvocationBlock[],
  selectableEvents: DisplayEvent[],
  expandedContextIds: Set<string> = new Set(),
  depth: number = 0,
): FlattenedLine[] {
  const lines: FlattenedLine[] = []
  const selectableIds = new Set(selectableEvents.map((e) => (e as { id?: string }).id))

  function getSelectableIndex(eventId: string | undefined): number | undefined {
    if (!eventId || !selectableIds.has(eventId)) return undefined
    return selectableEvents.findIndex((e) => (e as { id?: string }).id === eventId)
  }

  function addEvent(event: DisplayEvent, d: number): void {
    if (isHiddenEvent(event)) return
    const eventId = (event as { id?: string }).id
    lines.push({
      key: `event-${eventId ?? lines.length}`,
      type: 'event',
      event,
      depth: d,
      eventIndex: getSelectableIndex(eventId),
    })
  }

  function addExpandedContextItems(contextBlock: ContextBlock, ctxId: string, d: number): void {
    for (const toolItem of contextBlock.toolItems) {
      lines.push({
        key: `ctx-child-${toolItem.id}`,
        type: 'context_child',
        event: toolItem,
        depth: d + 1,
        eventIndex: getSelectableIndex(toolItem.id),
      })
    }

    if (contextBlock.schemaItem) {
      lines.push({
        key: `ctx-child-${contextBlock.schemaItem.id}`,
        type: 'context_child',
        event: contextBlock.schemaItem,
        depth: d + 1,
        eventIndex: getSelectableIndex(contextBlock.schemaItem.id),
      })
    }

    for (const msgItem of contextBlock.messageItems) {
      lines.push({
        key: `ctx-child-${msgItem.id}`,
        type: 'context_child',
        event: msgItem,
        depth: d + 1,
        eventIndex: getSelectableIndex(msgItem.id),
      })
    }

    if (contextBlock.producedEvents.length > 0) {
      lines.push({ key: `ctx-sep-${ctxId}`, type: 'context_separator', depth: d })
    }
  }

  function addProducedEvents(contextBlock: ContextBlock, d: number): void {
    const hasAssistantEvent = contextBlock.producedEvents.some((e) => e.type === 'assistant')
    const hasThoughtEvent = contextBlock.producedEvents.some((e) => e.type === 'thought')
    for (const event of contextBlock.producedEvents) {
      if (isHiddenEvent(event)) continue
      if (event.type === 'delta_batch') {
        const batch = event as { deltaType: string }
        if (batch.deltaType === 'assistant_delta' && hasAssistantEvent) continue
        if (batch.deltaType === 'thought_delta' && hasThoughtEvent) continue
      }
      const eventId = (event as { id?: string }).id
      lines.push({
        key: `event-${eventId ?? lines.length}`,
        type: 'event',
        event,
        depth: d + 1,
        eventIndex: getSelectableIndex(eventId),
      })
    }
  }

  function addContextBlocks(contextBlocks: ContextBlock[], d: number): void {
    for (const contextBlock of contextBlocks) {
      const ctx = contextBlock.contextEvent
      const ctxId = ctx?.id ?? `ctx-${lines.length}`
      const isExpanded = ctx ? expandedContextIds.has(ctx.id) : false
      lines.push({
        key: `ctx-start-${ctxId}`,
        type: 'context_start',
        contextBlock,
        depth: d,
        eventIndex: ctx ? getSelectableIndex(ctx.id) : undefined,
        event: ctx,
      })

      if (isExpanded && ctx) {
        addExpandedContextItems(contextBlock, ctxId, d)
      }

      addProducedEvents(contextBlock, d)

      const responseId = contextBlock.responseEvent?.id
      const pendingCtxEndId = contextBlock.contextEvent
        ? `pending-ctx-end-${contextBlock.contextEvent.id}`
        : undefined
      lines.push({
        key: `ctx-end-${ctxId}`,
        type: 'context_end',
        contextBlock,
        depth: d,
        eventIndex: responseId
          ? getSelectableIndex(responseId)
          : getSelectableIndex(pendingCtxEndId),
      })

      for (const event of contextBlock.postEvents) {
        if (isHiddenEvent(event)) continue
        const eventId = (event as { id?: string }).id
        lines.push({
          key: `event-${eventId ?? lines.length}`,
          type: 'event',
          event,
          depth: d,
          eventIndex: getSelectableIndex(eventId),
        })
      }
    }
  }

  function addBlock(block: InvocationBlock, d: number): void {
    const startEvent = block.events.find((e) => e.type === 'invocation_start')
    const endEvent = block.events.find((e) => e.type === 'invocation_end')

    lines.push({
      key: `block-start-${block.invocationId}`,
      type: 'block_start',
      block,
      depth: d,
      eventIndex: startEvent ? getSelectableIndex((startEvent as { id?: string }).id) : undefined,
    })

    if (block.kind === 'loop' && block.childMap) {
      for (const event of block.events) {
        if (event.type === 'invocation_start') {
          const childBlock = block.childMap.get((event as { invocationId: string }).invocationId)
          if (childBlock) {
            addBlock(childBlock, d + 1)
          }
        } else if (event.type !== 'invocation_end') {
          addEvent(event, d + 1)
        }
      }
    } else {
      for (const event of block.preContextEvents) {
        addEvent(event, d + 1)
      }

      const remainingChildren = new Set(block.children)

      for (const contextBlock of block.contextBlocks) {
        addContextBlocks([contextBlock], d + 1)

        const toolCallIds = new Set(
          contextBlock.producedEvents
            .filter((e): e is ToolCallEvent => e.type === 'tool_call')
            .map((e) => e.callId),
        )

        for (const child of remainingChildren) {
          const origin = child.handoffOrigin
          const callId = origin && origin.type !== 'transfer' ? origin.callId : undefined
          if (callId && toolCallIds.has(callId)) {
            addBlock(child, d + 1)
            remainingChildren.delete(child)
          }
        }
      }

      for (const child of remainingChildren) {
        addBlock(child, d + 1)
      }

      for (const event of block.postChildEvents) {
        addEvent(event, d + 1)
      }
    }

    const pendingBlockEndId = `pending-block-end-${block.invocationId}`
    lines.push({
      key: `block-end-${block.invocationId}`,
      type: 'block_end',
      block,
      depth: d,
      eventIndex: endEvent
        ? getSelectableIndex((endEvent as { id?: string }).id)
        : getSelectableIndex(pendingBlockEndId),
    })
  }

  for (const block of blocks) {
    addBlock(block, depth)
  }

  return lines
}

export function TraceView({
  blocks,
  showDurations = true,
  showIds = false,
  selectedIndex,
  selectableEvents = EMPTY_SELECTABLE_EVENTS,
  expandedContextIds = EMPTY_EXPANDED_CONTEXT_IDS,
  maxHeight,
  scrollOffset = 0,
  yieldedToolIds,
  executingCallIds,
  contentMode = false,
  precomputedLines,
  precomputedVisualHeights,
  precomputedVisualStarts,
}: TraceViewProps): React.ReactElement {
  const terminalWidth = useTerminalWidth()

  const lines = useMemo(() => {
    if (precomputedLines) return precomputedLines
    const allLines = flattenBlocks(blocks, selectableEvents, expandedContextIds)
    if (!contentMode) return allLines
    return allLines.filter(isLineVisibleInCleanMode)
  }, [precomputedLines, blocks, selectableEvents, expandedContextIds, contentMode])

  const totalVisualLines = useMemo(() => {
    if (precomputedVisualHeights) {
      return precomputedVisualHeights.reduce((sum, h) => sum + h, 0)
    }
    if (!contentMode) return lines.length
    let total = 0
    for (const line of lines) {
      total += calculateCleanModeVisualLines(line, terminalWidth)
    }
    return total
  }, [precomputedVisualHeights, lines, contentMode, terminalWidth])

  const visualLineHeights = useMemo(() => {
    if (precomputedVisualHeights) return precomputedVisualHeights
    if (!contentMode) return null
    return lines.map((line) => calculateCleanModeVisualLines(line, terminalWidth))
  }, [precomputedVisualHeights, lines, contentMode, terminalWidth])

  const visualLineStarts = useMemo(() => {
    if (precomputedVisualStarts) return precomputedVisualStarts
    if (!contentMode) return null
    if (!visualLineHeights) return null
    const starts: number[] = []
    let cumulative = 0
    for (const height of visualLineHeights) {
      starts.push(cumulative)
      cumulative += height
    }
    return starts
  }, [precomputedVisualStarts, visualLineHeights, contentMode])

  const contentHeight = useMemo(() => {
    if (maxHeight === undefined) return undefined
    const atTop = scrollOffset === 0
    const conservativeHeight = maxHeight - (atTop ? 1 : 2)
    const atBottom = scrollOffset + conservativeHeight >= totalVisualLines - 1
    if (atTop && atBottom) {
      return maxHeight
    } else if (atTop) {
      return maxHeight - 1
    } else if (atBottom) {
      return maxHeight - 1
    } else {
      return maxHeight - 2
    }
  }, [maxHeight, scrollOffset, totalVisualLines])

  const clampedScrollOffset =
    contentHeight !== undefined
      ? Math.min(scrollOffset, Math.max(0, totalVisualLines - contentHeight))
      : scrollOffset

  const {
    visibleLines,
    linesAbove,
    linesBelow,
    renderedVisualLines,
    partialLine,
    partialLineMaxVisual,
    partialLineIsTruncated,
    topPartialSkipLines,
  } = useMemo(
    () =>
      computeTraceViewport({
        lines,
        contentHeight,
        clampedScrollOffset,
        visualLineStarts,
        visualLineHeights,
        totalVisualLines,
        contentMode,
      }),
    [
      lines,
      contentHeight,
      clampedScrollOffset,
      visualLineStarts,
      visualLineHeights,
      totalVisualLines,
      contentMode,
    ],
  )

  const hasScrollableContent = contentHeight !== undefined && totalVisualLines > contentHeight
  const showMoreAbove = hasScrollableContent && linesAbove > 1
  const showMoreBelow = hasScrollableContent && linesBelow > 1

  return (
    <Box flexDirection="column">
      {showMoreAbove && <Text dimColor> ↑ {linesAbove} more above</Text>}
      {visibleLines.map((line, idx) => (
        <TraceLineRow
          key={line.key}
          line={line}
          selectedIndex={selectedIndex}
          skipTopLines={idx === 0 ? topPartialSkipLines : 0}
          contentMode={contentMode}
          showIds={showIds}
          showDurations={showDurations}
          terminalWidth={terminalWidth}
          yieldedToolIds={yieldedToolIds}
          executingCallIds={executingCallIds}
        />
      ))}
      {partialLine &&
        contentMode &&
        partialLineMaxVisual > 0 &&
        partialLine.type === 'event' &&
        partialLine.event && (
          <TracePartialEventLine
            key={`partial-${partialLine.key}`}
            line={partialLine}
            event={partialLine.event}
            isSelected={partialLine.eventIndex === selectedIndex}
            maxVisualLines={partialLineMaxVisual}
            isTruncated={partialLineIsTruncated}
            terminalWidth={terminalWidth}
          />
        )}
      {(() => {
        if (maxHeight === undefined) return null
        if (!hasScrollableContent) return null
        const topIndicatorLines = showMoreAbove ? 1 : 0
        const bottomIndicatorLines = showMoreBelow ? 1 : 0
        const totalUsed = topIndicatorLines + renderedVisualLines + bottomIndicatorLines
        const paddingNeeded = maxHeight - totalUsed
        if (paddingNeeded <= 0) return null
        return Array.from({ length: paddingNeeded }, (_, i) => (
          <Box key={`padding-${i}`}>
            <Text> </Text>
          </Box>
        ))
      })()}
      {showMoreBelow && <Text dimColor> ↓ {linesBelow} more below</Text>}
    </Box>
  )
}

export { flattenBlocks, calculateCleanModeVisualLines }
export type { FlattenedLine }

export function buildEventIndexToLineMap(lines: FlattenedLine[]): Map<number, number> {
  const map = new Map<number, number>()
  for (let i = 0; i < lines.length; i++) {
    const eventIndex = lines[i].eventIndex
    if (eventIndex !== undefined) {
      map.set(eventIndex, i)
    }
  }
  return map
}

export function getLineIndexForEvent(
  lines: FlattenedLine[],
  eventIndex: number,
  lookupMap?: Map<number, number>,
): number {
  if (lookupMap) {
    return lookupMap.get(eventIndex) ?? 0
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].eventIndex === eventIndex) {
      return i
    }
  }
  return 0
}

/** Event index of the first line after (`step` 1) or before (`step` -1) `from` that matches. */
function scanForEventIndex(
  lines: FlattenedLine[],
  from: number,
  step: 1 | -1,
  matches: (line: FlattenedLine) => boolean,
): number | undefined {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) {
    const line = lines[i]
    if (matches(line) && line.eventIndex !== undefined) {
      return line.eventIndex
    }
  }
  return undefined
}

function isBlockOrContextEnd(line: FlattenedLine): boolean {
  return line.type === 'block_end' || line.type === 'context_end'
}

function isBlockOrContextStart(line: FlattenedLine): boolean {
  return line.type === 'block_start' || line.type === 'context_start'
}

export function findBlockEndEventIndex(
  lines: FlattenedLine[],
  currentLineIndex: number,
): number | undefined {
  if (currentLineIndex < 0 || currentLineIndex >= lines.length) {
    return undefined
  }

  const currentLine = lines[currentLineIndex]
  const currentDepth = currentLine.depth

  if (currentLine.type === 'block_start' && currentLine.block) {
    const invocationId = currentLine.block.invocationId
    return scanForEventIndex(
      lines,
      currentLineIndex,
      1,
      (line) => line.type === 'block_end' && line.block?.invocationId === invocationId,
    )
  }

  if (currentLine.type === 'context_start' && currentLine.contextBlock) {
    const contextId = currentLine.contextBlock.contextEvent?.id
    return scanForEventIndex(
      lines,
      currentLineIndex,
      1,
      (line) => line.type === 'context_end' && line.contextBlock?.contextEvent?.id === contextId,
    )
  }

  // From an end line or any other line: the next end at the same or a shallower depth.
  return scanForEventIndex(
    lines,
    currentLineIndex,
    1,
    (line) => isBlockOrContextEnd(line) && line.depth <= currentDepth,
  )
}

export function findBlockStartEventIndex(
  lines: FlattenedLine[],
  currentLineIndex: number,
): number | undefined {
  if (currentLineIndex < 0 || currentLineIndex >= lines.length) {
    return undefined
  }

  const currentLine = lines[currentLineIndex]
  const currentDepth = currentLine.depth

  if (currentLine.type === 'block_end' && currentLine.block) {
    const invocationId = currentLine.block.invocationId
    return scanForEventIndex(
      lines,
      currentLineIndex,
      -1,
      (line) => line.type === 'block_start' && line.block?.invocationId === invocationId,
    )
  }

  if (currentLine.type === 'context_end' && currentLine.contextBlock) {
    const contextId = currentLine.contextBlock.contextEvent?.id
    return scanForEventIndex(
      lines,
      currentLineIndex,
      -1,
      (line) => line.type === 'context_start' && line.contextBlock?.contextEvent?.id === contextId,
    )
  }

  // From a start line or any other line: the previous start at the same or a shallower depth.
  return scanForEventIndex(
    lines,
    currentLineIndex,
    -1,
    (line) => isBlockOrContextStart(line) && line.depth <= currentDepth,
  )
}
