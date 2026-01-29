import type {
  EventType,
  SystemEvent,
  UserEvent,
  AssistantEvent,
  ThoughtEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolYieldEvent,
  ToolInputEvent,
  StateChangeEvent,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationYieldEvent,
  InvocationResumeEvent,
  ModelStartEvent,
  ModelEndEvent,
} from '../types';
import type {
  DeltaBatchEvent,
  DisplayEvent,
  ContextMessageItem,
  ContextToolItem,
  ContextSchemaItem,
  StreamingMetadata,
} from './blocks';

export type EventColor =
  | 'gray'
  | 'white'
  | 'blueBright'
  | 'greenBright'
  | 'cyanBright'
  | 'yellowBright'
  | 'magentaBright'
  | 'redBright';

export interface EventDisplayConfig {
  label: string;
  color: EventColor;
  selectable: boolean;
  dimmed?: boolean;
  hidden?: boolean;
}

export { LABEL_WIDTH } from './constants';

export function truncate(text: string, maxLength?: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (maxLength === undefined || singleLine.length <= maxLength)
    return singleLine;
  return singleLine.slice(0, maxLength - 3) + '...';
}

function getThoughtFallback(event: ThoughtEvent): string | null {
  const data = event.providerContext?.data as
    | Record<string, unknown>
    | undefined;
  if (data?.encrypted_content) return '(encrypted)';
  if (data?.thoughtSignature)
    return `(sig: ${truncate(String(data.thoughtSignature), 12)})`;
  return null;
}

const THOUGHT_BLOCK_HEADER_PATTERN = /\*\*[A-Z][^*]+\*\*/g;

export function extractCurrentThoughtBlock(text: string): string {
  const matches = [...text.matchAll(THOUGHT_BLOCK_HEADER_PATTERN)];

  if (matches.length === 0) {
    const incompleteMatch = text.match(/\*\*[A-Z][^*]*$/);
    if (incompleteMatch?.index !== undefined) {
      return text.slice(incompleteMatch.index);
    }
    return text;
  }

  const lastMatch = matches[matches.length - 1];
  if (lastMatch.index !== undefined) {
    return text.slice(lastMatch.index);
  }

  return text;
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && Object.keys(value as object).length === 0)
    return '';
  return JSON.stringify(value);
}

type DisplayEventType =
  | EventType
  | 'delta_batch'
  | 'context_message'
  | 'context_tool'
  | 'context_schema';

const EVENT_CONFIGS: Record<DisplayEventType, EventDisplayConfig> = {
  system: { label: 'system', color: 'white', selectable: true, dimmed: true },
  user: { label: 'user', color: 'blueBright', selectable: true },
  assistant: { label: 'output', color: 'greenBright', selectable: true },
  assistant_delta: {
    label: 'output',
    color: 'greenBright',
    selectable: false,
    hidden: true,
  },
  thought: { label: 'think', color: 'white', selectable: true, dimmed: true },
  thought_delta: {
    label: 'think',
    color: 'white',
    selectable: false,
    hidden: true,
  },
  tool_call: {
    label: 'call',
    color: 'cyanBright',
    selectable: true,
    dimmed: true,
  },
  tool_yield: {
    label: 'yield',
    color: 'yellowBright',
    selectable: true,
    dimmed: true,
  },
  tool_input: {
    label: 'input',
    color: 'yellowBright',
    selectable: true,
    dimmed: true,
  },
  tool_result: { label: 'result', color: 'cyanBright', selectable: true },
  state_change: {
    label: 'state',
    color: 'magentaBright',
    selectable: true,
    dimmed: true,
  },
  invocation_start: {
    label: 'start',
    color: 'cyanBright',
    selectable: true,
    hidden: true,
  },
  invocation_end: {
    label: 'end',
    color: 'greenBright',
    selectable: true,
    hidden: true,
  },
  invocation_yield: {
    label: 'yield',
    color: 'yellowBright',
    selectable: true,
    dimmed: true,
  },
  invocation_resume: {
    label: 'resume',
    color: 'yellowBright',
    selectable: true,
    dimmed: true,
  },
  delta_batch: {
    label: 'streaming',
    color: 'greenBright',
    selectable: true,
    dimmed: true,
  },
  model_start: {
    label: 'context',
    color: 'magentaBright',
    selectable: true,
    hidden: true,
  },
  model_end: {
    label: 'response',
    color: 'greenBright',
    selectable: true,
    hidden: true,
  },
  context_message: {
    label: 'message',
    color: 'white',
    selectable: true,
    dimmed: true,
  },
  context_tool: {
    label: 'tool',
    color: 'cyanBright',
    selectable: true,
    dimmed: true,
  },
  context_schema: {
    label: 'schema',
    color: 'yellowBright',
    selectable: true,
    dimmed: true,
  },
};

export function getEventConfig(event: DisplayEvent): EventDisplayConfig {
  return (
    EVENT_CONFIGS[event.type as DisplayEventType] ?? {
      label: event.type,
      color: 'white',
      selectable: false,
    }
  );
}

export function getSelectableTypes(): Set<string> {
  return new Set(
    Object.entries(EVENT_CONFIGS)
      .filter(([, config]) => config.selectable)
      .map(([type]) => type),
  );
}

export function isHiddenEvent(event: DisplayEvent): boolean {
  return EVENT_CONFIGS[event.type as DisplayEventType]?.hidden === true;
}

export interface EventSummary {
  label: string;
  labelSuffix?: string;
  color: EventColor;
  text?: string;
  textColor?: EventColor;
  dimmed?: boolean;
}

export function getEventSummary(event: DisplayEvent): EventSummary {
  const config = getEventConfig(event);

  switch (event.type) {
    case 'system': {
      const e = event as SystemEvent;
      return { ...config, text: truncate(e.text) };
    }
    case 'user': {
      const e = event as UserEvent;
      return { ...config, text: truncate(e.text) };
    }
    case 'thought': {
      const e = event as ThoughtEvent;
      const fallback = !e.text ? getThoughtFallback(e) : null;
      if (fallback)
        return { ...config, text: truncate(fallback), textColor: 'gray' };
      return { ...config, text: e.text ? truncate(e.text) : undefined };
    }
    case 'assistant': {
      const e = event as AssistantEvent;
      return { ...config, text: truncate(e.text) };
    }
    case 'delta_batch': {
      const e = event as DeltaBatchEvent;
      const isThought = e.deltaType === 'thought_delta';
      const displayText = isThought
        ? extractCurrentThoughtBlock(e.finalText)
        : e.finalText;
      return {
        label: isThought ? 'think' : 'output',
        color: isThought ? 'gray' : 'greenBright',
        dimmed: true,
        text: truncate(displayText),
      };
    }
    case 'tool_call': {
      const e = event as ToolCallEvent;
      const argsStr = formatJson(e.args);
      return {
        ...config,
        color: e.yields ? 'yellowBright' : config.color,
        text: argsStr ? `${e.name} ${truncate(argsStr)}` : e.name,
      };
    }
    case 'tool_result': {
      const e = event as ToolResultEvent;
      if (e.error) {
        return {
          ...config,
          color: 'redBright',
          text: `${e.name} error: ${truncate(e.error)}`,
        };
      }
      const resultStr =
        e.result === undefined
          ? 'void'
          : formatJson(e.result) || String(e.result);
      return {
        ...config,
        text: `${e.name} ${truncate(resultStr)}`,
        dimmed: true,
      };
    }
    case 'tool_yield': {
      const e = event as ToolYieldEvent;
      return { ...config, text: e.name };
    }
    case 'tool_input': {
      const e = event as ToolInputEvent;
      const inputStr = formatJson(e.input);
      return {
        ...config,
        text: inputStr ? `${e.name} ${truncate(inputStr)}` : e.name,
      };
    }
    case 'state_change': {
      const e = event as StateChangeEvent;
      const keys = e.changes.map((c) => `${e.scope}.${c.key}`).join(', ');
      return { ...config, text: truncate(keys) };
    }
    case 'invocation_start': {
      const e = event as InvocationStartEvent;
      return { ...config, text: e.agentName };
    }
    case 'invocation_end': {
      const e = event as InvocationEndEvent;
      const color: EventColor =
        e.reason === 'completed'
          ? 'greenBright'
          : e.reason === 'error'
            ? 'redBright'
            : 'yellowBright';
      const iterStr =
        e.iterations !== undefined ? ` (${e.iterations} steps)` : '';
      return {
        ...config,
        label: `end:${e.reason}`,
        color,
        text: `${e.agentName}${iterStr}`,
      };
    }
    case 'invocation_yield': {
      const e = event as InvocationYieldEvent;
      const count = e.pendingCallIds.length;
      const text =
        count > 0
          ? `awaiting ${count} ${count === 1 ? 'call' : 'calls'}`
          : 'awaiting input';
      return { ...config, text };
    }
    case 'invocation_resume': {
      return { ...config, text: '' };
    }
    case 'model_start': {
      const e = event as ModelStartEvent;
      return {
        ...config,
        text: `${e.messages.length} msgs • ${e.tools.length} tools`,
      };
    }
    case 'model_end': {
      const e = event as ModelEndEvent;
      if (e.error) {
        return {
          ...config,
          color: 'redBright',
          text: `error: ${truncate(e.error)}`,
        };
      }
      const parts: string[] = [];
      if (e.usage) {
        parts.push(`${e.usage.inputTokens}→${e.usage.outputTokens} tokens`);
      }
      parts.push(`${e.durationMs}ms`);
      return {
        ...config,
        text: parts.join(' • '),
      };
    }
    case 'context_message': {
      const e = event as ContextMessageItem;
      const roleColors: Record<string, EventColor> = {
        system: 'white',
        user: 'blueBright',
        assistant: 'greenBright',
        thought: 'white',
        tool_call: 'cyanBright',
        tool_result: 'cyanBright',
      };
      const roleLabels: Record<string, string> = {
        tool_call: 'call',
        tool_result: 'result',
        assistant: 'output',
        thought: 'think',
      };
      const isEmptyThought = e.message.role === 'thought' && !e.message.content;
      return {
        ...config,
        label: roleLabels[e.message.role] ?? e.message.role,
        color: roleColors[e.message.role] ?? 'white',
        text: isEmptyThought ? '(encrypted)' : e.message.content,
        textColor: isEmptyThought ? 'gray' : undefined,
        dimmed: true,
      };
    }
    case 'context_tool': {
      const e = event as ContextToolItem;
      return {
        ...config,
        text: `${e.tool.name}: ${e.tool.description}`,
      };
    }
    case 'context_schema': {
      const e = event as ContextSchemaItem;
      return {
        ...config,
        text: e.schemaName,
      };
    }
    default:
      return { ...config, text: (event as { type: string }).type };
  }
}

export type DetailViewMode = 'clean' | 'raw' | 'input';

function getRawEventData(event: DisplayEvent): unknown {
  switch (event.type) {
    case 'delta_batch': {
      const e = event as DeltaBatchEvent;
      return e.events;
    }
    case 'context_message': {
      const e = event as ContextMessageItem;
      return e.message;
    }
    case 'context_tool': {
      const e = event as ContextToolItem;
      return e.tool;
    }
    case 'context_schema': {
      const e = event as ContextSchemaItem;
      return { schemaName: e.schemaName };
    }
    default:
      return event;
  }
}

export function getEventDetail(
  event: DisplayEvent,
  mode: DetailViewMode = 'clean',
  streaming?: StreamingMetadata,
): string {
  if (mode === 'raw') {
    const rawData = getRawEventData(event);
    if (event.type === 'delta_batch') {
      const events = rawData as DeltaBatchEvent['events'];
      return events
        .map(
          (delta, idx) =>
            `--- Delta ${idx + 1}/${events.length} ---\n${JSON.stringify(delta, null, 2)}`,
        )
        .join('\n\n');
    }
    const eventJson = JSON.stringify(rawData, null, 2);
    if (streaming) {
      const deltasJson = JSON.stringify(streaming.deltaEvents, null, 2);
      return `${eventJson}\n\n---\n\n${deltasJson}`;
    }
    return eventJson;
  }

  switch (event.type) {
    case 'system':
      return (event as SystemEvent).text;
    case 'user':
      return (event as UserEvent).text;
    case 'thought': {
      const e = event as ThoughtEvent;
      const streamHeader = streaming
        ? `[Streamed in ${streaming.chunkCount} chunks]\n\n`
        : '';
      const displayText = e.text || getThoughtFallback(e) || '(no content)';
      return streamHeader + displayText;
    }
    case 'assistant': {
      const e = event as AssistantEvent;
      const streamHeader = streaming
        ? `[Streamed in ${streaming.chunkCount} chunks]\n\n`
        : '';
      try {
        const parsed = JSON.parse(e.text);
        return streamHeader + JSON.stringify(parsed, null, 2);
      } catch {
        return streamHeader + e.text;
      }
    }
    case 'tool_call': {
      const e = event as ToolCallEvent;
      return `${e.name}(${JSON.stringify(e.args, null, 2)})`;
    }
    case 'tool_result': {
      const e = event as ToolResultEvent;
      if (e.error) {
        return `${e.name} error: ${e.error}`;
      }
      const meta: string[] = [];
      if (e.durationMs !== undefined) meta.push(`${e.durationMs}ms`);
      if (e.retryCount) meta.push(`${e.retryCount} retries`);
      if (e.timedOut) meta.push('timed out');
      const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : '';
      const resultStr =
        typeof e.result === 'string'
          ? e.result
          : JSON.stringify(e.result, null, 2);
      return `${e.name}${metaStr} →\n${resultStr}`;
    }
    case 'tool_yield': {
      const e = event as ToolYieldEvent;
      return `${e.name} yielded\npreparedArgs: ${JSON.stringify(e.preparedArgs, null, 2)}`;
    }
    case 'tool_input': {
      const e = event as ToolInputEvent;
      return `input: ${JSON.stringify(e.input, null, 2)}`;
    }
    case 'state_change': {
      const e = event as StateChangeEvent;
      const changes = e.changes.map((c) => {
        const old = JSON.stringify(c.oldValue);
        const val = JSON.stringify(c.newValue);
        return `${c.key}: ${old} → ${val}`;
      });
      return `${e.scope} (${e.source})\n${changes.join('\n')}`;
    }
    case 'invocation_start': {
      const e = event as InvocationStartEvent;
      const parent = e.parentInvocationId
        ? `\nparent: ${e.parentInvocationId}`
        : '';
      return `${e.agentName}\nid: ${e.invocationId}${parent}`;
    }
    case 'invocation_end': {
      const e = event as InvocationEndEvent;
      const meta: string[] = [e.reason];
      if (e.iterations !== undefined) meta.push(`${e.iterations} steps`);
      const error = e.error ? `\n${e.error}` : '';
      return `${e.agentName} (${meta.join(', ')})${error}`;
    }
    case 'invocation_yield': {
      const e = event as InvocationYieldEvent;
      return `${e.agentName} yielded\nawaiting: ${e.pendingCallIds.join(', ')}`;
    }
    case 'invocation_resume': {
      const e = event as InvocationResumeEvent;
      return `${e.agentName} resumed`;
    }
    case 'delta_batch': {
      const e = event as DeltaBatchEvent;
      if (e.deltaType === 'thought_delta') {
        return extractCurrentThoughtBlock(e.finalText);
      }
      return e.finalText;
    }
    case 'model_start': {
      const e = event as ModelStartEvent;
      const lines: string[] = [];
      lines.push(
        `step ${e.stepIndex} • ${e.messages.length} msgs • ${e.tools.length} tools`,
      );
      if (e.outputSchema) lines.push(`schema: ${e.outputSchema}`);
      lines.push('');
      for (const msg of e.messages) {
        lines.push(`[${msg.role}] ${msg.content}`);
      }
      if (e.tools.length > 0) {
        lines.push('');
        for (const tool of e.tools) {
          lines.push(`${tool.name}: ${tool.description}`);
        }
      }
      return lines.join('\n');
    }
    case 'model_end': {
      const e = event as ModelEndEvent;
      const parts: string[] = [`${e.durationMs}ms`];
      if (e.usage) {
        parts.push(`${e.usage.inputTokens}→${e.usage.outputTokens} tokens`);
        if (e.usage.cachedTokens) parts.push(`${e.usage.cachedTokens} cached`);
        if (e.usage.reasoningTokens)
          parts.push(`${e.usage.reasoningTokens} reasoning`);
      }
      if (e.finishReason && e.finishReason !== 'stop')
        parts.push(e.finishReason);
      if (e.error) parts.push(`error: ${e.error}`);
      return `step ${e.stepIndex} • ${parts.join(' • ')}`;
    }
    case 'context_message': {
      const e = event as ContextMessageItem;
      return e.message.content;
    }
    case 'context_tool': {
      const e = event as ContextToolItem;
      return `${e.tool.name}\n${e.tool.description}`;
    }
    case 'context_schema': {
      const e = event as ContextSchemaItem;
      return e.schemaName;
    }
    default:
      return JSON.stringify(event, null, 2);
  }
}
