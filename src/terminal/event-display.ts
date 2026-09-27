import type { EventType, ThoughtEvent } from '../types'
import type { DeltaBatchEvent, DisplayEvent, StreamingMetadata } from './blocks'

export type EventColor =
  | 'gray'
  | 'white'
  | 'blueBright'
  | 'greenBright'
  | 'cyanBright'
  | 'yellowBright'
  | 'magentaBright'
  | 'redBright'

export interface EventDisplayConfig {
  label: string
  color: EventColor
  selectable: boolean
  dimmed?: boolean
  hidden?: boolean
}

export function truncate(text: string, maxLength?: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (maxLength === undefined || singleLine.length <= maxLength) return singleLine
  return singleLine.slice(0, maxLength - 3) + '...'
}

function getThoughtFallback(event: ThoughtEvent): string | null {
  const data = event.providerContext?.data as Record<string, unknown> | undefined
  if (data?.encrypted_content) return '(encrypted)'
  if (data?.thoughtSignature) return `(sig: ${truncate(String(data.thoughtSignature), 12)})`
  return null
}

const THOUGHT_BLOCK_HEADER_PATTERN = /\*\*[A-Z][^*]+\*\*/g

export function extractCurrentThoughtBlock(text: string): string {
  const matches = [...text.matchAll(THOUGHT_BLOCK_HEADER_PATTERN)]

  if (matches.length === 0) {
    const incompleteMatch = text.match(/\*\*[A-Z][^*]*$/)
    if (incompleteMatch?.index !== undefined) {
      return text.slice(incompleteMatch.index)
    }
    return text
  }

  const lastMatch = matches[matches.length - 1]
  if (lastMatch.index !== undefined) {
    return text.slice(lastMatch.index)
  }

  return text
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return ''
  return JSON.stringify(value)
}

type DisplayEventType =
  | EventType
  | 'delta_batch'
  | 'context_message'
  | 'context_tool'
  | 'context_schema'

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
  artifact_update: {
    label: 'artifact',
    color: 'magentaBright',
    selectable: true,
    dimmed: false,
  },
  annotation: {
    label: 'note',
    color: 'white',
    selectable: true,
    dimmed: true,
  },
}

export function getEventConfig(event: DisplayEvent): EventDisplayConfig {
  return (
    EVENT_CONFIGS[event.type as DisplayEventType] ?? {
      label: event.type,
      color: 'white',
      selectable: false,
    }
  )
}

export function getSelectableTypes(): Set<string> {
  const types = new Set<string>()
  for (const [type, config] of Object.entries(EVENT_CONFIGS)) if (config.selectable) types.add(type)
  return types
}

export function isHiddenEvent(event: DisplayEvent): boolean {
  return EVENT_CONFIGS[event.type as DisplayEventType]?.hidden === true
}

export interface EventSummary {
  label: string
  labelSuffix?: string
  color: EventColor
  text?: string
  textColor?: EventColor
  dimmed?: boolean
}

type EventOfType<T extends DisplayEvent['type']> = Extract<DisplayEvent, { type: T }>

function thoughtSummary(event: EventOfType<'thought'>, config: EventDisplayConfig): EventSummary {
  const fallback = !event.text ? getThoughtFallback(event) : null
  if (fallback) return { ...config, text: truncate(fallback), textColor: 'gray' }
  return { ...config, text: event.text ? truncate(event.text) : undefined }
}

function deltaBatchSummary(e: DeltaBatchEvent): EventSummary {
  const isThought = e.deltaType === 'thought_delta'
  const displayText = isThought ? extractCurrentThoughtBlock(e.finalText) : e.finalText
  return {
    label: isThought ? 'think' : 'output',
    color: isThought ? 'gray' : 'greenBright',
    dimmed: true,
    text: truncate(displayText),
  }
}

function toolCallSummary(
  event: EventOfType<'tool_call'>,
  config: EventDisplayConfig,
): EventSummary {
  const argsStr = formatJson(event.args)
  return {
    ...config,
    color: event.yields ? 'yellowBright' : config.color,
    text: argsStr ? `${event.name} ${truncate(argsStr)}` : event.name,
  }
}

function toolResultSummary(
  event: EventOfType<'tool_result'>,
  config: EventDisplayConfig,
): EventSummary {
  if (event.error) {
    return {
      ...config,
      color: 'redBright',
      text: `${event.name} error: ${truncate(event.error)}`,
    }
  }
  const resultStr =
    event.result === undefined ? 'void' : formatJson(event.result) || String(event.result)
  return {
    ...config,
    text: `${event.name} ${truncate(resultStr)}`,
    dimmed: true,
  }
}

function invocationEndSummary(
  event: EventOfType<'invocation_end'>,
  config: EventDisplayConfig,
): EventSummary {
  const color: EventColor =
    event.reason === 'completed'
      ? 'greenBright'
      : event.reason === 'error'
        ? 'redBright'
        : 'yellowBright'
  const iterStr = event.iterations !== undefined ? ` (${event.iterations} steps)` : ''
  return {
    ...config,
    label: `end:${event.reason}`,
    color,
    text: `${event.agentName}${iterStr}`,
  }
}

function invocationYieldSummary(
  event: EventOfType<'invocation_yield'>,
  config: EventDisplayConfig,
): EventSummary {
  const count = event.yieldedToolIds.length
  const text = count > 0 ? `awaiting ${count} ${count === 1 ? 'call' : 'calls'}` : 'awaiting input'
  return { ...config, text }
}

function modelEndSummary(
  event: EventOfType<'model_end'>,
  config: EventDisplayConfig,
): EventSummary {
  if (event.error) {
    return {
      ...config,
      color: 'redBright',
      text: `error: ${truncate(event.error)}`,
    }
  }
  const parts: string[] = []
  if (event.usage) {
    parts.push(`${event.usage.inputTokens}→${event.usage.outputTokens} tokens`)
  }
  parts.push(`${event.durationMs}ms`)
  return {
    ...config,
    text: parts.join(' • '),
  }
}

const CONTEXT_ROLE_COLORS: Record<string, EventColor> = {
  system: 'white',
  user: 'blueBright',
  assistant: 'greenBright',
  thought: 'white',
  tool_call: 'cyanBright',
  tool_result: 'cyanBright',
}

const CONTEXT_ROLE_LABELS: Record<string, string> = {
  tool_call: 'call',
  tool_result: 'result',
  assistant: 'output',
  thought: 'think',
}

function contextMessageSummary(
  event: EventOfType<'context_message'>,
  config: EventDisplayConfig,
): EventSummary {
  const isEmptyThought = event.message.role === 'thought' && !event.message.content
  return {
    ...config,
    label: CONTEXT_ROLE_LABELS[event.message.role] ?? event.message.role,
    color: CONTEXT_ROLE_COLORS[event.message.role] ?? 'white',
    text: isEmptyThought ? '(encrypted)' : event.message.content,
    textColor: isEmptyThought ? 'gray' : undefined,
    dimmed: true,
  }
}

/** Summaries for invocation lifecycle, model and context events. */
function getLifecycleEventSummary(event: DisplayEvent, config: EventDisplayConfig): EventSummary {
  switch (event.type) {
    case 'invocation_start':
      return { ...config, text: event.agentName }
    case 'invocation_end':
      return invocationEndSummary(event, config)
    case 'invocation_yield':
      return invocationYieldSummary(event, config)
    case 'invocation_resume':
      return { ...config, text: '' }
    case 'model_start':
      return {
        ...config,
        text: `${event.messageCount} msgs • ${event.tools.length} tools`,
      }
    case 'model_end':
      return modelEndSummary(event, config)
    case 'context_message':
      return contextMessageSummary(event, config)
    case 'context_tool':
      return {
        ...config,
        text: `${event.tool.name}: ${event.tool.description}`,
      }
    case 'context_schema':
      return {
        ...config,
        text: event.schemaName,
      }
    default:
      return { ...config, text: (event as { type: string }).type }
  }
}

export function getEventSummary(event: DisplayEvent): EventSummary {
  const config = getEventConfig(event)

  switch (event.type) {
    case 'system':
      return { ...config, text: truncate(event.text) }
    case 'user':
      return { ...config, text: truncate(event.text) }
    case 'thought':
      return thoughtSummary(event, config)
    case 'assistant':
      return { ...config, text: truncate(event.text) }
    case 'delta_batch':
      return deltaBatchSummary(event as DeltaBatchEvent)
    case 'tool_call':
      return toolCallSummary(event, config)
    case 'tool_result':
      return toolResultSummary(event, config)
    case 'tool_yield': {
      const argsStr = formatJson(event.args)
      return {
        ...config,
        text: argsStr ? `${event.name} ${truncate(argsStr)}` : event.name,
      }
    }
    case 'tool_input': {
      const inputStr = formatJson(event.input)
      return {
        ...config,
        text: inputStr ? `${event.name} ${truncate(inputStr)}` : event.name,
      }
    }
    case 'state_change': {
      const keys = event.changes.map((c) => `${event.scope}.${c.key}`).join(', ')
      return { ...config, text: truncate(keys) }
    }
    default:
      return getLifecycleEventSummary(event, config)
  }
}

export type DetailViewMode = 'clean' | 'raw' | 'input'

function getRawEventData(event: DisplayEvent): unknown {
  switch (event.type) {
    case 'delta_batch':
      return event.events
    case 'context_message':
      return event.message
    case 'context_tool':
      return event.tool
    case 'context_schema':
      return { schemaName: event.schemaName }
    default:
      return event
  }
}

function rawEventDetail(event: DisplayEvent, streaming: StreamingMetadata | undefined): string {
  const rawData = getRawEventData(event)
  if (event.type === 'delta_batch') {
    const events = rawData as DeltaBatchEvent['events']
    return events
      .map(
        (delta, idx) =>
          `--- Delta ${idx + 1}/${events.length} ---\n${JSON.stringify(delta, null, 2)}`,
      )
      .join('\n\n')
  }
  const eventJson = JSON.stringify(rawData, null, 2)
  if (streaming) {
    const deltasJson = JSON.stringify(streaming.deltaEvents, null, 2)
    return `${eventJson}\n\n---\n\n${deltasJson}`
  }
  return eventJson
}

function streamHeaderFor(streaming: StreamingMetadata | undefined): string {
  return streaming ? `[Streamed in ${streaming.chunkCount} chunks]\n\n` : ''
}

function assistantDetail(
  event: EventOfType<'assistant'>,
  streaming: StreamingMetadata | undefined,
): string {
  const streamHeader = streamHeaderFor(streaming)
  try {
    const parsed = JSON.parse(event.text)
    return streamHeader + JSON.stringify(parsed, null, 2)
  } catch {
    return streamHeader + event.text
  }
}

function toolResultDetail(event: EventOfType<'tool_result'>): string {
  if (event.error) {
    return `${event.name} error: ${event.error}`
  }
  const meta: string[] = []
  if (event.durationMs !== undefined) meta.push(`${event.durationMs}ms`)
  if (event.retryCount) meta.push(`${event.retryCount} retries`)
  if (event.timedOut) meta.push('timed out')
  const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : ''
  const resultStr =
    typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2)
  return `${event.name}${metaStr} →\n${resultStr}`
}

function modelStartDetail(event: EventOfType<'model_start'>): string {
  const lines: string[] = []
  lines.push(`step ${event.stepIndex} • ${event.messageCount} msgs • ${event.tools.length} tools`)
  if (event.outputSchema) lines.push(`schema: ${event.outputSchema}`)
  if (event.tools.length > 0) {
    lines.push('')
    for (const tool of event.tools) {
      lines.push(`${tool.name}: ${tool.description}`)
    }
  }
  return lines.join('\n')
}

function modelEndDetail(event: EventOfType<'model_end'>): string {
  const parts: string[] = [`${event.durationMs}ms`]
  if (event.usage) {
    parts.push(`${event.usage.inputTokens}→${event.usage.outputTokens} tokens`)
    if (event.usage.cachedTokens) parts.push(`${event.usage.cachedTokens} cached`)
    if (event.usage.reasoningTokens) parts.push(`${event.usage.reasoningTokens} reasoning`)
  }
  if (event.finishReason && event.finishReason !== 'stop') parts.push(event.finishReason)
  if (event.error) parts.push(`error: ${event.error}`)
  return `step ${event.stepIndex} • ${parts.join(' • ')}`
}

/** Details for invocation lifecycle, model and context events. */
function getLifecycleEventDetail(event: DisplayEvent): string {
  switch (event.type) {
    case 'invocation_start': {
      const parent = event.parentInvocationId ? `\nparent: ${event.parentInvocationId}` : ''
      return `${event.agentName}\nid: ${event.invocationId}${parent}`
    }
    case 'invocation_end': {
      const meta: string[] = [event.reason]
      if (event.iterations !== undefined) meta.push(`${event.iterations} steps`)
      const error = event.error ? `\n${event.error}` : ''
      return `${event.agentName} (${meta.join(', ')})${error}`
    }
    case 'invocation_yield':
      return `${event.agentName} yielded\nawaiting: ${event.yieldedToolIds.join(', ')}`
    case 'invocation_resume':
      return `${event.agentName} resumed`
    case 'model_start':
      return modelStartDetail(event)
    case 'model_end':
      return modelEndDetail(event)
    case 'context_message':
      return event.message.content
    case 'context_tool':
      return `${event.tool.name}\n${event.tool.description}`
    case 'context_schema':
      return event.schemaName
    default:
      return JSON.stringify(event, null, 2)
  }
}

export function getEventDetail(
  event: DisplayEvent,
  mode: DetailViewMode = 'clean',
  streaming?: StreamingMetadata,
): string {
  if (mode === 'raw') {
    return rawEventDetail(event, streaming)
  }

  switch (event.type) {
    case 'system':
      return event.text
    case 'user':
      return event.text
    case 'thought': {
      const displayText = event.text || getThoughtFallback(event) || '(no content)'
      return streamHeaderFor(streaming) + displayText
    }
    case 'assistant':
      return assistantDetail(event, streaming)
    case 'tool_call':
      return `${event.name}(${JSON.stringify(event.args, null, 2)})`
    case 'tool_result':
      return toolResultDetail(event)
    case 'tool_yield':
      return `${event.name} yielded\nargs: ${JSON.stringify(event.args, null, 2)}`
    case 'tool_input':
      return `input: ${JSON.stringify(event.input, null, 2)}`
    case 'state_change': {
      const changes = event.changes.map((c) => {
        const old = JSON.stringify(c.oldValue)
        const val = JSON.stringify(c.newValue)
        return `${c.key}: ${old} → ${val}`
      })
      return `${event.scope} (${event.source})\n${changes.join('\n')}`
    }
    case 'delta_batch': {
      if (event.deltaType === 'thought_delta') {
        return extractCurrentThoughtBlock(event.finalText)
      }
      return event.finalText
    }
    default:
      return getLifecycleEventDetail(event)
  }
}
