import type { z } from 'zod'

// @ts-ignore
import { Box, Text } from 'ink'
// @ts-ignore
import TextInput from 'ink-text-input'
import React, { useMemo, useEffect, useState, useCallback } from 'react'

import type { DisplayEvent, StreamingMetadata, DeltaBatchEvent } from '../blocks'

import { getEventSummary, getEventDetail, type DetailViewMode } from '../event-display'
import { inspectSchema, JsonSchemaForm, estimateFormHeight } from '../schema-input'
import { renderJsonLine, renderThoughtText, renderToolCallLine } from '../text-formatting'
import { useTerminalWidth } from './TerminalContext'

function getEventId(event: DisplayEvent | null): string | undefined {
  return event ? (event as { id?: string }).id : undefined
}

interface DetailPaneProps {
  event: DisplayEvent | null
  visible: boolean
  mode?: DetailViewMode
  scrollOffset?: number
  onMaxOffsetChange?: (maxOffset: number) => void
  isPendingYield?: boolean
  onInputSubmit?: (value: string) => void
  height?: number
  streaming?: StreamingMetadata
  yieldSchema?: z.ZodTypeAny
}

function wrapText(text: string, width: number, preserveIndent: boolean = false): string[] {
  const result: string[] = []

  for (const line of text.split('\n')) {
    if (line.length <= width) {
      result.push(line)
    } else if (preserveIndent) {
      result.push(line.slice(0, width))
    } else {
      let remaining = line
      while (remaining.length > 0) {
        if (remaining.length <= width) {
          result.push(remaining)
          break
        }
        const breakPoint = remaining.lastIndexOf(' ', width)
        const splitAt = breakPoint > 0 ? breakPoint : width
        result.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt).trimStart()
      }
    }
  }

  return result
}

type CleanRenderMode = 'plain' | 'json' | 'thought' | 'tool_call' | 'tool_result'

function getCleanRenderMode(event: DisplayEvent): CleanRenderMode {
  switch (event.type) {
    case 'assistant':
      return 'json'
    case 'thought':
      return 'thought'
    case 'tool_call':
      return 'tool_call'
    case 'tool_result':
      return 'tool_result'
    case 'delta_batch': {
      const e = event as DeltaBatchEvent
      return e.deltaType === 'thought_delta' ? 'thought' : 'json'
    }
    default:
      return 'plain'
  }
}

function getEventKeyColor(event: DisplayEvent): string {
  switch (event.type) {
    case 'assistant':
      return 'greenBright'
    case 'tool_call':
    case 'tool_result':
      return 'cyanBright'
    case 'delta_batch': {
      const e = event as DeltaBatchEvent
      return e.deltaType === 'thought_delta' ? 'gray' : 'greenBright'
    }
    default:
      return 'gray'
  }
}

function isJsonLine(line: string): boolean {
  const trimmed = line.trimStart()
  return (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('"') ||
    trimmed.startsWith('}') ||
    trimmed.startsWith(']') ||
    /^\s*"[\w_-]+":\s*/.test(line)
  )
}

function renderDetailLine(
  line: string,
  renderMode: CleanRenderMode,
  keyColor: string,
): React.ReactNode {
  const safeText = line || ' '
  switch (renderMode) {
    case 'json': {
      if (line && isJsonLine(line)) {
        return renderJsonLine(line, keyColor, false)
      }
      return <Text>{safeText}</Text>
    }
    case 'thought':
      return renderThoughtText(line, true)
    case 'tool_call':
      return renderToolCallLine(line, keyColor, false)
    case 'tool_result': {
      if (line && isJsonLine(line)) {
        return renderJsonLine(line, keyColor, false)
      }
      return <Text>{safeText}</Text>
    }
    case 'plain':
    default:
      return <Text>{safeText}</Text>
  }
}

export function DetailPane({
  event,
  visible,
  mode = 'clean',
  scrollOffset = 0,
  onMaxOffsetChange,
  isPendingYield = false,
  onInputSubmit,
  height = 20,
  streaming,
  yieldSchema,
}: DetailPaneProps): React.ReactElement | null {
  const terminalWidth = useTerminalWidth()
  const contentWidth = terminalWidth
  const [inputValue, setInputValue] = useState('')

  const schemaDescriptor = useMemo(
    () => (yieldSchema ? inspectSchema(yieldSchema) : null),
    [yieldSchema],
  )
  const useSchemaForm = schemaDescriptor?.isSimple ?? false

  const isInputMode = mode === 'input' && isPendingYield
  const maxContentLines = Math.max(1, height - 1)
  const contentMode = isInputMode ? 'clean' : mode
  const content = event ? getEventDetail(event, contentMode, streaming) : ''
  const wrappedLines = useMemo(
    () => (event ? wrapText(content, contentWidth, contentMode === 'raw') : []),
    [content, contentWidth, event, contentMode],
  )

  const totalLines = wrappedLines.length
  const maxOffset = Math.max(0, totalLines - maxContentLines)
  const effectiveOffset = Math.min(scrollOffset, maxOffset)
  const hasMoreBelow = effectiveOffset < maxOffset

  const visibleLines = useMemo(() => {
    if (!event) return Array(maxContentLines).fill('')
    const start = effectiveOffset
    const end = start + maxContentLines
    const sliced = wrappedLines.slice(start, end)
    if (hasMoreBelow && sliced.length > 0) {
      const lastIdx = sliced.length - 1
      sliced[lastIdx] = sliced[lastIdx].trimEnd().slice(0, -3) + '...'
    }
    if (sliced.length < maxContentLines) {
      return [...sliced, ...Array(maxContentLines - sliced.length).fill('')]
    }
    return sliced
  }, [wrappedLines, effectiveOffset, hasMoreBelow, event, maxContentLines])

  useEffect(() => {
    onMaxOffsetChange?.(maxOffset)
  }, [maxOffset, onMaxOffsetChange])

  const eventId = getEventId(event)
  useEffect(() => {
    setInputValue('')
  }, [eventId])

  const handleInputSubmit = useCallback(
    (value: string) => {
      onInputSubmit?.(value)
      setInputValue('')
    },
    [onInputSubmit],
  )

  const handleSchemaSubmit = useCallback(
    (value: Record<string, unknown>) => {
      onInputSubmit?.(JSON.stringify(value))
    },
    [onInputSubmit],
  )

  const handleSchemaCancel = useCallback(() => {}, [])

  const cleanRenderMode = useMemo(() => (event ? getCleanRenderMode(event) : 'plain'), [event])
  const keyColor = useMemo(() => (event ? getEventKeyColor(event) : 'gray'), [event])
  const useHighlighting = contentMode === 'clean' && cleanRenderMode !== 'plain'

  if (!visible || !event) return null

  const summary = getEventSummary(event)
  const hasMore = totalLines > maxContentLines
  const scrollPercent = maxOffset > 0 ? Math.round((effectiveOffset / maxOffset) * 100) : 0
  const inputLinesReserved = isInputMode
    ? useSchemaForm && schemaDescriptor
      ? estimateFormHeight(schemaDescriptor)
      : 3
    : 0
  const displayLines = isInputMode
    ? wrappedLines.slice(0, maxContentLines - inputLinesReserved)
    : visibleLines.slice(0, maxContentLines - inputLinesReserved)

  return (
    <Box flexDirection="column" height={height}>
      <Box>
        <Text bold color="gray">
          Event
        </Text>
        <Text dimColor> • </Text>
        <Text color={summary.color}>{summary.label}</Text>
        <Text dimColor> • </Text>
        <Text color={mode === 'clean' ? 'cyanBright' : 'gray'} dimColor={mode !== 'clean'}>
          {mode === 'clean' ? '●' : '○'} clean [c]
        </Text>
        <Text dimColor> </Text>
        <Text color={mode === 'raw' ? 'cyanBright' : 'gray'} dimColor={mode !== 'raw'}>
          {mode === 'raw' ? '●' : '○'} raw [r]
        </Text>
        {isPendingYield && (
          <>
            <Text dimColor> </Text>
            <Text color={isInputMode ? 'yellowBright' : 'gray'} dimColor={!isInputMode}>
              {isInputMode ? '●' : '○'} input [i]
            </Text>
          </>
        )}
        {hasMore && !isInputMode && (
          <>
            <Text dimColor> • </Text>
            <Text dimColor>{effectiveOffset > 0 ? `${scrollPercent}%` : 'scroll [↑↓]'}</Text>
          </>
        )}
      </Box>
      {displayLines.map((line, idx) => (
        <Box key={idx}>
          {useHighlighting ? (
            renderDetailLine(line.trimEnd() || '', cleanRenderMode, keyColor)
          ) : (
            <Text>{line.trimEnd() || ' '}</Text>
          )}
        </Box>
      ))}
      {isInputMode && (
        <Box flexDirection="column" marginTop={1}>
          {useSchemaForm && schemaDescriptor ? (
            <JsonSchemaForm
              fields={schemaDescriptor.fields}
              onSubmit={handleSchemaSubmit}
              onCancel={handleSchemaCancel}
            />
          ) : (
            <>
              <Text>Enter result (JSON or string):</Text>
              <Box>
                <Text color="greenBright">→ </Text>
                <TextInput
                  value={inputValue}
                  onChange={setInputValue}
                  onSubmit={handleInputSubmit}
                  placeholder="Enter response..."
                />
              </Box>
            </>
          )}
        </Box>
      )}
    </Box>
  )
}
