// @ts-ignore
import { Box, Text } from 'ink'
// @ts-ignore
import TextInput from 'ink-text-input'
import React, { useState } from 'react'

interface PromptInputProps {
  onSubmit: (value: string) => void
  placeholder?: string
  prefix?: string
  disabled?: boolean
}

export function PromptInput({
  onSubmit,
  placeholder = 'Enter your message...',
  prefix = '> ',
  disabled = false,
}: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('')

  const handleSubmit = (submittedValue: string) => {
    if (disabled) return
    const trimmed = submittedValue.trim()
    setValue('')
    onSubmit(trimmed)
  }

  if (disabled) {
    return (
      <Box>
        <Text dimColor>{prefix}</Text>
        <Text dimColor>{placeholder}</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Text color="greenBright">{prefix}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
      />
    </Box>
  )
}
