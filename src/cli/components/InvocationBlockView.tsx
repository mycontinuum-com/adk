import React from 'react';
// @ts-ignore
import { Box, Text } from 'ink';
import type { InvocationBlock } from '../blocks';
import { EventLine } from './EventLine';

interface InvocationBlockViewProps {
  block: InvocationBlock;
  showDurations?: boolean;
  showIds?: boolean;
  selectedEventId?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getStatusColor(
  state: InvocationBlock['state'],
): 'greenBright' | 'yellowBright' | 'redBright' | 'cyanBright' | 'magentaBright' {
  switch (state) {
    case 'completed':
      return 'greenBright';
    case 'running':
      return 'cyanBright';
    case 'yielded':
      return 'yellowBright';
    case 'error':
      return 'redBright';
    default:
      return 'magentaBright';
  }
}

export function InvocationBlockView({
  block,
  showDurations = true,
  showIds = false,
  selectedEventId,
}: InvocationBlockViewProps): React.ReactElement {
  const statusColor = getStatusColor(block.state);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyanBright" dimColor={false}>┌─</Text>
        <Text color="cyanBright"> {block.agentName}</Text>
        {showIds && <Text color="gray" dimColor> ({block.invocationId})</Text>}
        {block.kind === 'agent' && <Text color="gray" dimColor> ◆ agent</Text>}
        {block.kind === 'step' && <Text color="gray" dimColor> ▸ step</Text>}
        {block.kind === 'sequence' && <Text color="gray" dimColor> → sequence</Text>}
        {block.kind === 'parallel' && <Text color="gray" dimColor> ║ parallel</Text>}
        {block.kind === 'loop' && <Text color="gray" dimColor> ○ loop</Text>}
        {block.handoffOrigin?.type === 'spawn' && <Text color="gray" dimColor>:spawn</Text>}
        {block.handoffOrigin?.type === 'dispatch' && <Text color="gray" dimColor>:dispatch</Text>}
        {block.handoffOrigin?.type === 'transfer' && <Text color="gray" dimColor>:transfer</Text>}
      </Text>

      <Box flexDirection="column" marginLeft={1} paddingLeft={1}>
        {block.events.map((event, idx) => {
          const eventId = (event as { id?: string }).id;
          const isSelected = selectedEventId !== undefined && eventId === selectedEventId;
          return (
            <EventLine
              key={`${event.type}-${idx}`}
              event={event}
              isSelected={isSelected}
            />
          );
        })}

        {block.children.map((child, idx) => (
          <Box key={child.invocationId} flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
            {block.kind === 'loop' && child.loopIteration !== undefined && (
              <Text dimColor>
                [{child.loopIteration}/{block.loopMax}]
              </Text>
            )}
            <InvocationBlockView
              block={child}
              showDurations={showDurations}
              showIds={showIds}
              selectedEventId={selectedEventId}
            />
          </Box>
        ))}
      </Box>

      <Text>
        <Text color="cyanBright" dimColor={false}>└─</Text>{' '}
        {block.state === 'yielded' ? (
          <>
            <Text color={statusColor}>[yield]</Text>
            {block.pendingCallIds?.length && (
              <Text dimColor> awaiting {block.pendingCallIds.join(', ')}</Text>
            )}
          </>
        ) : showDurations && block.duration !== undefined ? (
          <Text color={statusColor}>[{formatDuration(block.duration)}]</Text>
        ) : (
          <Text color={statusColor}>[{block.state}]</Text>
        )}
      </Text>
    </Box>
  );
}
