import type { PendingBracket, DisplayEvent } from './blocks'
import type { FlattenedLine } from './components/TraceView'

import { CLEAN_MODE_EVENT_TYPES } from './constants'
import { getSelectableTypes } from './event-display'

const SELECTABLE_TYPES = getSelectableTypes()
SELECTABLE_TYPES.add('pending_context_end')
SELECTABLE_TYPES.add('pending_block_end')

export function getSelectableEvents(events: DisplayEvent[]): DisplayEvent[] {
  return events.filter((e) => SELECTABLE_TYPES.has(e.type))
}

export function getEventId(event: DisplayEvent | null): string | undefined {
  if (!event) return undefined
  return (event as { id?: string }).id
}

interface PendingBracketLookupMaps {
  invocationEndByInvocationId: Map<string, number>
  modelStartById: Map<string, { invocationId: string; stepIndex: number; index: number }>
  modelEndByKey: Map<string, number>
}

export function buildPendingBracketLookupMaps(
  selectableEvents: DisplayEvent[],
): PendingBracketLookupMaps {
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

export function findRealEventForPendingBracket(
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

export function findFinalEventForDeltaBatch(
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

export function isLineVisibleInCleanMode(line: FlattenedLine): boolean {
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

export const LAYOUT = {
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

export const FIXED_UI_LINES = LAYOUT.topBarLines + LAYOUT.traceMarginBottom + LAYOUT.helpLines

export const PROMPT_INPUT_HEIGHT = LAYOUT.promptInputMarginTop + LAYOUT.promptInputLines
