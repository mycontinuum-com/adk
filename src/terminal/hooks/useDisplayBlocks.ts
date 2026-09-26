import { useEffect, useMemo, useState } from 'react'

import type { ContextMessageItem, DisplayEvent, InvocationBlock } from '../blocks'
import type { CLIEvent } from './useAgent'

import { isPriceable, loadPricing, type PricingCatalog } from '../../providers/pricing'
import { getSelectableEvents } from '../app-helpers'
import { buildInvocationBlocks, getEventsInDisplayOrder, getPendingBrackets } from '../blocks'

/** Builds priced invocation blocks with resolved context messages and their selectable events. */
export function useDisplayBlocks(
  events: CLIEvent[],
  resolvedMessages: Map<string, ContextMessageItem[]>,
  expandedContextIds: Set<string>,
): { enrichedBlocks: InvocationBlock[]; selectableEvents: DisplayEvent[] } {
  const [pricing, setPricing] = useState<PricingCatalog>()
  useEffect(() => {
    if (events.some((e) => e.type === 'model_end' && isPriceable(e.usage))) {
      void loadPricing().then(setPricing)
    }
  }, [events])

  const blocks = useMemo(() => buildInvocationBlocks(events, pricing), [events, pricing])

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

  return { enrichedBlocks, selectableEvents }
}
