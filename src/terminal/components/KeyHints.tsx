// @ts-ignore
import { Box, Text } from 'ink'
import React from 'react'

import type { DisplayMode } from '../types'

interface KeyHintsProps {
  displayMode: DisplayMode
  isDetailInputMode: boolean
  logDetailVisible: boolean
  detailVisible: boolean
  hasUnhandledYields: boolean
  showInputYield: boolean
  isPromptInputMode: boolean
  browseMode: boolean
}

function keyHintText({
  displayMode,
  isDetailInputMode,
  logDetailVisible,
  detailVisible,
  hasUnhandledYields,
  showInputYield,
  isPromptInputMode,
  browseMode,
}: KeyHintsProps): string {
  if (isDetailInputMode)
    return '[↑↓] field • [←→] value • submit [Enter] • cancel [Esc] • exit [Ctrl+C]'
  if (displayMode === 'logging' && logDetailVisible) return 'close [Esc] • exit [Ctrl+C]'
  if (displayMode === 'logging') return 'scroll [↑↓] • page [←→] • open [Enter] • exit [Ctrl+C]'
  if (detailVisible) return 'raw [r] • close [Esc]'
  if (displayMode === 'content' && (hasUnhandledYields || showInputYield))
    return 'close [Esc] • exit [Ctrl+C]'
  if (displayMode === 'content') return 'scroll [↑↓] • exit [Ctrl+C]'
  if ((showInputYield || isPromptInputMode) && browseMode)
    return 'scroll [↑↓] • jump [←→] • open [Enter] • exit [Ctrl+C]'
  if (isPromptInputMode) return 'browse [Esc] • exit [Ctrl+C]'
  if (hasUnhandledYields) return 'scroll [↑↓] • jump [←→] • open [Enter] • exit [Ctrl+C]'
  return 'scroll [↑↓] • jump [←→] • open [Enter] • close [Esc] • exit [Ctrl+C]'
}

export function KeyHints(props: KeyHintsProps): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{keyHintText(props)}</Text>
    </Box>
  )
}
