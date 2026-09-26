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
              resolveContextMessages(selected as ModelStartEvent, runner, session, (items) =>
                setResolvedMessages((prev) => new Map(prev).set(contextId, items)),
              )
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
}
