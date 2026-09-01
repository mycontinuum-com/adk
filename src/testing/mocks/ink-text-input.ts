/** Vitest mock for 'ink-text-input' (ESM-only since v5). */
import React from 'react'

const TextInput = (props: {
  value?: string
  onChange?: (v: string) => void
  placeholder?: string
}) => React.createElement('ink-text-input', null, props.value ?? '')

export default TextInput
