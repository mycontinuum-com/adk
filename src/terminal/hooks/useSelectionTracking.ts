import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'

import type { DisplayEvent, PendingBracket } from '../blocks'

import {
  buildPendingBracketLookupMaps,
  findFinalEventForDeltaBatch,
  findRealEventForPendingBracket,
  getEventId,
} from '../app-helpers'

type DeltaBatchSelection = {
  id: string
  deltaType: 'thought_delta' | 'assistant_delta'
}

/**
 * Records whether the selection sits on a pending bracket or delta batch, which later resolve into
 * other events the selection should follow.
 */
function rememberTransientSelection(
  currentEvent: DisplayEvent | undefined,
  wasOnPendingBracketRef: MutableRefObject<PendingBracket | null>,
  wasOnDeltaBatchRef: MutableRefObject<DeltaBatchSelection | null>,
): void {
  if (currentEvent?.type === 'pending_block_end' || currentEvent?.type === 'pending_context_end') {
    wasOnPendingBracketRef.current = currentEvent as PendingBracket
    wasOnDeltaBatchRef.current = null
  } else if (currentEvent?.type === 'delta_batch') {
    const batch = currentEvent as DeltaBatchSelection
    wasOnDeltaBatchRef.current = { id: batch.id, deltaType: batch.deltaType }
    wasOnPendingBracketRef.current = null
  } else {
    wasOnPendingBracketRef.current = null
    wasOnDeltaBatchRef.current = null
  }
}

/**
 * Owns the trace selection and keeps it on the same logical event as pending brackets and delta
 * batches resolve.
 */
export function useSelectionTracking(selectableEvents: DisplayEvent[]) {
  const [selectedIndex, setSelectedIndex] = useState<number>(0)
  const selectedEventIdRef = useRef<string | undefined>(undefined)
  const wasOnPendingBracketRef = useRef<PendingBracket | null>(null)
  const wasOnDeltaBatchRef = useRef<DeltaBatchSelection | null>(null)

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

    rememberTransientSelection(currentEvent, wasOnPendingBracketRef, wasOnDeltaBatchRef)
  }, [selectableEvents, selectedIndex, selectableEventIdToIndex, pendingBracketLookupMaps])

  return { selectedIndex, setSelectedIndex, selectedEventIdRef }
}
