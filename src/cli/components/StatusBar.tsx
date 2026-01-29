import React from 'react';
// @ts-ignore
import { Box, Text } from 'ink';
import type { CLIStatus } from '../types';
import { SyncedSpinner } from './SpinnerContext';

interface StatusBarProps {
  status: CLIStatus;
  iterations: number;
  startTime: number | null;
  endTime: number | null;
  error: string | null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function StatusBar({
  status,
  iterations,
  startTime,
  endTime,
  error,
}: StatusBarProps): React.ReactElement {
  const duration =
    startTime !== null
      ? endTime !== null
        ? endTime - startTime
        : Date.now() - startTime
      : null;

  return (
    <Box flexDirection="column">
      <Box>
        {status === 'running' && (
          <>
            <SyncedSpinner color="cyanBright" />
            <Text> Running</Text>
          </>
        )}
        {status === 'idle' && <Text dimColor>Idle</Text>}
        {status === 'completed' && <Text color="greenBright">✓ Completed</Text>}
        {status === 'yielded' && <Text color="yellowBright">⧗ Yielded - awaiting input</Text>}
        {status === 'error' && <Text color="redBright">✗ Error</Text>}

        {iterations > 0 && (
          <Text dimColor>
            {' '}
            • {iterations} iteration{iterations !== 1 ? 's' : ''}
          </Text>
        )}

        {duration !== null && (
          <Text dimColor> • {formatDuration(duration)}</Text>
        )}
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="redBright">Error: {error}</Text>
        </Box>
      )}
    </Box>
  );
}


