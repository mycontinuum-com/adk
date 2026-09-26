import type { InvocationBlock } from '../blocks'

import { INDENT_WIDTH } from '../constants'

export const RESET = '\x1b[0m'

export function getIndent(depth: number): string {
  return ' '.repeat(depth * INDENT_WIDTH)
}

export function findWrapPoint(textToWrap: string, width: number): number {
  if (textToWrap.length <= width) return textToWrap.length
  const lastSpace = textToWrap.lastIndexOf(' ', width)
  if (lastSpace > width * 0.4) return lastSpace
  return width
}

const OUTPUT_EVENT_TYPES = new Set([
  'thought',
  'thought_delta',
  'assistant',
  'assistant_delta',
  'delta_batch',
  'tool_call',
  'tool_result',
  'state_change',
])

export function countBlockEvents(block: InvocationBlock): number {
  let count = 0
  for (const ctx of block.contextBlocks) {
    for (const event of ctx.producedEvents) {
      if (!OUTPUT_EVENT_TYPES.has(event.type)) continue
      if (event.type === 'delta_batch') {
        count += (event as { count: number }).count
      } else {
        count++
      }
    }
  }
  for (const child of block.children) {
    count += countBlockEvents(child)
  }
  return count
}

export function isBlockActive(block: InvocationBlock): boolean {
  if (block.state === 'running' || block.state === 'yielded') {
    return true
  }
  for (const child of block.children) {
    if (isBlockActive(child)) {
      return true
    }
  }
  return false
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
