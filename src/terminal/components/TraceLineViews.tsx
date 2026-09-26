// @ts-ignore
import { Box, Text } from 'ink'
import React from 'react'

import type { ContextBlock, DisplayEvent, InvocationBlock } from '../blocks'
import type { FlattenedLine } from './TraceView'

import { formatCost } from '../../providers/pricing'
import { LABEL_WIDTH, INDENT_WIDTH, MIN_TEXT_WIDTH, MAX_VISUAL_LINES_PER_EVENT } from '../constants'
import { truncate, getEventConfig } from '../event-display'
import {
  renderJsonLine,
  renderThoughtText,
  renderToolCallLine,
  stripJsonNewlines,
  formatThoughtTextMultiLine,
} from '../text-formatting'
import { EventLine } from './EventLine'
import { SyncedSpinner } from './SpinnerContext'
import {
  RESET,
  countBlockEvents,
  findWrapPoint,
  formatDuration,
  getIndent,
  isBlockActive,
} from './trace-helpers'

interface TraceBlockStartLineProps {
  block: InvocationBlock
  indent: string
  isSelected: boolean
  contentMode: boolean
  showIds: boolean
}

function TraceBlockStartLine({
  block,
  indent,
  isSelected,
  contentMode,
  showIds,
}: TraceBlockStartLineProps): React.ReactElement {
  const handoffType = block.handoffOrigin?.type
  const isSpawn = handoffType === 'spawn'
  const isDispatch = handoffType === 'dispatch'
  const isTransfer = handoffType === 'transfer'
  const isRunning = block.state === 'running'
  const isYielded = block.state === 'yielded'
  const hasError = block.hasError
  const loopLabel =
    block.loopIteration !== undefined && block.loopMax !== undefined
      ? ` ${block.loopIteration}/${block.loopMax}`
      : null

  const kindIndicator =
    {
      agent: (
        <Text color="gray" dimColor>
          {' '}
          ◆ agent
        </Text>
      ),
      step: (
        <Text color="gray" dimColor>
          {' '}
          ▸ step
        </Text>
      ),
      sequence: (
        <Text color="gray" dimColor>
          {' '}
          → sequence
        </Text>
      ),
      parallel: (
        <Text color="gray" dimColor>
          {' '}
          ║ parallel
        </Text>
      ),
      loop: (
        <Text color="gray" dimColor>
          {' '}
          ○ loop
        </Text>
      ),
    }[block.kind] ?? null

  let edgeIndicator: React.ReactNode = null
  if (isSpawn) {
    edgeIndicator = (
      <Text color="gray" dimColor>
        :spawn
      </Text>
    )
  } else if (isDispatch) {
    edgeIndicator = (
      <Text color="gray" dimColor>
        :dispatch
      </Text>
    )
  } else if (isTransfer) {
    edgeIndicator = (
      <Text color="gray" dimColor>
        :transfer
      </Text>
    )
  }

  const startChar = isSpawn || isDispatch ? '╠═' : '┌─'
  const startColor = hasError ? 'redBright' : isRunning || isYielded ? 'yellowBright' : 'cyanBright'

  const blockActive = isBlockActive(block)
  const eventCount = blockActive ? countBlockEvents(block) : 0

  const showBlockMeta = !contentMode
  return (
    <Box>
      <Text>
        {RESET}
        {indent}
        {isSelected ? '▸' : ' '}
      </Text>
      <Text color={startColor}>{startChar}</Text>
      <Text> </Text>
      <Text bold={!contentMode} dimColor={contentMode}>
        {block.agentName}
      </Text>
      {showIds && (
        <Text color="gray" dimColor>
          {' '}
          ({block.invocationId})
        </Text>
      )}
      {showBlockMeta && kindIndicator}
      {showBlockMeta && edgeIndicator}
      {showBlockMeta && loopLabel && (
        <Text color="gray" dimColor>
          {loopLabel}
        </Text>
      )}
      {showBlockMeta && blockActive && eventCount > 0 && (
        <Text color="gray" dimColor>
          {' '}
          [{eventCount}]
        </Text>
      )}
      {(isRunning || isYielded) && !hasError && (
        <Text>
          {' '}
          <SyncedSpinner />
        </Text>
      )}
    </Box>
  )
}

interface TraceCleanEventLineProps {
  line: FlattenedLine
  event: DisplayEvent
  indent: string
  isSelected: boolean
  skipTopLines: number
  terminalWidth: number
  yieldedToolIds?: Set<string>
}

function TraceCleanEventLine({
  line,
  event,
  indent,
  isSelected,
  skipTopLines,
  terminalWidth,
  yieldedToolIds,
}: TraceCleanEventLineProps): React.ReactElement | null {
  const eventType = event.type
  let rawText: string
  let displayLabel: string
  let displayColor: string
  let isPendingYield = false

  if (event.type === 'delta_batch') {
    rawText = event.finalText
    const isThoughtDelta = event.deltaType === 'thought_delta'
    displayLabel = isThoughtDelta ? 'think' : 'output'
    displayColor = isThoughtDelta ? 'gray' : 'greenBright'
  } else if (event.type === 'tool_call') {
    const argsStr = event.args ? JSON.stringify(event.args) : ''
    rawText = argsStr ? `${event.name} ${argsStr}` : event.name
    displayLabel = 'call'
    isPendingYield = !!(event.yields && yieldedToolIds?.has(event.callId))
    displayColor = isPendingYield ? 'yellowBright' : 'cyanBright'
  } else if (event.type === 'tool_input') {
    const inputStr = event.input ? JSON.stringify(event.input) : ''
    rawText = inputStr ? `${event.name} ${inputStr}` : event.name
    displayLabel = 'input'
    displayColor = 'yellowBright'
  } else if ('text' in event) {
    rawText = event.text
    const config = getEventConfig(event)
    displayLabel = config.label
    displayColor = config.color
  } else {
    return null
  }

  const isThoughtType =
    event.type === 'thought' ||
    (event.type === 'delta_batch' && event.deltaType === 'thought_delta')
  if (isThoughtType && (!rawText || rawText.trim() === '')) {
    return null
  }

  const isStreaming = eventType === 'delta_batch'
  const showSpinner = isStreaming || isPendingYield
  const spinnerWidth = showSpinner ? 2 : 0
  const isInsideModelContext = eventType !== 'user'
  const contentModeIndent = isInsideModelContext ? getIndent(Math.max(0, line.depth - 1)) : indent
  const selectionIndicator = isSelected ? '▸' : ' '
  const labelWidth = LABEL_WIDTH
  const labelPadding = ' '.repeat(Math.max(0, labelWidth - displayLabel.length - spinnerWidth))
  const continuationPadding = ' '.repeat(labelWidth + 1)
  const indentWidth = contentModeIndent.length
  const prefixWidth = indentWidth + 1 + 3 + labelWidth + 1
  const maxTextWidth = Math.max(MIN_TEXT_WIDTH, terminalWidth - prefixWidth - 2)

  let text = rawText
  const isJson = rawText.trimStart().startsWith('{') || rawText.trimStart().startsWith('[')

  if (isThoughtType) {
    const singleLineThought = rawText.replace(/\s+/g, ' ').trim()
    if (singleLineThought.length <= maxTextWidth) {
      text = singleLineThought
    } else {
      text = formatThoughtTextMultiLine(rawText)
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

  const wrapLine = (sourceLine: string): string[] => {
    if (sourceLine.length <= maxTextWidth) return [sourceLine]

    const leadingMatch = sourceLine.match(/^(\s*)/)
    const leadingSpaces = leadingMatch ? leadingMatch[1] : ''
    const leadingLen = leadingSpaces.length

    const wrapped: string[] = []
    let remaining = sourceLine

    const firstWrap = findWrapPoint(remaining, maxTextWidth)
    wrapped.push(remaining.slice(0, firstWrap))
    remaining = remaining.slice(firstWrap).trimStart()

    const continuationWidth = Math.max(10, maxTextWidth - leadingLen)
    while (remaining.length > 0) {
      const wrapAt = findWrapPoint(remaining, continuationWidth)
      wrapped.push(leadingSpaces + remaining.slice(0, wrapAt))
      remaining = remaining.slice(wrapAt).trimStart()
    }

    return wrapped
  }

  const sourceLines = text.split('\n')
  const allLines: { text: string; isFirst: boolean; isFirstOfSource: boolean }[] = []
  sourceLines.forEach((sourceLine, srcIdx) => {
    const wrapped = wrapLine(sourceLine)
    wrapped.forEach((wrappedLine, wrapIdx) => {
      allLines.push({
        text: wrappedLine,
        isFirst: srcIdx === 0 && wrapIdx === 0,
        isFirstOfSource: wrapIdx === 0,
      })
    })
  })

  const isAssistantType =
    event.type === 'assistant' ||
    (event.type === 'delta_batch' && event.deltaType === 'assistant_delta')
  const isToolCallType = eventType === 'tool_call'
  const jsonKeyColor = isAssistantType ? 'greenBright' : isToolCallType ? displayColor : null
  const isDimmedLabel = (isThoughtType || isToolCallType) && !isPendingYield && !isStreaming

  const willTruncate = allLines.length > MAX_VISUAL_LINES_PER_EVENT && skipTopLines === 0
  const cappedTotalLines = willTruncate
    ? MAX_VISUAL_LINES_PER_EVENT - 1
    : Math.min(allLines.length, MAX_VISUAL_LINES_PER_EVENT)
  const remainingLines = Math.max(0, cappedTotalLines - skipTopLines)
  const linesToRender = allLines.slice(skipTopLines, skipTopLines + remainingLines)
  const isTopPartial = skipTopLines > 0
  const hiddenLinesCount = allLines.length - cappedTotalLines

  return (
    <Box flexDirection="column">
      {linesToRender.map((lineData, lineIdx) => {
        const isFirstRenderedLine = lineIdx === 0
        const showAsFirst = lineData.isFirst && !isTopPartial
        return (
          <Box key={`${line.key}-${lineIdx}`}>
            <Text>
              {RESET}
              {contentModeIndent}
            </Text>
            <Text>{isFirstRenderedLine && isSelected ? selectionIndicator : ' '}</Text>
            <Text dimColor>{showAsFirst ? '├─ ' : '│  '}</Text>
            {showAsFirst ? (
              <Text dimColor={isDimmedLabel && !isPendingYield}>
                <Text color={displayColor} dimColor={isToolCallType && !isPendingYield}>
                  {displayLabel}
                </Text>
                {showSpinner && (
                  <>
                    <Text> </Text>
                    <SyncedSpinner color={displayColor} />
                  </>
                )}
                {labelPadding}{' '}
              </Text>
            ) : (
              <Text dimColor>{continuationPadding}</Text>
            )}
            {isThoughtType ? (
              renderThoughtText(lineData.text, true)
            ) : isToolCallType ? (
              renderToolCallLine(lineData.text, displayColor, isDimmedLabel)
            ) : jsonKeyColor ? (
              renderJsonLine(lineData.text, jsonKeyColor, isDimmedLabel)
            ) : (
              <Text dimColor={isDimmedLabel}>{lineData.text || ' '}</Text>
            )}
          </Box>
        )
      })}
      {hiddenLinesCount > 0 && skipTopLines === 0 && (
        <Box key={`${line.key}-truncated`}>
          <Text>
            {RESET}
            {contentModeIndent}
          </Text>
          <Text> </Text>
          <Text dimColor>│ </Text>
          <Text dimColor>
            {continuationPadding}... ({hiddenLinesCount} more lines)
          </Text>
        </Box>
      )}
    </Box>
  )
}

interface TraceContextEndLineProps {
  contextBlock: ContextBlock
  indent: string
  isSelected: boolean
  terminalWidth: number
}

function TraceContextEndLine({
  contextBlock,
  indent,
  isSelected,
  terminalWidth,
}: TraceContextEndLineProps): React.ReactElement {
  const response = contextBlock.responseEvent
  const isPending = !response
  const hasError = contextBlock.hasError
  const bracketColor = hasError ? 'redBright' : isPending ? 'yellowBright' : 'magentaBright'
  const durationStr = response ? formatDuration(response.durationMs) : ''
  const costStr = contextBlock.cost !== undefined ? ` • ${formatCost(contextBlock.cost)}` : ''
  const prefixLen = indent.length + 4 + durationStr.length + costStr.length + 3
  const errorMaxLen = Math.max(20, terminalWidth - prefixLen)
  return (
    <Box>
      <Text>
        {RESET}
        {indent}
        {isSelected ? '▸' : ' '}
        <Text color={bracketColor}>└─</Text>
        {!isPending && (
          <Text color="gray" dimColor>
            {' '}
            {durationStr}
            {costStr}
          </Text>
        )}
        {Boolean(response?.error) && (
          <Text color="redBright"> • {truncate(response!.error!, errorMaxLen)}</Text>
        )}
      </Text>
    </Box>
  )
}

interface TraceBlockEndLineProps {
  block: InvocationBlock
  indent: string
  isSelected: boolean
  contentMode: boolean
  showDurations: boolean
  terminalWidth: number
}

function TraceBlockEndLine({
  block,
  indent,
  isSelected,
  contentMode,
  showDurations,
  terminalWidth,
}: TraceBlockEndLineProps): React.ReactElement {
  const isRunning = block.state === 'running'
  const isYielded = block.state === 'yielded'
  const hasError = block.hasError
  const isSpawnOrDispatch =
    block.handoffOrigin?.type === 'spawn' || block.handoffOrigin?.type === 'dispatch'
  const isTransferred = block.state === 'transferred'
  const endChar = isSpawnOrDispatch ? '╚═' : '└─'
  const endColor = hasError ? 'redBright' : isRunning || isYielded ? 'yellowBright' : 'cyanBright'

  const endEvent = block.events.find((e) => e.type === 'invocation_end') as
    | { error?: string }
    | undefined
  const errorMsg = endEvent?.error
  const childHasError =
    block.children.some((c) => c.hasError) || block.contextBlocks.some((c) => c.hasError)
  const showError = Boolean(errorMsg) && !childHasError
  const costStr = block.cost !== undefined ? formatCost(block.cost) : ''

  let statusContent: React.ReactNode
  if (contentMode) {
    statusContent = null
  } else if (isRunning || isYielded) {
    statusContent = costStr ? (
      <Text color="gray" dimColor>
        {costStr}
      </Text>
    ) : null
  } else if (isTransferred && block.handoffTarget) {
    const durationStr =
      showDurations && block.duration !== undefined ? formatDuration(block.duration) : ''
    statusContent = (
      <>
        <Text color="yellowBright" dimColor>
          {block.handoffTarget.agentName}
        </Text>
        {Boolean(durationStr) && (
          <Text color="gray" dimColor>
            {' '}
            • {durationStr}
          </Text>
        )}
        {Boolean(costStr) && (
          <Text color="gray" dimColor>
            {' '}
            • {costStr}
          </Text>
        )}
      </>
    )
  } else if (showDurations && block.duration !== undefined) {
    statusContent = (
      <>
        <Text color="gray" dimColor>
          {formatDuration(block.duration)}
        </Text>
        {Boolean(costStr) && (
          <Text color="gray" dimColor>
            {' '}
            • {costStr}
          </Text>
        )}
      </>
    )
  } else {
    statusContent = (
      <>
        <Text color="gray" dimColor>
          {block.state}
        </Text>
        {Boolean(costStr) && (
          <Text color="gray" dimColor>
            {' '}
            • {costStr}
          </Text>
        )}
      </>
    )
  }

  return (
    <Box>
      <Text>
        {RESET}
        {indent}
      </Text>
      <Text>{isSelected ? '▸' : ' '}</Text>
      <Text color={endColor}>{endChar}</Text>
      <Text> </Text>
      {statusContent}
      {showError && (
        <Text color="redBright">
          {' '}
          • {truncate(errorMsg!, Math.max(20, terminalWidth - indent.length - 20))}
        </Text>
      )}
    </Box>
  )
}

interface TracePartialEventLineProps {
  line: FlattenedLine
  event: DisplayEvent
  isSelected: boolean
  maxVisualLines: number
  isTruncated: boolean
  terminalWidth: number
}

export function TracePartialEventLine({
  line,
  event,
  isSelected,
  maxVisualLines,
  isTruncated,
  terminalWidth,
}: TracePartialEventLineProps): React.ReactElement {
  const config = getEventConfig(event)
  const labelColor = config?.color ?? 'gray'
  const label = config?.label ?? event.type

  let text = ''
  if (event.type === 'delta_batch') {
    text = event.finalText
  } else if (event.type === 'tool_call') {
    const argsStr = event.args ? JSON.stringify(event.args) : ''
    text = argsStr ? `${event.name} ${argsStr}` : event.name
  } else if ('text' in event) {
    text = event.text
  }

  const isThought =
    event.type === 'thought' ||
    (event.type === 'delta_batch' && event.deltaType === 'thought_delta')
  if (isThought) {
    text = text.replace(/\n\n+/g, '\n')
  } else {
    try {
      const parsed = JSON.parse(text.trim())
      text = JSON.stringify(parsed, null, 2)
    } catch {
      // Not JSON
    }
  }

  const isInsideModelContext = event.type !== 'user'
  const depth = isInsideModelContext ? Math.max(0, line.depth - 1) : line.depth
  const depthIndent = getIndent(depth)
  const paddedLabel = label.padEnd(LABEL_WIDTH)
  const prefixWidth = depth * INDENT_WIDTH + 1 + 3 + LABEL_WIDTH + 1
  const maxTextWidth = Math.max(40, terminalWidth - prefixWidth - 2)

  const wrapLine = (sourceLine: string): string[] => {
    if (sourceLine.length <= maxTextWidth) return [sourceLine]
    const leadingMatch = sourceLine.match(/^(\s*)/)
    const leadingSpaces = leadingMatch ? leadingMatch[1] : ''
    const leadingLen = leadingSpaces.length
    const wrapped: string[] = []
    let remaining = sourceLine
    const firstWrap = findWrapPoint(remaining, maxTextWidth)
    wrapped.push(remaining.slice(0, firstWrap))
    remaining = remaining.slice(firstWrap).trimStart()
    const continuationWidth = Math.max(10, maxTextWidth - leadingLen)
    while (remaining.length > 0) {
      const wrapAt = findWrapPoint(remaining, continuationWidth)
      wrapped.push(leadingSpaces + remaining.slice(0, wrapAt))
      remaining = remaining.slice(wrapAt).trimStart()
    }
    return wrapped
  }

  const sourceLines = text.split('\n')
  const allWrappedLines: { text: string; isFirst: boolean; isFirstOfSource: boolean }[] = []
  sourceLines.forEach((sourceLine, srcIdx) => {
    const wrapped = wrapLine(sourceLine)
    wrapped.forEach((wrappedLine, wrapIdx) => {
      allWrappedLines.push({
        text: wrappedLine,
        isFirst: srcIdx === 0 && wrapIdx === 0,
        isFirstOfSource: wrapIdx === 0,
      })
    })
  })

  const linesToRender = allWrappedLines.slice(0, maxVisualLines)

  return (
    <>
      {linesToRender.map((wrappedLine, wrapIdx) => {
        const treeChar = wrappedLine.isFirstOfSource ? '│' : '│'
        const continueIndent = ' '.repeat(LABEL_WIDTH + 3)

        if (wrappedLine.isFirst) {
          return (
            <Box key={`partial-wrap-${wrapIdx}`}>
              <Text>
                {RESET}
                {depthIndent}
                {isSelected ? '▸' : ' '}
                <Text color="gray" dimColor>
                  {treeChar}
                </Text>
                <Text color="gray" dimColor>
                  ─{' '}
                </Text>
                <Text color={labelColor}>{paddedLabel}</Text>
                {isThought ? (
                  renderThoughtText(wrappedLine.text, true)
                ) : event.type === 'assistant' ? (
                  renderJsonLine(wrappedLine.text, labelColor, false)
                ) : (
                  <Text>{wrappedLine.text || ' '}</Text>
                )}
              </Text>
            </Box>
          )
        } else {
          return (
            <Box key={`partial-wrap-${wrapIdx}`}>
              <Text>
                {RESET}
                {depthIndent}{' '}
                <Text color="gray" dimColor>
                  {treeChar}
                </Text>
                {continueIndent}
                {isThought ? (
                  renderThoughtText(wrappedLine.text, true)
                ) : event.type === 'assistant' ? (
                  renderJsonLine(wrappedLine.text, labelColor, false)
                ) : (
                  <Text>{wrappedLine.text || ' '}</Text>
                )}
              </Text>
            </Box>
          )
        }
      })}
      {isTruncated && (
        <Box key="partial-truncated">
          <Text>
            {depthIndent}{' '}
            <Text color="gray" dimColor>
              │
            </Text>
            {' '.repeat(LABEL_WIDTH + 3)}
            <Text dimColor>...</Text>
          </Text>
        </Box>
      )}
    </>
  )
}

interface TraceLineRowProps {
  line: FlattenedLine
  selectedIndex: number | undefined
  skipTopLines: number
  contentMode: boolean
  showIds: boolean
  showDurations: boolean
  terminalWidth: number
  yieldedToolIds?: Set<string>
  executingCallIds?: Set<string>
}

export function TraceLineRow({
  line,
  selectedIndex,
  skipTopLines,
  contentMode,
  showIds,
  showDurations,
  terminalWidth,
  yieldedToolIds,
  executingCallIds,
}: TraceLineRowProps): React.ReactElement | null {
  const indent = getIndent(line.depth)

  if (line.type === 'block_start' && line.block) {
    return (
      <TraceBlockStartLine
        block={line.block}
        indent={indent}
        isSelected={line.eventIndex === selectedIndex}
        contentMode={contentMode}
        showIds={showIds}
      />
    )
  }

  if (line.type === 'event' && line.event) {
    const isSelected = line.eventIndex === selectedIndex
    const eventType = line.event.type
    const isCleanModeType =
      eventType === 'user' ||
      eventType === 'assistant' ||
      eventType === 'thought' ||
      eventType === 'delta_batch' ||
      eventType === 'tool_call' ||
      eventType === 'tool_input'
    const useCleanModeRendering =
      eventType === 'user' ||
      eventType === 'assistant' ||
      eventType === 'thought' ||
      eventType === 'delta_batch' ||
      eventType === 'tool_call' ||
      eventType === 'tool_input'

    if (contentMode && !isCleanModeType) {
      return null
    }

    if (contentMode && useCleanModeRendering) {
      return (
        <TraceCleanEventLine
          line={line}
          event={line.event}
          indent={indent}
          isSelected={isSelected}
          skipTopLines={skipTopLines}
          terminalWidth={terminalWidth}
          yieldedToolIds={yieldedToolIds}
        />
      )
    }

    const isInsideModelContext = eventType !== 'user'
    const eventIndent =
      contentMode && isInsideModelContext ? getIndent(Math.max(0, line.depth - 1)) : indent
    const eventDepth =
      contentMode && isInsideModelContext ? Math.max(0, line.depth - 1) : line.depth
    const skipHighlight = line.event.type === 'tool_result'
    return (
      <Box>
        <Text>
          {RESET}
          {eventIndent}
        </Text>
        <EventLine
          event={line.event}
          isSelected={isSelected}
          yieldedToolIds={yieldedToolIds}
          executingCallIds={executingCallIds}
          depth={eventDepth}
          skipHighlighting={skipHighlight}
        />
      </Box>
    )
  }

  if (line.type === 'context_start' && line.contextBlock) {
    if (contentMode) return null
    const isSelected = line.eventIndex === selectedIndex
    const isPending = !line.contextBlock.responseEvent
    const hasError = line.contextBlock.hasError
    const bracketColor = hasError ? 'redBright' : isPending ? 'yellowBright' : 'magentaBright'
    return (
      <Box>
        <Text>
          {RESET}
          {indent}
          {isSelected ? '▸' : ' '}
          <Text color={bracketColor}>┌─</Text> <Text color="magentaBright">model</Text>
          {isPending && !hasError && (
            <>
              <Text> </Text>
              <SyncedSpinner color="magentaBright" />
            </>
          )}
        </Text>
      </Box>
    )
  }

  if (line.type === 'context_child' && line.event) {
    if (contentMode) return null
    const isSelected = line.eventIndex === selectedIndex
    const skipHighlight = line.event.type === 'tool_result'
    return (
      <Box>
        <Text>
          {RESET}
          {indent}
        </Text>
        <EventLine
          event={line.event}
          isSelected={isSelected}
          yieldedToolIds={yieldedToolIds}
          executingCallIds={executingCallIds}
          depth={line.depth}
          skipHighlighting={skipHighlight}
        />
      </Box>
    )
  }

  if (line.type === 'context_separator') {
    if (contentMode) return null
    return (
      <Box>
        <Text>
          {RESET}
          {indent} <Text color="magentaBright">├─</Text>
        </Text>
      </Box>
    )
  }

  if (line.type === 'context_end' && line.contextBlock) {
    if (contentMode) return null
    return (
      <TraceContextEndLine
        contextBlock={line.contextBlock}
        indent={indent}
        isSelected={line.eventIndex === selectedIndex}
        terminalWidth={terminalWidth}
      />
    )
  }

  if (line.type === 'block_end' && line.block) {
    return (
      <TraceBlockEndLine
        block={line.block}
        indent={indent}
        isSelected={line.eventIndex === selectedIndex}
        contentMode={contentMode}
        showDurations={showDurations}
        terminalWidth={terminalWidth}
      />
    )
  }

  return null
}
