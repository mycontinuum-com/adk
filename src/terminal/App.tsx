// @ts-ignore
import { Box, useApp, useStdout } from 'ink'
import React, { useEffect, useMemo, useCallback } from 'react'

import type { BaseRunner } from '../core/runner'
import type { BaseSession } from '../session'
import type { Runnable, RunResult } from '../types'
import type { TerminalOptions } from './types'

import { FIXED_UI_LINES, LAYOUT, PROMPT_INPUT_HEIGHT } from './app-helpers'
import { getStreamingMetadata } from './blocks'
import { DetailPane } from './components/DetailPane'
import { KeyHints } from './components/KeyHints'
import { LogDetailPane } from './components/LogDetailPane'
import { LogView } from './components/LogView'
import { ModeBar } from './components/ModeBar'
import { PromptInput } from './components/PromptInput'
import { TraceView } from './components/TraceView'
import { DEFAULT_TERMINAL_WIDTH, DEFAULT_TERMINAL_HEIGHT } from './constants'
import { useAgent } from './hooks/useAgent'
import { useAppInput } from './hooks/useAppInput'
import { useDisplayBlocks } from './hooks/useDisplayBlocks'
import { useInitialRun } from './hooks/useInitialRun'
import { useLogCapture } from './hooks/useLogCapture'
import { usePendingYield } from './hooks/usePendingYield'
import { useSelectionTracking } from './hooks/useSelectionTracking'
import { useTerminalViewState } from './hooks/useTerminalViewState'
import { useTraceLayout } from './hooks/useTraceLayout'

interface AppProps {
  runnable: Runnable<any>
  runner: BaseRunner
  session: BaseSession
  initialInput?: string
  options: TerminalOptions
  onResult?: (result: RunResult) => void
}

function terminalSize(stdout: { rows?: number; columns?: number } | undefined): {
  terminalHeight: number
  terminalWidth: number
} {
  return {
    terminalHeight: stdout?.rows || DEFAULT_TERMINAL_HEIGHT,
    terminalWidth: stdout?.columns || DEFAULT_TERMINAL_WIDTH,
  }
}

/** Rows left for the trace or detail pane after the fixed chrome and any prompt input. */
function contentAreaHeight(
  terminalHeight: number,
  promptInputVisible: boolean,
  detailVisible: boolean,
): number {
  const promptInputHeight = promptInputVisible ? PROMPT_INPUT_HEIGHT : 0
  const totalFixedHeight = (detailVisible ? LAYOUT.helpLines : FIXED_UI_LINES) + promptInputHeight
  return terminalHeight - totalFixedHeight
}

function modeBarInputHint({
  isDetailInputMode,
  displayMode,
  hasUnhandledYields,
  showInputYield,
  isPromptInputMode,
  browseMode,
}: {
  isDetailInputMode: boolean
  displayMode: string
  hasUnhandledYields: boolean
  showInputYield: boolean
  isPromptInputMode: boolean
  browseMode: boolean
}): 'pending' | 'available' | null {
  return isDetailInputMode || displayMode === 'logging'
    ? null
    : hasUnhandledYields || showInputYield
      ? 'pending'
      : isPromptInputMode && browseMode
        ? 'available'
        : null
}

function detailPaneKey(detailEvent: unknown, detailMode: string, isPendingYield: boolean): string {
  return `${(detailEvent as { id?: string } | null)?.id ?? 'none'}:${detailMode}:${isPendingYield}`
}

/** Whether the run waits for a typed message, or for yielded tool calls it cannot answer inline. */
function yieldState(
  status: string,
  inputRequired: boolean,
  yieldedTools: readonly unknown[],
): { showInputYield: boolean; hasUnhandledYields: boolean } {
  return {
    showInputYield: status === 'yielded' && inputRequired,
    hasUnhandledYields: status === 'yielded' && yieldedTools.length > 0 && !inputRequired,
  }
}

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
  const { terminalHeight, terminalWidth } = terminalSize(stdout)

  const {
    status,
    events,
    yieldedTools,
    executingCallIds,
    inputRequired,
    run,
    resume,
    resumeWithInput,
  } = useAgent(runnable, { runner, session, options, onResult })

  const view = useTerminalViewState(options.defaultMode ?? 'debug')
  const {
    detailVisible,
    setDetailVisible,
    detailMode,
    setDetailMode,
    detailScrollOffset,
    setDetailScrollOffset,
    expandedContextIds,
    resolvedMessages,
    browseMode,
    setBrowseMode,
    displayMode,
    logScrollOffset,
    logSelectedIndex,
    logDetailVisible,
    logDetailScrollOffset,
    preInputSelectionRef,
    handleMaxOffsetChange,
  } = view

  const { logs } = useLogCapture({ bufferSize: options.logBufferSize ?? 1000 })

  const contentMode = displayMode === 'content'

  const { enrichedBlocks, selectableEvents } = useDisplayBlocks(
    events,
    resolvedMessages,
    expandedContextIds,
  )

  const selection = useSelectionTracking(selectableEvents)
  const { selectedIndex, setSelectedIndex, selectedEventIdRef } = selection

  const showPrompt = status === 'idle'
  const { showInputYield, hasUnhandledYields } = yieldState(status, inputRequired, yieldedTools)
  const availableForContent = contentAreaHeight(
    terminalHeight,
    (showInputYield || showPrompt) && !browseMode,
    detailVisible,
  )
  const detailPaneHeight = useMemo(() => {
    if (!detailVisible) return 0
    return availableForContent
  }, [detailVisible, availableForContent])
  const availableTraceHeight = detailVisible ? 0 : availableForContent

  const {
    currentScrollRef,
    flattenedLines,
    visibleFlattenedLines,
    flattenedEventIndexToLineMap,
    visualLineHeights,
    visualLineStarts,
    totalVisualLines,
    getContentHeight,
    adjustedScrollOffset,
  } = useTraceLayout({
    blocks: enrichedBlocks,
    selectableEvents,
    expandedContextIds,
    contentMode,
    terminalWidth,
    availableTraceHeight,
    selectedIndex,
  })

  useInitialRun(initialInput, run)

  useEffect(() => {
    if ((status !== 'completed' && status !== 'error') || options.exitOnComplete !== true) return
    const timer = setTimeout(() => exit(), 100)
    return () => clearTimeout(timer)
  }, [status, options.exitOnComplete, exit])

  useEffect(() => {
    if (status === 'running') {
      setBrowseMode(false)
      if (detailMode === 'input') {
        setDetailMode('clean')
      }
    }
    if (status === 'yielded') {
      setBrowseMode(true)
    }
  }, [status, detailMode, setBrowseMode, setDetailMode])

  useEffect(() => {
    setDetailScrollOffset(0)
  }, [selectedIndex, setDetailScrollOffset])

  const {
    selectedEvent,
    pendingToolCallForInput,
    selectedYieldSchema,
    detailEvent,
    firstPendingToolCall,
  } = usePendingYield({ runnable, status, events, yieldedTools, selectableEvents, selectedIndex })
  const selectedEventStreaming = useMemo(() => {
    if (!selectedEvent) return undefined
    const eventId = (selectedEvent as { id?: string }).id
    if (!eventId) return undefined
    return getStreamingMetadata(enrichedBlocks, eventId)
  }, [selectedEvent, enrichedBlocks])
  const yieldedToolIds = useMemo(() => new Set(yieldedTools.map((c) => c.callId)), [yieldedTools])
  const isSelectedEventPendingYield = pendingToolCallForInput !== null

  const isDetailInputMode = detailVisible && detailMode === 'input' && isSelectedEventPendingYield
  const isPromptInputMode = showPrompt || showInputYield

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
    [
      pendingToolCallForInput,
      resume,
      setDetailMode,
      setDetailVisible,
      setSelectedIndex,
      preInputSelectionRef,
      selectedEventIdRef,
    ],
  )

  useAppInput({
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
  })

  // NOTE: Review setting height={terminalHeight} on this Box
  // When outputHeight >= stdout.rows, Ink calls clearTerminal on every render,
  // which may cause flickering.
  return (
    <Box flexDirection="column" height={terminalHeight} paddingX={LAYOUT.outerPadding}>
      {!detailVisible && (
        <ModeBar
          displayMode={displayMode}
          inputHint={modeBarInputHint({
            isDetailInputMode,
            displayMode,
            hasUnhandledYields,
            showInputYield,
            isPromptInputMode,
            browseMode,
          })}
        />
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
          key={detailPaneKey(detailEvent, detailMode, isSelectedEventPendingYield)}
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

      <KeyHints
        displayMode={displayMode}
        isDetailInputMode={isDetailInputMode}
        logDetailVisible={logDetailVisible}
        detailVisible={detailVisible}
        hasUnhandledYields={hasUnhandledYields}
        showInputYield={showInputYield}
        isPromptInputMode={isPromptInputMode}
        browseMode={browseMode}
      />
    </Box>
  )
}
