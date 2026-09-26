import { useMemo } from 'react'

import type { Runnable, ToolCallEvent, ToolYieldEvent } from '../../types'
import type { DisplayEvent } from '../blocks'
import type { TerminalStatus } from '../types'
import type { CLIEvent } from './useAgent'

import { extractYieldSchemas } from '../schema-input'

interface PendingYieldParams {
  runnable: Runnable<any>
  status: TerminalStatus
  events: CLIEvent[]
  yieldedTools: ToolYieldEvent[]
  selectableEvents: DisplayEvent[]
  selectedIndex: number
}

/** Resolves the yielded tool call awaiting input for the current selection. */
export function usePendingYield({
  runnable,
  status,
  events,
  yieldedTools,
  selectableEvents,
  selectedIndex,
}: PendingYieldParams) {
  const selectedEvent = selectableEvents[selectedIndex] ?? null
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

  return {
    selectedEvent,
    pendingToolCallForInput,
    selectedYieldSchema,
    detailEvent,
    firstPendingToolCall,
  }
}
