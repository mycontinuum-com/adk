import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

import type { DisplayEvent, InvocationBlock } from '../blocks'

import { isLineVisibleInCleanMode } from '../app-helpers'
import {
  buildEventIndexToLineMap,
  calculateCleanModeVisualLines,
  flattenBlocks,
  getLineIndexForEvent,
} from '../components/TraceView'

interface TraceLayoutParams {
  blocks: InvocationBlock[]
  selectableEvents: DisplayEvent[]
  expandedContextIds: Set<string>
  contentMode: boolean
  terminalWidth: number
  availableTraceHeight: number
  selectedIndex: number
}

export function useTraceLayout({
  blocks,
  selectableEvents,
  expandedContextIds,
  contentMode,
  terminalWidth,
  availableTraceHeight,
  selectedIndex,
}: TraceLayoutParams) {
  const currentScrollRef = useRef(0)

  const flattenedLines = useMemo(
    () => flattenBlocks(blocks, selectableEvents, expandedContextIds),
    [blocks, selectableEvents, expandedContextIds],
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

  const visualHeightCache = useMemo(() => new Map<string, number>(), [terminalWidth])

  const visualLineHeights = useMemo(() => {
    if (!contentMode) return visibleFlattenedLines.map(() => 1)

    return visibleFlattenedLines.map((line) => {
      const cacheKey = line.key
      const cached = visualHeightCache.get(cacheKey)
      if (cached !== undefined) return cached

      const height = calculateCleanModeVisualLines(line, terminalWidth)
      visualHeightCache.set(cacheKey, height)
      return height
    })
  }, [visibleFlattenedLines, contentMode, terminalWidth, visualHeightCache])

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
    eventIndexToLineMap,
    totalVisualLines,
    visualLineStarts,
    visualLineHeights,
    selectableEvents.length,
    contentMode,
    getContentHeight,
  ])

  useLayoutEffect(() => {
    currentScrollRef.current = adjustedScrollOffset
  }, [adjustedScrollOffset])

  return {
    currentScrollRef,
    flattenedLines,
    visibleFlattenedLines,
    flattenedEventIndexToLineMap,
    visualLineHeights,
    visualLineStarts,
    totalVisualLines,
    getContentHeight,
    adjustedScrollOffset,
  }
}
