import React, { useState, useMemo } from 'react';
// @ts-ignore
import { Box, Text, useInput, useStdout } from 'ink';
// @ts-ignore
import TextInput from 'ink-text-input';
import type { ToolCallEvent } from '../../types';

const MAX_ARGS_LINES = 10;

interface YieldHandlerProps {
  pendingCalls: ToolCallEvent[];
  onResume: (responses: Map<string, unknown>) => void;
}

function formatArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2);
}

function wrapText(text: string, width: number): string[] {
  const result: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= width) {
      result.push(line);
    } else {
      result.push(line.slice(0, width));
    }
  }
  return result;
}

export function YieldHandler({
  pendingCalls,
  onResume,
}: YieldHandlerProps): React.ReactElement {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const contentWidth = terminalWidth - 6;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [responses, setResponses] = useState<Map<string, string>>(new Map());
  const [inputValue, setInputValue] = useState('');
  const [argsScrollOffset, setArgsScrollOffset] = useState(0);

  const currentCall = pendingCalls[currentIndex];

  const argsText = useMemo(() => formatArgs(currentCall.args), [currentCall.args]);
  const wrappedArgsLines = useMemo(
    () => wrapText(argsText, contentWidth),
    [argsText, contentWidth],
  );
  const totalArgsLines = wrappedArgsLines.length;
  const hasArgsScroll = totalArgsLines > MAX_ARGS_LINES;
  const maxArgsOffset = Math.max(0, totalArgsLines - MAX_ARGS_LINES);
  const effectiveArgsOffset = Math.min(argsScrollOffset, maxArgsOffset);
  const hasMoreBelow = effectiveArgsOffset < maxArgsOffset;

  const visibleArgsLines = useMemo(() => {
    const start = effectiveArgsOffset;
    const end = start + MAX_ARGS_LINES;
    const lines = wrappedArgsLines.slice(start, end);
    if (hasMoreBelow && lines.length > 0) {
      const lastIdx = lines.length - 1;
      const lastLine = lines[lastIdx];
      lines[lastIdx] = lastLine.slice(0, -3) + '...';
    }
    return lines;
  }, [wrappedArgsLines, effectiveArgsOffset, hasMoreBelow]);

  const handleSubmit = (value: string) => {
    const newResponses = new Map(responses);
    newResponses.set(currentCall.callId, value);
    setResponses(newResponses);
    setInputValue('');
    setArgsScrollOffset(0);

    if (currentIndex < pendingCalls.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      const parsedResponses = new Map<string, unknown>();
      for (const [callId, response] of newResponses) {
        try {
          parsedResponses.set(callId, JSON.parse(response));
        } catch {
          parsedResponses.set(callId, response);
        }
      }
      onResume(parsedResponses);
    }
  };

  useInput((input, key) => {
    if (key.upArrow) {
      setArgsScrollOffset((prev) => Math.max(0, prev - 1));
    }
    if (key.downArrow) {
      setArgsScrollOffset((prev) => Math.min(maxArgsOffset, prev + 1));
    }
  });

  const argsScrollPercent = maxArgsOffset > 0
    ? Math.round((effectiveArgsOffset / maxArgsOffset) * 100)
    : 0;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="yellowBright">
      <Text bold color="yellowBright">
        ⧗ Yield - Awaiting Input ({currentIndex + 1}/{pendingCalls.length})
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Tool:</Text> <Text color="cyanBright">{currentCall.name}</Text>
        </Text>
        <Text>
          <Text bold>Call ID:</Text> <Text dimColor>{currentCall.callId}</Text>
        </Text>
        {Object.keys(currentCall.args).length > 0 && (
          <Box flexDirection="column">
            <Box>
              <Text bold>Arguments:</Text>
              {hasArgsScroll && (
                <Text dimColor>
                  {' '}({effectiveArgsOffset > 0 ? `${argsScrollPercent}%` : 'scroll [↑↓]'})
                </Text>
              )}
            </Box>
            <Box flexDirection="column">
              {visibleArgsLines.map((line, idx) => (
                <Text key={idx} dimColor>{line}</Text>
              ))}
            </Box>
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>Enter result (JSON or string):</Text>
        <Box>
          <Text color="greenBright">→ </Text>
          <TextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            placeholder="Enter response..."
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>submit [Enter] • cancel [Esc] • scroll [↑↓]</Text>
      </Box>
    </Box>
  );
}
