import React, { useMemo } from 'react';
// @ts-ignore
import { Box, Text } from 'ink';
import type { LogEntry, LogLevel } from '../hooks/useLogCapture';

const RESET = '\x1b[0m';
const SELECTION_BG = 'grey';

interface LogViewProps {
  logs: LogEntry[];
  maxHeight: number;
  scrollOffset?: number;
  selectedIndex?: number;
}

function formatTimestamp(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

function getLevelColor(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'red';
    case 'warn':
      return 'yellow';
    case 'debug':
      return 'gray';
    case 'verbose':
      return 'gray';
    case 'info':
      return 'cyan';
    default:
      return 'white';
  }
}

function getLevelLabel(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'ERROR';
    case 'warn':
      return 'WARN';
    case 'debug':
      return 'DEBUG';
    case 'verbose':
      return 'TRACE';
    case 'info':
      return 'INFO';
    default:
      return 'LOG';
  }
}

export function LogView({ logs, maxHeight, scrollOffset = 0, selectedIndex }: LogViewProps): React.ReactElement {
  const contentHeight = maxHeight - 2;

  const { visibleLogs, linesAbove, linesBelow, startIdx } = useMemo(() => {
    if (logs.length === 0) {
      return { visibleLogs: [], linesAbove: 0, linesBelow: 0, startIdx: 0 };
    }

    const totalLines = logs.length;
    const maxOffset = Math.max(0, totalLines - contentHeight);
    const effectiveOffset = Math.min(scrollOffset, maxOffset);

    const start = effectiveOffset;
    const endIdx = Math.min(start + contentHeight, totalLines);
    const visible = logs.slice(start, endIdx);

    return {
      visibleLogs: visible,
      linesAbove: effectiveOffset,
      linesBelow: Math.max(0, totalLines - endIdx),
      startIdx: start,
    };
  }, [logs, contentHeight, scrollOffset]);

  const hasScrollableContent = logs.length > contentHeight;
  const showMoreAbove = hasScrollableContent && linesAbove > 0;
  const showMoreBelow = hasScrollableContent && linesBelow > 0;

  if (logs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No logs captured yet</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showMoreAbove && (
        <Text dimColor> ↑ {linesAbove} more above</Text>
      )}
      {visibleLogs.map((log, visibleIdx) => {
        const globalIdx = startIdx + visibleIdx;
        const isSelected = selectedIndex !== undefined && globalIdx === selectedIndex;
        const maxMsgLen = 200;
        const truncatedMsg = log.message.length > maxMsgLen 
          ? log.message.slice(0, maxMsgLen) + '...'
          : log.message;
        const bg = isSelected ? SELECTION_BG : undefined;
        return (
          <Box key={log.id}>
            <Text>{RESET}{isSelected ? '▸' : ' '}</Text>
            <Text> </Text>
            <Text dimColor={!isSelected} backgroundColor={bg} color={isSelected ? 'white' : undefined}>{formatTimestamp(log.timestamp)}</Text>
            <Text backgroundColor={bg}> </Text>
            <Text color={getLevelColor(log.level)} backgroundColor={bg}>{getLevelLabel(log.level).padEnd(5)}</Text>
            <Text> </Text>
            <Text color={log.level === 'error' ? 'red' : log.level === 'warn' ? 'yellow' : undefined}>
              {truncatedMsg}
            </Text>
          </Box>
        );
      })}
      {(() => {
        if (!hasScrollableContent) return null;
        const topLines = showMoreAbove ? 1 : 0;
        const bottomLines = showMoreBelow ? 1 : 0;
        const usedLines = topLines + visibleLogs.length + bottomLines;
        const paddingNeeded = maxHeight - usedLines;
        if (paddingNeeded <= 0) return null;
        return Array.from({ length: paddingNeeded }, (_, i) => (
          <Box key={`padding-${i}`}><Text> </Text></Box>
        ));
      })()}
      {showMoreBelow && (
        <Text dimColor> ↓ {linesBelow} more below</Text>
      )}
    </Box>
  );
}
