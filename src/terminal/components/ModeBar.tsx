// @ts-ignore
import { Box, Text } from 'ink'
import React from 'react'

import type { DisplayMode } from '../types'

interface ModeBarProps {
  displayMode: DisplayMode
  inputHint: 'pending' | 'available' | null
}

export function ModeBar({ displayMode, inputHint }: ModeBarProps): React.ReactElement {
  return (
    <Box>
      <Text>
        <Text dimColor={displayMode !== 'debug'}>
          {displayMode === 'debug' ? '●' : '○'} debug [d]
        </Text>
        <Text dimColor> </Text>
        <Text dimColor={displayMode !== 'content'}>
          {displayMode === 'content' ? '●' : '○'} content [c]
        </Text>
        <Text dimColor> </Text>
        <Text dimColor={displayMode !== 'logging'}>
          {displayMode === 'logging' ? '●' : '○'} logs [l]
        </Text>
      </Text>
      {inputHint === 'pending' ? (
        <>
          <Text dimColor> • </Text>
          <Text color="yellowBright">input [i]</Text>
        </>
      ) : inputHint === 'available' ? (
        <Text dimColor> • input [i]</Text>
      ) : null}
    </Box>
  )
}
