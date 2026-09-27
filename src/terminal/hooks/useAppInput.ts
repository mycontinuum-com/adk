// @ts-ignore
import { useInput } from 'ink'

import type { BaseRunner } from '../../core/runner'
import type { BaseSession } from '../../session'
import type { ContextMessageSummary, ModelStartEvent, ToolCallEvent } from '../../types'
import type { ContextMessageItem, DisplayEvent } from '../blocks'
import type { FlattenedLine } from '../components/TraceView'
import type { LogEntry } from './useLogCapture'
import type { useSelectionTracking } from './useSelectionTracking'
import type { TerminalViewState } from './useTerminalViewState'

import { buildContext, buildContextAsync, eventToMessageSummary } from '../../context/build'
import { getEventId, isLineVisibleInCleanMode } from '../app-helpers'
import {
  findBlockEndEventIndex,
  findBlockStartEventIndex,
  getLineIndexForEvent,
} from '../components/TraceView'
import { DETAIL_SCROLL_PAGE_SIZE } from '../constants'

function toContextMessageItems(
  evt: ModelStartEvent,
  events: readonly Parameters<typeof eventToMessageSummary>[0][],
): ContextMessageItem[] {
  return events
    .map(eventToMessageSummary)
    .filter((s): s is ContextMessageSummary => s !== null)
    .map((msg, i) => ({
      id: `${evt.id}-msg-${i}`,
      type: 'context_message' as const,
      parentContextId: evt.id,
      message: msg,
      index: i,
    }))
}

function resolveContextMessages(
  evt: ModelStartEvent,
  runner: BaseRunner,
  session: BaseSession,
  onResolved: (items: ContextMessageItem[]) => void,
): void {
  const agent = runner.getAgent(evt.agentName)
  if (!agent) return
  const idx = session.eventIndexOf(evt.id)
  if (idx === undefined || idx <= 0) return
  const snapshot = session.forkAt(idx - 1)
  try {
    const ctx = buildContext(snapshot, agent, evt.invocationId)
    onResolved(toContextMessageItems(evt, ctx.events))
  } catch {
    // async renderers — fall back to buildContextAsync
    buildContextAsync(snapshot, agent, evt.invocationId)
      .then((ctx) => onResolved(toContextMessageItems(evt, ctx.events)))
      .catch(() => {})
  }
}

interface InputKey {
  escape?: boolean
  pageUp?: boolean
  pageDown?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
}

interface PendingToolCall {
  event: ToolCallEvent
  index: number
}

interface AppInputParams {
  view: TerminalViewState
  selection: ReturnType<typeof useSelectionTracking>
  exit: () => void
  runner: BaseRunner
  session: BaseSession
  logs: LogEntry[]
  selectableEvents: DisplayEvent[]
  flattenedLines: FlattenedLine[]
  flattenedEventIndexToLineMap: Map<number, number>
  currentScrollRef: { current: number }
  getContentHeight: (offset: number) => number
  availableTraceHeight: number
  totalVisualLines: number
  contentMode: boolean
  isDetailInputMode: boolean
  isPromptInputMode: boolean
  hasUnhandledYields: boolean
  pendingToolCallForInput: PendingToolCall | null
  firstPendingToolCall: PendingToolCall | null
}

/** Routes terminal key presses to selection, scrolling, detail and display-mode changes. */
export function useAppInput({
  view,
  selection,
  exit,
  runner,
  session,
  logs,
  selectableEvents,
  flattenedLines,
  flattenedEventIndexToLineMap,
  currentScrollRef,
  getContentHeight,
  availableTraceHeight,
  totalVisualLines,
  contentMode,
  isDetailInputMode,
  isPromptInputMode,
  hasUnhandledYields,
  pendingToolCallForInput,
  firstPendingToolCall,
}: AppInputParams): void {
  const { selectedIndex, setSelectedIndex, selectedEventIdRef } = selection
  const {
    detailVisible,
    setDetailVisible,
    detailMode,
    setDetailMode,
    setDetailScrollOffset,
    setTraceScrollOffset,
    expandedContextIds,
    setExpandedContextIds,
    resolvedMessages,
    setResolvedMessages,
    browseMode,
    setBrowseMode,
    displayMode,
    setDisplayMode,
    logScrollOffset,
    setLogScrollOffset,
    logSelectedIndex,
    setLogSelectedIndex,
    logDetailVisible,
    setLogDetailVisible,
    setLogDetailScrollOffset,
    detailMaxOffsetRef,
    preInputSelectionRef,
  } = view

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    if (isDetailInputMode) {
      if (key.escape) {
        setDetailMode('clean')
        setDetailVisible(false)
        restorePreInputSelection()
      }
      return
    }

    if (handlePromptInputKeys(input, key)) return
    if (handlePageKeys(key)) return
    if (handleLogPageKeys(key)) return
    if (handleBlockJumpKeys(key)) return
    if (handleModeKeys(input)) return
    if (handleYieldInputKey(input)) return

    if (key.upArrow) {
      moveSelection(-1)
    } else if (key.downArrow) {
      moveSelection(1)
    } else if (input === ' ' || key.return) {
      activateSelection()
    } else if (key.escape) {
      handleEscape()
    }
  })

  function restorePreInputSelection(): void {
    if (preInputSelectionRef.current) {
      setSelectedIndex(preInputSelectionRef.current.index)
      selectedEventIdRef.current = preInputSelectionRef.current.eventId
      preInputSelectionRef.current = null
    }
  }

  function currentLineIndex(): number {
    return getLineIndexForEvent(flattenedLines, selectedIndex, flattenedEventIndexToLineMap)
  }

  /**
   * Event index of the nearest selectable line from `start` in `step` direction, skipping lines
   * hidden in clean mode when `cleanOnly` is set.
   */
  function nearestSelectableLine(start: number, step: 1 | -1, cleanOnly: boolean) {
    let targetLineIdx = start + step
    while (
      targetLineIdx >= 0 &&
      targetLineIdx < flattenedLines.length &&
      (flattenedLines[targetLineIdx].eventIndex === undefined ||
        (cleanOnly && !isLineVisibleInCleanMode(flattenedLines[targetLineIdx])))
    ) {
      targetLineIdx += step
    }
    if (targetLineIdx >= 0 && targetLineIdx < flattenedLines.length) {
      return flattenedLines[targetLineIdx].eventIndex
    }
    return undefined
  }

  function handlePromptInputKeys(input: string, key: InputKey): boolean {
    if (isPromptInputMode && !browseMode) {
      if (key.escape) {
        setBrowseMode(true)
      }
      return true
    }

    if (isPromptInputMode && browseMode && input === 'i') {
      setBrowseMode(false)
      return true
    }
    return false
  }

  function handlePageKeys(key: InputKey): boolean {
    if (key.pageUp) {
      if (detailVisible) {
        setDetailScrollOffset((prev) => Math.max(0, prev - DETAIL_SCROLL_PAGE_SIZE))
      } else {
        const pageSize = getContentHeight(currentScrollRef.current)
        const newOffset = Math.max(0, currentScrollRef.current - pageSize)
        currentScrollRef.current = newOffset
        setTraceScrollOffset(newOffset)
      }
      return true
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
      return true
    }
    return false
  }

  function handleLogPageKeys(key: InputKey): boolean {
    if (displayMode === 'logging' && !logDetailVisible && key.leftArrow) {
      const contentHeight = availableTraceHeight - 2
      const newOffset = Math.max(0, logScrollOffset - contentHeight)
      const newSelectedIndex = Math.max(0, logSelectedIndex - contentHeight)
      setLogScrollOffset(newOffset)
      setLogSelectedIndex(newSelectedIndex)
      return true
    }

    if (displayMode === 'logging' && !logDetailVisible && key.rightArrow) {
      const contentHeight = availableTraceHeight - 2
      const maxOffset = Math.max(0, logs.length - contentHeight)
      const newOffset = Math.min(maxOffset, logScrollOffset + contentHeight)
      const newSelectedIndex = Math.min(logs.length - 1, logSelectedIndex + contentHeight)
      setLogScrollOffset(newOffset)
      setLogSelectedIndex(newSelectedIndex)
      return true
    }
    return false
  }

  function jumpToEvent(targetEventIndex: number | undefined): void {
    if (targetEventIndex !== undefined && targetEventIndex !== selectedIndex) {
      setSelectedIndex(targetEventIndex)
      selectedEventIdRef.current = getEventId(selectableEvents[targetEventIndex])
      setDetailScrollOffset(0)
    }
  }

  function handleBlockJumpKeys(key: InputKey): boolean {
    if (!detailVisible && key.rightArrow) {
      jumpToEvent(findBlockEndEventIndex(flattenedLines, currentLineIndex()))
      return true
    }

    if (!detailVisible && key.leftArrow) {
      jumpToEvent(findBlockStartEventIndex(flattenedLines, currentLineIndex()))
      return true
    }
    return false
  }

  function switchToContentMode(): void {
    const currentLineIdx = currentLineIndex()
    const currentLine = flattenedLines[currentLineIdx]
    if (currentLine && !isLineVisibleInCleanMode(currentLine)) {
      const newIndex = nearestSelectableLine(currentLineIdx, 1, true)
      if (newIndex !== undefined) {
        setSelectedIndex(newIndex)
        selectedEventIdRef.current = getEventId(selectableEvents[newIndex])
      }
    }
    setDisplayMode('content')
  }

  function switchToLoggingMode(): void {
    const contentHeight = availableTraceHeight - 2
    const newSelectedIndex = Math.max(0, logs.length - 1)
    setLogSelectedIndex(newSelectedIndex)
    setLogScrollOffset(Math.max(0, logs.length - contentHeight))
    setDisplayMode('logging')
    setLogDetailVisible(false)
  }

  function handleModeKeys(input: string): boolean {
    if (detailVisible && input === 'r') {
      setDetailMode('raw')
      setDetailScrollOffset(0)
      return true
    }

    if (detailVisible && input === 'c') {
      setDetailMode('clean')
      setDetailScrollOffset(0)
      return true
    }

    if (input === 'c' && displayMode !== 'content') {
      switchToContentMode()
      return true
    }

    if (input === 'd' && displayMode !== 'debug') {
      setDisplayMode('debug')
      return true
    }

    if (input === 'l' && displayMode !== 'logging') {
      switchToLoggingMode()
      return true
    }
    return false
  }

  function handleYieldInputKey(input: string): boolean {
    if (!(input === 'i' && hasUnhandledYields)) return false

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
    return true
  }

  function moveLogSelection(step: 1 | -1): void {
    if (logDetailVisible) {
      setLogDetailScrollOffset((prev) => (step < 0 ? Math.max(0, prev - 1) : prev + 1))
      return
    }
    if (logs.length === 0) return
    if (step < 0) {
      const newIndex = Math.max(0, logSelectedIndex - 1)
      setLogSelectedIndex(newIndex)
      if (newIndex < logScrollOffset) {
        setLogScrollOffset(newIndex)
      }
    } else {
      const contentHeight = availableTraceHeight - 2
      const newIndex = Math.min(logs.length - 1, logSelectedIndex + 1)
      setLogSelectedIndex(newIndex)
      if (newIndex >= logScrollOffset + contentHeight) {
        setLogScrollOffset(newIndex - contentHeight + 1)
      }
    }
  }

  function moveSelection(step: 1 | -1): void {
    if (displayMode === 'logging') {
      moveLogSelection(step)
      return
    }
    if (detailVisible) {
      setDetailScrollOffset((prev) =>
        step < 0 ? Math.max(0, prev - 1) : Math.min(detailMaxOffsetRef.current, prev + 1),
      )
      return
    }
    const newIndex = nearestSelectableLine(currentLineIndex(), step, contentMode)
    if (newIndex !== undefined) {
      setSelectedIndex(newIndex)
      selectedEventIdRef.current = getEventId(selectableEvents[newIndex])
      setDetailScrollOffset(0)
    }
  }

  function toggleContextOrDetail(): void {
    const selected = selectableEvents[selectedIndex]
    if (selected?.type !== 'model_start') {
      setDetailVisible((v) => !v)
      return
    }
    const contextId = (selected as { id: string }).id
    if (expandedContextIds.has(contextId)) {
      setDetailVisible((v) => !v)
    } else {
      if (!resolvedMessages.has(contextId)) {
        resolveContextMessages(selected as ModelStartEvent, runner, session, (items) =>
          setResolvedMessages((prev) => new Map(prev).set(contextId, items)),
        )
      }
      setExpandedContextIds(new Set([contextId]))
    }
  }

  function activateSelection(): void {
    if (displayMode === 'logging') {
      if (logs.length > 0 && logSelectedIndex >= 0 && logSelectedIndex < logs.length) {
        setLogDetailVisible((v) => !v)
        setLogDetailScrollOffset(0)
      }
    } else if (displayMode === 'debug') {
      toggleContextOrDetail()
    }
  }

  function collapseExpandedContext(): void {
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

  function handleEscape(): void {
    if (displayMode === 'logging') {
      setLogDetailVisible(false)
      setLogDetailScrollOffset(0)
    } else if (detailVisible) {
      if (detailMode === 'input') {
        setDetailMode('clean')
      }
      setDetailVisible(false)
      setDetailScrollOffset(0)
      restorePreInputSelection()
    } else if (expandedContextIds.size > 0) {
      collapseExpandedContext()
    }
  }
}
