import type { FlattenedLine } from './TraceView'

export interface TraceViewportInput {
  lines: FlattenedLine[]
  contentHeight: number | undefined
  clampedScrollOffset: number
  visualLineStarts: number[] | null
  visualLineHeights: number[] | null
  totalVisualLines: number
  contentMode: boolean
}

export interface TraceViewport {
  visibleLines: FlattenedLine[]
  linesAbove: number
  linesBelow: number
  renderedVisualLines: number
  partialLine: FlattenedLine | null
  partialLineMaxVisual: number
  partialLineIsTruncated: boolean
  topPartialSkipLines: number
}

export function computeTraceViewport({
  lines,
  contentHeight,
  clampedScrollOffset,
  visualLineStarts,
  visualLineHeights,
  totalVisualLines,
  contentMode,
}: TraceViewportInput): TraceViewport {
  if (contentHeight === undefined || lines.length === 0) {
    return {
      visibleLines: lines,
      linesAbove: 0,
      linesBelow: 0,
      renderedVisualLines: 0,
      partialLine: null,
      partialLineMaxVisual: 0,
      partialLineIsTruncated: false,
      topPartialSkipLines: 0,
    }
  }

  const viewportStart = clampedScrollOffset
  const isSimpleMode = !contentMode && !visualLineHeights

  let startIdx = 0
  let topSkip = 0

  if (isSimpleMode) {
    startIdx = Math.min(Math.floor(viewportStart), lines.length - 1)
    startIdx = Math.max(0, startIdx)
  } else {
    for (let i = 0; i < lines.length; i++) {
      const lineStart = visualLineStarts?.[i] ?? i
      const lineHeight = visualLineHeights?.[i] ?? 1
      const lineEnd = lineStart + lineHeight

      if (lineEnd <= viewportStart) {
        startIdx = i + 1
      } else if (lineStart < viewportStart) {
        startIdx = i
        topSkip = viewportStart - lineStart
        break
      } else {
        break
      }
    }
  }

  let endIdx = startIdx
  let usedHeight = 0

  if (isSimpleMode) {
    endIdx = Math.min(startIdx + contentHeight, lines.length)
    usedHeight = endIdx - startIdx
  } else {
    for (let i = startIdx; i < lines.length; i++) {
      const lineHeight = visualLineHeights?.[i] ?? 1
      const effectiveHeight = i === startIdx ? lineHeight - topSkip : lineHeight

      if (usedHeight + effectiveHeight <= contentHeight) {
        usedHeight += effectiveHeight
        endIdx = i + 1
      } else {
        break
      }
    }
  }

  const remainingSpace = contentHeight - usedHeight
  let partial: FlattenedLine | null = null
  let partialMax = 0
  let partialFullHeight = 0
  let partialIsTruncated = false

  if (contentMode && !isSimpleMode && endIdx < lines.length && remainingSpace >= 1) {
    partial = lines[endIdx]
    partialFullHeight = visualLineHeights?.[endIdx] ?? 1

    if (partialFullHeight <= remainingSpace) {
      partialMax = partialFullHeight
      partialIsTruncated = false
    } else if (remainingSpace >= 2) {
      partialMax = remainingSpace - 1
      partialIsTruncated = true
    } else {
      partial = null
    }
  }

  const above = clampedScrollOffset
  const partialRenderedHeight = partial ? (partialIsTruncated ? partialMax + 1 : partialMax) : 0
  const below = isSimpleMode
    ? totalVisualLines - endIdx
    : partial
      ? totalVisualLines - (visualLineStarts?.[endIdx] ?? endIdx) - partialRenderedHeight
      : endIdx < lines.length
        ? totalVisualLines - (visualLineStarts?.[endIdx] ?? endIdx)
        : 0

  return {
    visibleLines: lines.slice(startIdx, endIdx),
    linesAbove: above,
    linesBelow: Math.max(0, below),
    renderedVisualLines: usedHeight + partialRenderedHeight,
    partialLine: partial,
    partialLineMaxVisual: partialMax,
    partialLineIsTruncated: partialIsTruncated,
    topPartialSkipLines: topSkip,
  }
}
