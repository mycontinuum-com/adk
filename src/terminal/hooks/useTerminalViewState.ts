import { useCallback, useRef, useState } from 'react'

import type { ContextMessageItem } from '../blocks'
import type { DetailViewMode } from '../event-display'
import type { DisplayMode } from '../types'

export function useTerminalViewState(defaultMode: DisplayMode) {
  const [detailVisible, setDetailVisible] = useState(false)
  const [detailMode, setDetailMode] = useState<DetailViewMode>('clean')
  const [detailScrollOffset, setDetailScrollOffset] = useState(0)
  const [_traceScrollOffset, setTraceScrollOffset] = useState(0)
  const [expandedContextIds, setExpandedContextIds] = useState<Set<string>>(new Set())
  const [resolvedMessages, setResolvedMessages] = useState<Map<string, ContextMessageItem[]>>(
    new Map(),
  )
  const [browseMode, setBrowseMode] = useState(false)
  const [displayMode, setDisplayMode] = useState<DisplayMode>(defaultMode)
  const [logScrollOffset, setLogScrollOffset] = useState(0)
  const [logSelectedIndex, setLogSelectedIndex] = useState(0)
  const [logDetailVisible, setLogDetailVisible] = useState(false)
  const [logDetailScrollOffset, setLogDetailScrollOffset] = useState(0)
  const detailMaxOffsetRef = useRef(0)
  const preInputSelectionRef = useRef<{ index: number; eventId: string | undefined } | null>(null)

  const handleMaxOffsetChange = useCallback((maxOffset: number) => {
    detailMaxOffsetRef.current = maxOffset
    setDetailScrollOffset((prev) => Math.min(prev, maxOffset))
  }, [])

  return {
    detailVisible,
    setDetailVisible,
    detailMode,
    setDetailMode,
    detailScrollOffset,
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
    logDetailScrollOffset,
    setLogDetailScrollOffset,
    detailMaxOffsetRef,
    preInputSelectionRef,
    handleMaxOffsetChange,
  }
}

export type TerminalViewState = ReturnType<typeof useTerminalViewState>
