// @ts-ignore
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import React, { useEffect, useLayoutEffect, useState, useMemo, useRef, useCallback } from 'react'

import type { BaseRunner } from '../core'
import type { BaseSession } from '../session'
import type {
  Runnable,
  ToolCallEvent,
  ToolYieldEvent,
  RunResult,
  ModelStartEvent,
  ContextMessageSummary,
} from '../types'
import type { CLIOptions, DisplayMode } from './types'

import { buildContext, buildContextAsync, eventToMessageSummary } from '../context/build'
import {
  buildInvocationBlocks,
  getEventsInDisplayOrder,
  getPendingBrackets,
  getStreamingMetadata,
  type DisplayEvent,
  type PendingBracket,
  type ContextMessageItem,
  type InvocationBlock,
} from './blocks'
import { TraceView, PromptInput, DetailPane, LogView, LogDetailPane } from './components'
import {
  flattenBlocks,
  getLineIndexForEvent,
  findBlockEndEventIndex,
  findBlockStartEventIndex,
  calculateCleanModeVisualLines,
  buildEventIndexToLineMap,
  type FlattenedLine,
} from './components/TraceView'
import {
  DETAIL_SCROLL_PAGE_SIZE,
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
  CLEAN_MODE_EVENT_TYPES,
} from './constants'
import { getSelectableTypes, type DetailViewMode } from './event-display'
import { useAgent, useLogCapture } from './hooks'
import { extractYieldSchemas } from './schema-input'

interface AppProps {
  runnable: Runnable<any>
  runner: BaseRunner
  session: BaseSession
  initialInput?: string
  options: CLIOptions
  onResult?: (result: RunResult) => void
}

const SELECTABLE_TYPES = getSelectableTypes()
SELECTABLE_TYPES.add('pending_context_end')
SELECTABLE_TYPES.add('pending_block_end')

function getSelectableEvents(events: DisplayEvent[]): DisplayEvent[] {
  return events.filter((e) => SELECTABLE_TYPES.has(e.type))
}

function getEventId(event: DisplayEvent | null): string | undefined {
  if (!event) return undefined
  return (event as { id?: string }).id
}

interface PendingBracketLookupMaps {
  invocationEndByInvocationId: Map<string, number>
  modelStartById: Map<string, { invocationId: string; stepIndex: number; index: number }>
  modelEndByKey: Map<string, number>
}

function buildPendingBracketLookupMaps(selectableEvents: DisplayEvent[]): PendingBracketLookupMaps {
  const invocationEndByInvocationId = new Map<string, number>()
  const modelStartById = new Map<
    string,
    { invocationId: string; stepIndex: number; index: number }
  >()
  const modelEndByKey = new Map<string, number>()

  for (let i = 0; i < selectableEvents.length; i++) {
    const e = selectableEvents[i]
    if (e.type === 'invocation_end') {
      const invocationId = (e as { invocationId?: string }).invocationId
      if (invocationId) invocationEndByInvocationId.set(invocationId, i)
    } else if (e.type === 'model_start') {
      const id = (e as { id?: string }).id
      const invocationId = (e as { invocationId?: string }).invocationId
      const stepIndex = (e as { stepIndex?: number }).stepIndex
      if (id && invocationId !== undefined && stepIndex !== undefined) {
        modelStartById.set(id, { invocationId, stepIndex, index: i })
      }
    } else if (e.type === 'model_end') {
      const invocationId = (e as { invocationId?: string }).invocationId
      const stepIndex = (e as { stepIndex?: number }).stepIndex
      if (invocationId !== undefined && stepIndex !== undefined) {
        modelEndByKey.set(`${invocationId}-${stepIndex}`, i)
      }
    }
  }

  return { invocationEndByInvocationId, modelStartById, modelEndByKey }
}

function findRealEventForPendingBracket(
  pendingBracket: PendingBracket,
  lookupMaps: PendingBracketLookupMaps,
): number {
  if (pendingBracket.type === 'pending_block_end') {
    const idx = lookupMaps.invocationEndByInvocationId.get(pendingBracket.invocationId)
    if (idx !== undefined) return idx
  } else if (pendingBracket.type === 'pending_context_end') {
    const contextInfo = lookupMaps.modelStartById.get(pendingBracket.contextId)
    if (contextInfo) {
      const key = `${contextInfo.invocationId}-${contextInfo.stepIndex}`
      const idx = lookupMaps.modelEndByKey.get(key)
      if (idx !== undefined) return idx
    }
  }
  return -1
}

function findFinalEventForDeltaBatch(
  deltaType: 'thought_delta' | 'assistant_delta',
  selectableEvents: DisplayEvent[],
  fromIndex: number,
): number {
  const targetType = deltaType === 'thought_delta' ? 'thought' : 'assistant'
  for (let i = fromIndex; i < selectableEvents.length; i++) {
    if (selectableEvents[i].type === targetType) {
      return i
    }
  }
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (selectableEvents[i].type === targetType) {
      return i
    }
  }
  return -1
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

const LAYOUT = {
  outerPadding: 0,
  traceMarginBottom: 0,
  promptInputMarginTop: 1,
  promptInputLines: 1,
  topBarLines: 1,
  helpLines: 1,
  detailPaneMinHeight: 8,
  detailPaneMaxHeight: 20,
  scrollIndicatorLines: 2,
} as const

const FIXED_UI_LINES = LAYOUT.topBarLines + LAYOUT.traceMarginBottom + LAYOUT.helpLines

const PROMPT_INPUT_HEIGHT = LAYOUT.promptInputMarginTop + LAYOUT.promptInputLines

export function App({
  runnable,
  runner,
  session,
  initialInput,
  options,
  onResult,
}: AppProps): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminalHeightRef = useRef(stdout?.rows ?? DEFAULT_TERMINAL_HEIGHT)
  const terminalWidthRef = useRef(stdout?.columns ?? DEFAULT_TERMINAL_WIDTH)
  if (stdout?.rows && stdout.rows !== terminalHeightRef.current) {
    terminalHeightRef.current = stdout.rows
  }
  if (stdout?.columns && stdout.columns !== terminalWidthRef.current) {
    terminalWidthRef.current = stdout.columns
  }
  const terminalHeight = terminalHeightRef.current
  const terminalWidth = terminalWidthRef.current

  const {
    status,
    events,
    yieldedTools,
    executingCallIds,
    inputRequired,
    run,
    resume,
    resumeWithInput,
    result,
  } = useAgent(runnable, { runner, session, options })

  const [selectedIndex, setSelectedIndex] = useState<number>(0)
  const [detailVisible, setDetailVisible] = useState(false)
  const [detailMode, setDetailMode] = useState<DetailViewMode>('clean')
  const [detailScrollOffset, setDetailScrollOffset] = useState(0)
  const [_traceScrollOffset, setTraceScrollOffset] = useState(0)
  const [expandedContextIds, setExpandedContextIds] = useState<Set<string>>(new Set())
  const [resolvedMessages, setResolvedMessages] = useState<Map<string, ContextMessageItem[]>>(
    new Map(),
  )
  const [browseMode, setBrowseMode] = useState(false)
  const [displayMode, setDisplayMode] = useState<DisplayMode>(options.defaultMode ?? 'debug')
  const [logScrollOffset, setLogScrollOffset] = useState(0)
  const [logSelectedIndex, setLogSelectedIndex] = useState(0)
  const [logDetailVisible, setLogDetailVisible] = useState(false)
  const [logDetailScrollOffset, setLogDetailScrollOffset] = useState(0)
  const detailMaxOffsetRef = useRef(0)

  const { logs } = useLogCapture({ bufferSize: options.logBufferSize ?? 1000 })

  const contentMode = displayMode === 'content'
  const selectedEventIdRef = useRef<string | undefined>(undefined)
  const wasOnPendingBracketRef = useRef<PendingBracket | null>(null)
  const wasOnDeltaBatchRef = useRef<{
    id: string
    deltaType: 'thought_delta' | 'assistant_delta'
  } | null>(null)
  const currentScrollRef = useRef(0)
  const visualHeightCacheRef = useRef<Map<string, number>>(new Map())
  const lastTerminalWidthRef = useRef<number>(terminalWidth)
  const preInputSelectionRef = useRef<{ index: number; eventId: string | undefined } | null>(null)

  const handleMaxOffsetChange = useCallback((maxOffset: number) => {
    detailMaxOffsetRef.current = maxOffset
    setDetailScrollOffset((prev) => Math.min(prev, maxOffset))
  }, [])

  const blocks = useMemo(() => buildInvocationBlocks(events), [events])

  const enrichedBlocks = useMemo(() => {
    if (resolvedMessages.size === 0) return blocks
    function enrichBlock(block: InvocationBlock): InvocationBlock {
      const contextBlocks = block.contextBlocks.map((cb) => {
        const ctxId = cb.contextEvent?.id
        const resolved = ctxId ? resolvedMessages.get(ctxId) : undefined
        if (!resolved) return cb
        return { ...cb, messageItems: resolved }
      })
      return { ...block, contextBlocks, children: block.children.map(enrichBlock) }
    }
    return blocks.map(enrichBlock)
  }, [blocks, resolvedMessages])

  const displayOrderEvents = useMemo(
    () => getEventsInDisplayOrder(enrichedBlocks, expandedContextIds),
    [enrichedBlocks, expandedContextIds],
  )
  const pendingBrackets = useMemo(() => getPendingBrackets(enrichedBlocks), [enrichedBlocks])
  const selectableEvents = useMemo(
    () => [...getSelectableEvents(displayOrderEvents), ...pendingBrackets],
    [displayOrderEvents, pendingBrackets],
  )

  const showPrompt = status === 'idle'
  const showInputYield = status === 'yielded' && inputRequired
  const promptInputVisible = (showInputYield || showPrompt) && !browseMode
  const promptInputHeight = promptInputVisible ? PROMPT_INPUT_HEIGHT : 0
  const totalFixedHeight = (detailVisible ? LAYOUT.helpLines : FIXED_UI_LINES) + promptInputHeight
  const availableForContent = terminalHeight - totalFixedHeight
  const detailPaneHeight = useMemo(() => {
    if (!detailVisible) return 0
    return availableForContent
  }, [detailVisible, availableForContent])
  const availableTraceHeight = detailVisible ? 0 : availableForContent
  const flattenedLines = useMemo(
    () => flattenBlocks(enrichedBlocks, selectableEvents, expandedContextIds),
    [enrichedBlocks, selectableEvents, expandedContextIds],
  )
  const visibleFlattenedLines = useMemo(() => {
    if (!contentMode) return flattenedLines
    return flattenedLines.filter((line) => isLineVisibleInCleanMode(line))
  }, [flattenedLines, contentMode])

  const eventIndexToLineMap = useMemo(
    () => buildEventIndexToLineMap(visibleFlattenedLines),
    [visibleFlattenedLines],
  )

  const flattenedEventIndexToLineMap = useMemo(
    () => buildEventIndexToLineMap(flattenedLines),
    [flattenedLines],
  )

  const selectableEventIdToIndex = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < selectableEvents.length; i++) {
      const id = (selectableEvents[i] as { id?: string }).id
      if (id) map.set(id, i)
    }
    return map
  }, [selectableEvents])

  const pendingBracketLookupMaps = useMemo(
    () => buildPendingBracketLookupMaps(selectableEvents),
    [selectableEvents],
  )

  const visualLineHeights = useMemo(() => {
    if (!contentMode) return visibleFlattenedLines.map(() => 1)

    if (terminalWidth !== lastTerminalWidthRef.current) {
      visualHeightCacheRef.current.clear()
      lastTerminalWidthRef.current = terminalWidth
    }

    const cache = visualHeightCacheRef.current
    return visibleFlattenedLines.map((line) => {
      const cacheKey = line.key
      const cached = cache.get(cacheKey)
      if (cached !== undefined) return cached

      const height = calculateCleanModeVisualLines(line, terminalWidth)
      cache.set(cacheKey, height)
      return height
    })
  }, [visibleFlattenedLines, contentMode, terminalWidth])

  const visualLineStarts = useMemo(() => {
    const starts: number[] = []
    let cumulative = 0
    for (const height of visualLineHeights) {
      starts.push(cumulative)
      cumulative += height
    }
    return starts
  }, [visualLineHeights])

  const totalVisualLines = useMemo(() => {
    return visualLineHeights.reduce((sum, h) => sum + h, 0)
  }, [visualLineHeights])

  const getContentHeight = useCallback(
    (offset: number) => {
      const atTop = offset === 0
      const conservativeHeight = availableTraceHeight - (atTop ? 1 : 2)
      const atBottom = offset + conservativeHeight >= totalVisualLines - 1
      if (atTop && atBottom) {
        return availableTraceHeight
      } else if (atTop || atBottom) {
        return availableTraceHeight - 1
      } else {
        return availableTraceHeight - 2
      }
    },
    [availableTraceHeight, totalVisualLines],
  )

  /* oxlint-disable eslint-plugin-react-hooks(exhaustive-deps) */
  const adjustedScrollOffset = useMemo(() => {
    if (selectableEvents.length === 0) return currentScrollRef.current

    const contentHeightAtTop = getContentHeight(0)
    if (totalVisualLines <= contentHeightAtTop) {
      return 0
    }

    const lineIndex = getLineIndexForEvent(
      visibleFlattenedLines,
      selectedIndex,
      eventIndexToLineMap,
    )
    const lineVisualStart = visualLineStarts[lineIndex] ?? 0
    const lineVisualHeight = visualLineHeights[lineIndex] ?? 1
    const lineVisualEnd = lineVisualStart + lineVisualHeight

    const contentHeightScrolled = availableTraceHeight - 2
    const contentHeightAtBottom = availableTraceHeight - 1
    const maxOffsetScrolled = Math.max(0, totalVisualLines - contentHeightAtBottom)
    const currentScroll = Math.min(currentScrollRef.current, maxOffsetScrolled)

    if (currentScroll === 0) {
      if (lineVisualEnd <= contentHeightAtTop) {
        return 0
      }
      if (contentMode && lineVisualHeight > contentHeightScrolled) {
        return Math.min(maxOffsetScrolled, lineVisualStart)
      }
      return Math.min(maxOffsetScrolled, lineVisualEnd - contentHeightScrolled)
    }

    const contentHeight = getContentHeight(currentScroll)
    if (lineVisualStart < currentScroll) {
      return lineVisualStart === 0 ? 0 : Math.max(0, lineVisualStart)
    } else if (lineVisualEnd > currentScroll + contentHeight) {
      if (contentMode && lineVisualHeight > contentHeight) {
        return Math.min(maxOffsetScrolled, lineVisualStart)
      }
      return Math.min(maxOffsetScrolled, lineVisualEnd - contentHeightScrolled)
    }
    return currentScroll
  }, [
    selectedIndex,
    availableTraceHeight,
    visibleFlattenedLines,
    totalVisualLines,
    visualLineStarts,
    visualLineHeights,
    selectableEvents.length,
    contentMode,
    getContentHeight,
  ])
  /* oxlint-enable eslint-plugin-react-hooks(exhaustive-deps) */

  useLayoutEffect(() => {
    currentScrollRef.current = adjustedScrollOffset
  }, [adjustedScrollOffset])

  /* oxlint-disable eslint-plugin-react-hooks(exhaustive-deps) */
  useEffect(() => {
    if (initialInput) {
      run(initialInput)
    }
  }, [])
  /* oxlint-enable eslint-plugin-react-hooks(exhaustive-deps) */

  useEffect(() => {
    if (status === 'completed' || status === 'error') {
      if (result && onResult) {
        onResult(result)
      }
      if (options.exitOnComplete === true) {
        setTimeout(() => exit(), 100)
      }
    }
    if (status === 'running') {
      setBrowseMode(false)
      if (detailMode === 'input') {
        setDetailMode('clean')
      }
    }
    if (status === 'yielded') {
      setBrowseMode(true)
    }
  }, [status, options.exitOnComplete, exit, result, onResult, detailMode])

  useEffect(() => {
    setDetailScrollOffset(0)
  }, [selectedIndex])

  /* oxlint-disable eslint-plugin-react-hooks(exhaustive-deps) */
  useEffect(() => {
    if (selectableEvents.length === 0) return

    const currentEvent = selectableEvents[selectedIndex]
    const currentId = getEventId(currentEvent)

    if (wasOnPendingBracketRef.current && currentId !== wasOnPendingBracketRef.current.id) {
      const realEventIndex = findRealEventForPendingBracket(
        wasOnPendingBracketRef.current,
        pendingBracketLookupMaps,
      )
      if (realEventIndex >= 0) {
        setSelectedIndex(realEventIndex)
        selectedEventIdRef.current = getEventId(selectableEvents[realEventIndex])
        wasOnPendingBracketRef.current = null
        wasOnDeltaBatchRef.current = null
        return
      }
    }

    if (selectedEventIdRef.current && currentId !== selectedEventIdRef.current) {
      const newIndex = selectableEventIdToIndex.get(selectedEventIdRef.current)
      if (newIndex !== undefined && newIndex >= 0 && newIndex !== selectedIndex) {
        setSelectedIndex(newIndex)
        return
      }
    }

    if (wasOnDeltaBatchRef.current && currentId !== wasOnDeltaBatchRef.current.id) {
      const batchStillExists = selectableEventIdToIndex.has(wasOnDeltaBatchRef.current.id)
      if (!batchStillExists) {
        const finalEventIndex = findFinalEventForDeltaBatch(
          wasOnDeltaBatchRef.current.deltaType,
          selectableEvents,
          selectedIndex,
        )
        if (finalEventIndex >= 0) {
          setSelectedIndex(finalEventIndex)
          selectedEventIdRef.current = getEventId(selectableEvents[finalEventIndex])
          wasOnDeltaBatchRef.current = null
          return
        }
      }
    }

    if (selectedIndex >= selectableEvents.length) {
      const newIndex = selectableEvents.length - 1
      setSelectedIndex(newIndex)
      selectedEventIdRef.current = getEventId(selectableEvents[newIndex])
    } else {
      selectedEventIdRef.current = currentId
    }

    if (
      currentEvent?.type === 'pending_block_end' ||
      currentEvent?.type === 'pending_context_end'
    ) {
      wasOnPendingBracketRef.current = currentEvent as PendingBracket
      wasOnDeltaBatchRef.current = null
    } else if (currentEvent?.type === 'delta_batch') {
      const batch = currentEvent as { id: string; deltaType: 'thought_delta' | 'assistant_delta' }
      wasOnDeltaBatchRef.current = { id: batch.id, deltaType: batch.deltaType }
      wasOnPendingBracketRef.current = null
    } else {
      wasOnPendingBracketRef.current = null
      wasOnDeltaBatchRef.current = null
    }
  }, [selectableEvents, selectedIndex])
  /* oxlint-enable eslint-plugin-react-hooks(exhaustive-deps) */

  const selectedEvent = selectableEvents[selectedIndex] ?? null
  const selectedEventStreaming = useMemo(() => {
    if (!selectedEvent) return undefined
    const eventId = (selectedEvent as { id?: string }).id
    if (!eventId) return undefined
    return getStreamingMetadata(enrichedBlocks, eventId)
  }, [selectedEvent, enrichedBlocks])
  const yieldedToolIds = useMemo(() => new Set(yieldedTools.map((c) => c.callId)), [yieldedTools])
  const toolResultCallIds = useMemo(() => {
    const ids = new Set<string>()
    for (const evt of events) {
      if (evt.type === 'tool_result') {
        ids.add((evt as { callId: string }).callId)
      }
    }
    return ids
  }, [events])
  const pendingToolCallForInput = useMemo((): { event: ToolCallEvent; index: number } | null => {
    if (status !== 'yielded') return null
    if (!selectedEvent) return null
    if (selectedEvent.type === 'tool_call') {
      if (selectedEvent.yields && !toolResultCallIds.has(selectedEvent.callId)) {
        return { event: selectedEvent, index: selectedIndex }
      }
    }
    if (selectedEvent.type === 'invocation_yield') {
      const pendingCallId = selectedEvent.yieldedToolIds[0]
      if (pendingCallId) {
        const toolCallIndex = selectableEvents.findIndex(
          (e) => e.type === 'tool_call' && 'callId' in e && e.callId === pendingCallId,
        )
        const toolCallEvent = selectableEvents[toolCallIndex]
        if (toolCallIndex >= 0 && toolCallEvent?.type === 'tool_call') {
          return { event: toolCallEvent, index: toolCallIndex }
        }
      }
    }
    return null
  }, [selectedEvent, status, toolResultCallIds, selectedIndex, selectableEvents])
  const isSelectedEventPendingYield = pendingToolCallForInput !== null

  const yieldSchemas = useMemo(() => extractYieldSchemas(runnable), [runnable])
  const selectedYieldSchema = useMemo(() => {
    if (!pendingToolCallForInput) return undefined
    return yieldSchemas.get(pendingToolCallForInput.event.name)
  }, [pendingToolCallForInput, yieldSchemas])

  const detailEvent = useMemo(() => {
    if (pendingToolCallForInput) {
      const yieldEvt = events.find(
        (e): e is ToolYieldEvent =>
          e.type === 'tool_yield' && e.callId === pendingToolCallForInput.event.callId,
      )
      if (yieldEvt) return yieldEvt
    }
    return selectedEvent
  }, [selectedEvent, pendingToolCallForInput, events])

  const firstPendingToolCall = useMemo((): { event: ToolCallEvent; index: number } | null => {
    if (status !== 'yielded' || yieldedTools.length === 0) return null
    for (let i = 0; i < selectableEvents.length; i++) {
      const evt = selectableEvents[i]
      if (evt.type === 'tool_call') {
        if (evt.yields && !toolResultCallIds.has(evt.callId)) {
          return { event: evt, index: i }
        }
      }
    }
    return null
  }, [status, yieldedTools.length, selectableEvents, toolResultCallIds])

  const isDetailInputMode = detailVisible && detailMode === 'input' && isSelectedEventPendingYield
  const isPromptInputMode = showPrompt || showInputYield
  const hasUnhandledYields = status === 'yielded' && yieldedTools.length > 0 && !inputRequired

  const handleDetailInputSubmit = useCallback(
    (value: string) => {
      if (!pendingToolCallForInput) return
      const toolCall = pendingToolCallForInput.event
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        parsed = value
      }
      const responses = new Map<string, unknown>()
      responses.set(toolCall.callId, parsed)
      setDetailMode('clean')
      setDetailVisible(false)
      if (preInputSelectionRef.current) {
        setSelectedIndex(preInputSelectionRef.current.index)
        selectedEventIdRef.current = preInputSelectionRef.current.eventId
        preInputSelectionRef.current = null
      }
      resume(responses)
    },
    [pendingToolCallForInput, resume],
  )

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    if (isDetailInputMode) {
      if (key.escape) {
        setDetailMode('clean')
        setDetailVisible(false)
        if (preInputSelectionRef.current) {
          setSelectedIndex(preInputSelectionRef.current.index)
          selectedEventIdRef.current = preInputSelectionRef.current.eventId
          preInputSelectionRef.current = null
        }
      }
      return
    }

    if (isPromptInputMode && !browseMode) {
      if (key.escape) {
        setBrowseMode(true)
      }
      return
    }

    if (isPromptInputMode && browseMode && input === 'i') {
      setBrowseMode(false)
      return
    }

    if (key.pageUp) {
      if (detailVisible) {
        setDetailScrollOffset((prev) => Math.max(0, prev - DETAIL_SCROLL_PAGE_SIZE))
      } else {
        const pageSize = getContentHeight(currentScrollRef.current)
        const newOffset = Math.max(0, currentScrollRef.current - pageSize)
        currentScrollRef.current = newOffset
        setTraceScrollOffset(newOffset)
      }
      return
    }

    if (key.pageDown) {
      if (detailVisible) {
        setDetailScrollOffset((prev) =>
          Math.min(detailMaxOffsetRef.current, prev + DETAIL_SCROLL_PAGE_SIZE),
        )
      } else {
        const pageSize = getContentHeight(currentScrollRef.current)
        const contentHeightAtBottom = availableTraceHeight - 1
        const maxOffset = Math.max(0, totalVisualLines - contentHeightAtBottom)
        const newOffset = Math.min(maxOffset, currentScrollRef.current + pageSize)
        currentScrollRef.current = newOffset
        setTraceScrollOffset(newOffset)
      }
      return
    }

    if (displayMode === 'logging' && !logDetailVisible && key.leftArrow) {
      const contentHeight = availableTraceHeight - 2
      const newOffset = Math.max(0, logScrollOffset - contentHeight)
      const newSelectedIndex = Math.max(0, logSelectedIndex - contentHeight)
      setLogScrollOffset(newOffset)
      setLogSelectedIndex(newSelectedIndex)
      return
    }

    if (displayMode === 'logging' && !logDetailVisible && key.rightArrow) {
      const contentHeight = availableTraceHeight - 2
      const maxOffset = Math.max(0, logs.length - contentHeight)
      const newOffset = Math.min(maxOffset, logScrollOffset + contentHeight)
      const newSelectedIndex = Math.min(logs.length - 1, logSelectedIndex + contentHeight)
      setLogScrollOffset(newOffset)
      setLogSelectedIndex(newSelectedIndex)
      return
    }

    if (!detailVisible && key.rightArrow) {
      const currentLineIdx = getLineIndexForEvent(
        flattenedLines,
        selectedIndex,
        flattenedEventIndexToLineMap,
      )
      const targetEventIndex = findBlockEndEventIndex(flattenedLines, currentLineIdx)
      if (targetEventIndex !== undefined && targetEventIndex !== selectedIndex) {
        setSelectedIndex(targetEventIndex)
        selectedEventIdRef.current = getEventId(selectableEvents[targetEventIndex])
        setDetailScrollOffset(0)
      }
      return
    }

    if (!detailVisible && key.leftArrow) {
      const currentLineIdx = getLineIndexForEvent(
        flattenedLines,
        selectedIndex,
        flattenedEventIndexToLineMap,
      )
      const targetEventIndex = findBlockStartEventIndex(flattenedLines, currentLineIdx)
      if (targetEventIndex !== undefined && targetEventIndex !== selectedIndex) {
        setSelectedIndex(targetEventIndex)
        selectedEventIdRef.current = getEventId(selectableEvents[targetEventIndex])
        setDetailScrollOffset(0)
      }
      return
    }

    if (detailVisible && input === 'r') {
      setDetailMode('raw')
      setDetailScrollOffset(0)
      return
    }

    if (detailVisible && input === 'c') {
      setDetailMode('clean')
      setDetailScrollOffset(0)
      return
    }

    if (input === 'c' && displayMode !== 'content') {
      const currentLineIdx = getLineIndexForEvent(
        flattenedLines,
        selectedIndex,
        flattenedEventIndexToLineMap,
      )
      const currentLine = flattenedLines[currentLineIdx]
      if (currentLine && !isLineVisibleInCleanMode(currentLine)) {
        let targetLineIdx = currentLineIdx + 1
        while (
          targetLineIdx < flattenedLines.length &&
          (flattenedLines[targetLineIdx].eventIndex === undefined ||
            !isLineVisibleInCleanMode(flattenedLines[targetLineIdx]))
        ) {
          targetLineIdx++
        }
        if (
          targetLineIdx < flattenedLines.length &&
          flattenedLines[targetLineIdx].eventIndex !== undefined
        ) {
          const newIndex = flattenedLines[targetLineIdx].eventIndex!
          setSelectedIndex(newIndex)
          selectedEventIdRef.current = getEventId(selectableEvents[newIndex])
        }
      }
      setDisplayMode('content')
      return
    }

    if (input === 'd' && displayMode !== 'debug') {
      setDisplayMode('debug')
      return
    }

    if (input === 'l' && displayMode !== 'logging') {
      const contentHeight = availableTraceHeight - 2
      const newSelectedIndex = Math.max(0, logs.length - 1)
      setLogSelectedIndex(newSelectedIndex)
      setLogScrollOffset(Math.max(0, logs.length - contentHeight))
      setDisplayMode('logging')
      setLogDetailVisible(false)
      return
    }

    if (input === 'i' && hasUnhandledYields) {
      preInputSelectionRef.current = { index: selectedIndex, eventId: selectedEventIdRef.current }
      if (pendingToolCallForInput) {
        if (pendingToolCallForInput.index !== selectedIndex) {
          setSelectedIndex(pendingToolCallForInput.index)
          selectedEventIdRef.current = getEventId(pendingToolCallForInput.event)
        }
        setDetailVisible(true)
        setDetailMode('input')
      } else if (firstPendingToolCall) {
        setSelectedIndex(firstPendingToolCall.index)
        selectedEventIdRef.current = getEventId(firstPendingToolCall.event)
        setDetailVisible(true)
        setDetailMode('input')
        setDetailScrollOffset(0)
      }
      return
    }

    if (key.upArrow) {
      if (displayMode === 'logging') {
        if (logDetailVisible) {
          setLogDetailScrollOffset((prev) => Math.max(0, prev - 1))
        } else if (logs.length > 0) {
          const newIndex = Math.max(0, logSelectedIndex - 1)
          setLogSelectedIndex(newIndex)
          if (newIndex < logScrollOffset) {
            setLogScrollOffset(newIndex)
          }
        }
        return
      }
      if (detailVisible) {
        setDetailScrollOffset((prev) => Math.max(0, prev - 1))
        return
      }
      const currentLineIdx = getLineIndexForEvent(
        flattenedLines,
        selectedIndex,
        flattenedEventIndexToLineMap,
      )
      let targetLineIdx = currentLineIdx - 1
      while (
        targetLineIdx >= 0 &&
        (flattenedLines[targetLineIdx].eventIndex === undefined ||
          // oxlint-disable-next-line eslint(no-unmodified-loop-condition)
          (contentMode && !isLineVisibleInCleanMode(flattenedLines[targetLineIdx])))
      ) {
        targetLineIdx--
      }
      if (targetLineIdx >= 0 && flattenedLines[targetLineIdx].eventIndex !== undefined) {
        const newIndex = flattenedLines[targetLineIdx].eventIndex!
        setSelectedIndex(newIndex)
        selectedEventIdRef.current = getEventId(selectableEvents[newIndex])
        setDetailScrollOffset(0)
      }
    } else if (key.downArrow) {
      if (displayMode === 'logging') {
        if (logDetailVisible) {
          setLogDetailScrollOffset((prev) => prev + 1)
        } else if (logs.length > 0) {
          const contentHeight = availableTraceHeight - 2
          const newIndex = Math.min(logs.length - 1, logSelectedIndex + 1)
          setLogSelectedIndex(newIndex)
          if (newIndex >= logScrollOffset + contentHeight) {
            setLogScrollOffset(newIndex - contentHeight + 1)
          }
        }
        return
      }
      if (detailVisible) {
        setDetailScrollOffset((prev) => Math.min(detailMaxOffsetRef.current, prev + 1))
        return
      }
      const currentLineIdx = getLineIndexForEvent(
        flattenedLines,
        selectedIndex,
        flattenedEventIndexToLineMap,
      )
      let targetLineIdx = currentLineIdx + 1
      while (
        targetLineIdx < flattenedLines.length &&
        (flattenedLines[targetLineIdx].eventIndex === undefined ||
          // oxlint-disable-next-line eslint(no-unmodified-loop-condition)
          (contentMode && !isLineVisibleInCleanMode(flattenedLines[targetLineIdx])))
      ) {
        targetLineIdx++
      }
      if (
        targetLineIdx < flattenedLines.length &&
        flattenedLines[targetLineIdx].eventIndex !== undefined
      ) {
        const newIndex = flattenedLines[targetLineIdx].eventIndex!
        setSelectedIndex(newIndex)
        selectedEventIdRef.current = getEventId(selectableEvents[newIndex])
        setDetailScrollOffset(0)
      }
    } else if (input === ' ' || key.return) {
      if (displayMode === 'logging') {
        if (logs.length > 0 && logSelectedIndex >= 0 && logSelectedIndex < logs.length) {
          setLogDetailVisible((v) => !v)
          setLogDetailScrollOffset(0)
        }
      } else if (displayMode === 'debug') {
        const selected = selectableEvents[selectedIndex]
        if (selected?.type === 'model_start') {
          const contextId = (selected as { id: string }).id
          if (expandedContextIds.has(contextId)) {
            setDetailVisible((v) => !v)
          } else {
            if (!resolvedMessages.has(contextId)) {
              const evt = selected as ModelStartEvent
              const agent = runner.getAgent(evt.agentName)
              if (agent) {
                const idx = session.eventIndexOf(evt.id)
                if (idx !== undefined && idx > 0) {
                  const snapshot = session.forkAt(idx - 1)
                  try {
                    const ctx = buildContext(snapshot, agent, evt.invocationId)
                    const items: ContextMessageItem[] = ctx.events
                      .map(eventToMessageSummary)
                      .filter((s): s is ContextMessageSummary => s !== null)
                      .map((msg, i) => ({
                        id: `${evt.id}-msg-${i}`,
                        type: 'context_message' as const,
                        parentContextId: evt.id,
                        message: msg,
                        index: i,
                      }))
                    setResolvedMessages((prev) => new Map(prev).set(contextId, items))
                  } catch {
                    // async renderers — fall back to buildContextAsync
                    buildContextAsync(snapshot, agent, evt.invocationId)
                      .then((ctx) => {
                        const items: ContextMessageItem[] = ctx.events
                          .map(eventToMessageSummary)
                          .filter((s): s is ContextMessageSummary => s !== null)
                          .map((msg, i) => ({
                            id: `${evt.id}-msg-${i}`,
                            type: 'context_message' as const,
                            parentContextId: evt.id,
                            message: msg,
                            index: i,
                          }))
                        setResolvedMessages((prev) => new Map(prev).set(contextId, items))
                      })
                      .catch(() => {})
                  }
                }
              }
            }
            setExpandedContextIds(new Set([contextId]))
          }
        } else {
          setDetailVisible((v) => !v)
        }
      }
    } else if (key.escape) {
      if (displayMode === 'logging') {
        setLogDetailVisible(false)
        setLogDetailScrollOffset(0)
      } else if (detailVisible) {
        if (detailMode === 'input') {
          setDetailMode('clean')
        }
        setDetailVisible(false)
        setDetailScrollOffset(0)
        if (preInputSelectionRef.current) {
          setSelectedIndex(preInputSelectionRef.current.index)
          selectedEventIdRef.current = preInputSelectionRef.current.eventId
          preInputSelectionRef.current = null
        }
      } else if (expandedContextIds.size > 0) {
        const selected = selectableEvents[selectedIndex]
        const parentContextId = (selected as { parentContextId?: string })?.parentContextId
        if (parentContextId && expandedContextIds.has(parentContextId)) {
          const contextStartIndex = selectableEvents.findIndex(
            (e) => e.type === 'model_start' && (e as { id: string }).id === parentContextId,
          )
          if (contextStartIndex >= 0) {
            setSelectedIndex(contextStartIndex)
            selectedEventIdRef.current = getEventId(selectableEvents[contextStartIndex])
          }
        }
        setExpandedContextIds(new Set())
      }
    }
  })

  const modeIndicator = (
    <Text>
      <Text dimColor={displayMode !== 'debug'}>
        {displayMode === 'debug' ? '●' : '○'} debug [d]
      </Text>
      <Text dimColor> </Text>
      <Text dimColor={displayMode !== 'content'}>
        {displayMode === 'content' ? '●' : '○'} content [c]
      </Text>
      <Text dimColor> </Text>
      <Text dimColor={displayMode !== 'logging'}>
        {displayMode === 'logging' ? '●' : '○'} logs [l]
      </Text>
    </Text>
  )

  // NOTE: Review setting height={terminalHeight} on this Box
  // When outputHeight >= stdout.rows, Ink calls clearTerminal on every render,
  // which may cause flickering.
  return (
    <Box flexDirection="column" height={terminalHeight} paddingX={LAYOUT.outerPadding}>
      {!detailVisible && (
        <Box>
          {modeIndicator}
          {!isDetailInputMode &&
            displayMode !== 'logging' &&
            (hasUnhandledYields || showInputYield ? (
              <>
                <Text dimColor> • </Text>
                <Text color="yellowBright">input [i]</Text>
              </>
            ) : isPromptInputMode && browseMode ? (
              <Text dimColor> • input [i]</Text>
            ) : null)}
        </Box>
      )}
      {displayMode === 'logging' ? (
        <Box flexDirection="column" marginBottom={LAYOUT.traceMarginBottom}>
          {logDetailVisible && logs[logSelectedIndex] ? (
            <LogDetailPane
              log={logs[logSelectedIndex]}
              height={availableTraceHeight}
              scrollOffset={logDetailScrollOffset}
            />
          ) : (
            <LogView
              logs={logs}
              maxHeight={availableTraceHeight}
              scrollOffset={logScrollOffset}
              selectedIndex={logSelectedIndex}
            />
          )}
        </Box>
      ) : (
        enrichedBlocks.length > 0 &&
        !detailVisible && (
          <Box flexDirection="column" marginBottom={LAYOUT.traceMarginBottom}>
            <TraceView
              blocks={enrichedBlocks}
              showDurations={options.showDurations}
              showIds={options.showIds}
              selectedIndex={selectedIndex}
              selectableEvents={selectableEvents}
              expandedContextIds={expandedContextIds}
              maxHeight={availableTraceHeight}
              scrollOffset={adjustedScrollOffset}
              yieldedToolIds={yieldedToolIds}
              executingCallIds={executingCallIds}
              contentMode={contentMode}
              precomputedLines={visibleFlattenedLines}
              precomputedVisualHeights={visualLineHeights}
              precomputedVisualStarts={visualLineStarts}
            />
          </Box>
        )
      )}

      {displayMode !== 'logging' && (
        <DetailPane
          event={detailEvent}
          visible={detailVisible}
          mode={detailMode}
          scrollOffset={detailScrollOffset}
          onMaxOffsetChange={handleMaxOffsetChange}
          isPendingYield={isSelectedEventPendingYield}
          onInputSubmit={handleDetailInputSubmit}
          height={detailPaneHeight}
          streaming={selectedEventStreaming}
          yieldSchema={selectedYieldSchema}
        />
      )}

      {showInputYield && !browseMode && (
        <Box marginBottom={1}>
          <PromptInput onSubmit={resumeWithInput} placeholder="Enter your message..." />
        </Box>
      )}

      {showPrompt && !browseMode && (
        <Box marginBottom={1}>
          <PromptInput onSubmit={run} placeholder="Enter your message..." />
        </Box>
      )}

      <Box>
        {isDetailInputMode ? (
          <Text dimColor>
            [↑↓] field • [←→] value • submit [Enter] • cancel [Esc] • exit [Ctrl+C]
          </Text>
        ) : displayMode === 'logging' && logDetailVisible ? (
          <Text dimColor>close [Esc] • exit [Ctrl+C]</Text>
        ) : displayMode === 'logging' ? (
          <Text dimColor>scroll [↑↓] • page [←→] • open [Enter] • exit [Ctrl+C]</Text>
        ) : detailVisible ? (
          <Text dimColor>raw [r] • close [Esc]</Text>
        ) : displayMode === 'content' && (hasUnhandledYields || showInputYield) ? (
          <Text dimColor>close [Esc] • exit [Ctrl+C]</Text>
        ) : displayMode === 'content' ? (
          <Text dimColor>scroll [↑↓] • exit [Ctrl+C]</Text>
        ) : showInputYield && browseMode ? (
          <Text dimColor>scroll [↑↓] • jump [←→] • open [Enter] • exit [Ctrl+C]</Text>
        ) : isPromptInputMode && browseMode ? (
          <Text dimColor>scroll [↑↓] • jump [←→] • open [Enter] • exit [Ctrl+C]</Text>
        ) : isPromptInputMode ? (
          <Text dimColor>browse [Esc] • exit [Ctrl+C]</Text>
        ) : hasUnhandledYields ? (
          <Text dimColor>scroll [↑↓] • jump [←→] • open [Enter] • exit [Ctrl+C]</Text>
        ) : (
          <Text dimColor>scroll [↑↓] • jump [←→] • open [Enter] • close [Esc] • exit [Ctrl+C]</Text>
        )}
      </Box>
    </Box>
  )
}
