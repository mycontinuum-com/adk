import React from 'react';
// @ts-ignore
import { Box, Text } from 'ink';
import type { LogEntry } from '../hooks/useLogCapture';

interface LogDetailPaneProps {
  log: LogEntry;
  height: number;
  scrollOffset: number;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

function getLevelLabel(level: string): string {
  return level.toUpperCase();
}

function formatMessage(message: string): string[] {
  try {
    const jsonMatch = message.match(/^([^{]*?)(\{.+\})$/s);
    if (jsonMatch) {
      const prefix = jsonMatch[1].trim();
      const jsonStr = jsonMatch[2];
      const parsed = JSON.parse(jsonStr);
      const formatted = JSON.stringify(parsed, null, 2);
      if (prefix) {
        return [prefix, '', ...formatted.split('\n')];
      }
      return formatted.split('\n');
    }
  } catch {
    // Not JSON, return as-is
  }
  return message.split('\n');
}

export function LogDetailPane({
  log,
  height,
  scrollOffset,
}: LogDetailPaneProps): React.ReactElement {
  const contentHeight = height - 4;
  const messageLines = formatMessage(log.message);
  
  const allLines = [
    `Timestamp: ${formatTimestamp(log.timestamp)}`,
    `Level: ${getLevelLabel(log.level)}`,
    `ID: ${log.id}`,
    '',
    'Message:',
    ...messageLines,
  ];

  const totalLines = allLines.length;
  const maxOffset = Math.max(0, totalLines - contentHeight);
  const effectiveOffset = Math.min(scrollOffset, maxOffset);
  const visibleLines = allLines.slice(effectiveOffset, effectiveOffset + contentHeight);
  const hasMore = totalLines > contentHeight;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      height={height}
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">Log Details</Text>
        <Text dimColor> • scroll [↑↓] • close [Esc]</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {visibleLines.map((line, idx) => (
          <Text key={idx} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      {hasMore && (
        <Box>
          <Text dimColor>
            {effectiveOffset > 0 ? '↑ ' : '  '}
            Line {effectiveOffset + 1}-{Math.min(effectiveOffset + contentHeight, totalLines)} of {totalLines}
            {effectiveOffset + contentHeight < totalLines ? ' ↓' : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}
