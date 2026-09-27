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

/** First line intersecting the viewport, and how many of its visual lines sit above it. */
function findVariableHeightStart(
  lineCount: number,
  viewportStart: number,
  visualLineStarts: number[] | null,
  visualLineHeights: number[] | null,
): { startIdx: number; topSkip: number } {
  let startIdx = 0
  for (let i = 0; i < lineCount; i++) {
    const lineStart = visualLineStarts?.[i] ?? i
    const lineHeight = visualLineHeights?.[i] ?? 1
    const lineEnd = lineStart + lineHeight

    if (lineEnd <= viewportStart) {
      startIdx = i + 1
    } else if (lineStart < viewportStart) {
      return { startIdx: i, topSkip: viewportStart - lineStart }
    } else {
      break
    }
  }
  return { startIdx, topSkip: 0 }
}

/** Whole lines that fit from `startIdx`, and the visual height they use. */
function fillVariableHeightLines(
  lineCount: number,
  startIdx: number,
  topSkip: number,
  contentHeight: number,
  visualLineHeights: number[] | null,
): { endIdx: number; usedHeight: number } {
  let endIdx = startIdx
  let usedHeight = 0
  for (let i = startIdx; i < lineCount; i++) {
    const lineHeight = visualLineHeights?.[i] ?? 1
    const effectiveHeight = i === startIdx ? lineHeight - topSkip : lineHeight

    if (usedHeight + effectiveHeight <= contentHeight) {
      usedHeight += effectiveHeight
      endIdx = i + 1
    } else {
      break
    }
  }
  return { endIdx, usedHeight }
}

interface PartialLine {
  partial: FlattenedLine | null
  partialMax: number
  partialIsTruncated: boolean
}

/** The next line shown partially in the remaining space, truncated when it does not fit. */
function partialLineAt(
  lines: FlattenedLine[],
  endIdx: number,
  remainingSpace: number,
  visualLineHeights: number[] | null,
): PartialLine {
  const partialFullHeight = visualLineHeights?.[endIdx] ?? 1

  if (partialFullHeight <= remainingSpace) {
    return { partial: lines[endIdx], partialMax: partialFullHeight, partialIsTruncated: false }
  }
  if (remainingSpace >= 2) {
    return { partial: lines[endIdx], partialMax: remainingSpace - 1, partialIsTruncated: true }
  }
  return { partial: null, partialMax: 0, partialIsTruncated: false }
}

function variableHeightLinesBelow(
  lineCount: number,
  endIdx: number,
  hasPartial: boolean,
  partialRenderedHeight: number,
  totalVisualLines: number,
  visualLineStarts: number[] | null,
): number {
  if (hasPartial) {
    return totalVisualLines - (visualLineStarts?.[endIdx] ?? endIdx) - partialRenderedHeight
  }
  return endIdx < lineCount ? totalVisualLines - (visualLineStarts?.[endIdx] ?? endIdx) : 0
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
    ;({ startIdx, topSkip } = findVariableHeightStart(
      lines.length,
      viewportStart,
      visualLineStarts,
      visualLineHeights,
    ))
  }

  let endIdx = startIdx
  let usedHeight = 0

  if (isSimpleMode) {
    endIdx = Math.min(startIdx + contentHeight, lines.length)
    usedHeight = endIdx - startIdx
  } else {
    ;({ endIdx, usedHeight } = fillVariableHeightLines(
      lines.length,
      startIdx,
      topSkip,
      contentHeight,
      visualLineHeights,
    ))
  }

  const remainingSpace = contentHeight - usedHeight
  let partialLine: PartialLine = { partial: null, partialMax: 0, partialIsTruncated: false }

  if (contentMode && !isSimpleMode && endIdx < lines.length && remainingSpace >= 1) {
    partialLine = partialLineAt(lines, endIdx, remainingSpace, visualLineHeights)
  }
  const { partial, partialMax, partialIsTruncated } = partialLine

  const above = clampedScrollOffset
  const partialRenderedHeight = partial ? (partialIsTruncated ? partialMax + 1 : partialMax) : 0
  const below = isSimpleMode
    ? totalVisualLines - endIdx
    : variableHeightLinesBelow(
        lines.length,
        endIdx,
        partial !== null,
        partialRenderedHeight,
        totalVisualLines,
        visualLineStarts,
      )

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
