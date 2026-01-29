import React, { useState } from 'react';
// @ts-ignore
import { Box, Text, useInput } from 'ink';
// @ts-ignore
import TextInput from 'ink-text-input';

interface PromptInputProps {
  onSubmit: (value: string) => void;
  placeholder?: string;
  prefix?: string;
  disabled?: boolean;
}

export function PromptInput({
  onSubmit,
  placeholder = 'Enter your message...',
  prefix = '> ',
  disabled = false,
}: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');

  const handleSubmit = (submittedValue: string) => {
    const trimmed = submittedValue.trim();
    if (trimmed && !disabled) {
      setValue('');
      onSubmit(trimmed);
    }
  };

  if (disabled) {
    return (
      <Box>
        <Text dimColor>{prefix}</Text>
        <Text dimColor>{placeholder}</Text>
      </Box>
    );
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
  );
}
