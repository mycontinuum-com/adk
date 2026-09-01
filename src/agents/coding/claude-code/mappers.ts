/**
 * SDK Message to ADK StreamEvent Mappers
 *
 * Maps @anthropic-ai/claude-agent-sdk message types to ADK StreamEvent types. This is the core
 * translation layer between the Claude Code SDK and ADK.
 *
 * Mapping:
 *
 * - SDKAssistantMessage (text) → assistant event
 * - SDKAssistantMessage (tool_use) → tool_call event
 * - SDKUserMessage (tool_result) → tool_result event
 * - SDKPartialAssistantMessage (text_delta) → assistant_delta event
 * - SDKPartialAssistantMessage (thinking_delta) → thought_delta event
 * - SDKResultMessage → resolves CodingResult
 * - SDKRateLimitEvent → error event (when rejected)
 *
 * @module
 */

import type {
  StreamEvent,
  AssistantEvent,
  AssistantDeltaEvent,
  ThoughtEvent,
  ThoughtDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  SystemEvent,
} from '../../../types/events'
import type { UsageSummary, CostEstimate } from '../../../types/runtime'
import type { CodingResult, CodingStatus, CodingError, CodingOutput } from '../types'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKRateLimitEvent,
  ContentBlock,
  ToolResultContent,
} from './types'

/** Context for event mapping operations. */
export interface MapperContext {
  /** Current invocation ID for events. */
  invocationId: string
  /** Agent name for events. */
  agentName: string
  /** Process ID for artifact events. */
  processId: string
  /** Accumulated text for assistant messages. */
  accumulatedText: string
  /** Accumulated thinking text. */
  accumulatedThinking: string
}

/** Creates a unique event ID. */
function createEventId(): string {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Creates the base event fields. */
function createEventBase(ctx: MapperContext) {
  return {
    id: createEventId(),
    createdAt: Date.now(),
    invocationId: ctx.invocationId,
    agentName: ctx.agentName,
  }
}

/**
 * Maps an SDKAssistantMessage to ADK StreamEvents. An assistant message can contain multiple
 * content blocks (text, tool_use, thinking). Each content block maps to a separate event.
 */
export function* mapAssistantMessage(
  msg: SDKAssistantMessage,
  ctx: MapperContext,
): Generator<StreamEvent> {
  const content = msg.message.content

  for (const block of content) {
    yield* mapContentBlock(block, ctx, msg.uuid)
  }
}

/** Maps a content block to the appropriate StreamEvent. */
function* mapContentBlock(
  block: ContentBlock,
  ctx: MapperContext,
  messageUuid: string,
): Generator<StreamEvent> {
  switch (block.type) {
    case 'text':
      // Update accumulated text
      ctx.accumulatedText += block.text
      yield {
        ...createEventBase(ctx),
        type: 'assistant',
        text: block.text,
        providerContext: {
          provider: 'claude-code',
          data: { messageUuid },
        },
      } as AssistantEvent
      break

    case 'tool_use':
      yield {
        ...createEventBase(ctx),
        type: 'tool_call',
        callId: block.id,
        name: block.name,
        args: block.input,
        providerContext: {
          provider: 'claude-code',
          data: { messageUuid },
        },
      } as ToolCallEvent
      break

    case 'thinking':
      // Update accumulated thinking
      ctx.accumulatedThinking += block.thinking
      yield {
        ...createEventBase(ctx),
        type: 'thought',
        text: block.thinking,
        providerContext: {
          provider: 'claude-code',
          data: { messageUuid },
        },
      } as ThoughtEvent
      break
  }
}

/** Maps an SDKUserMessage to ADK StreamEvents. User messages can contain text or tool results. */
export function* mapUserMessage(msg: SDKUserMessage, ctx: MapperContext): Generator<StreamEvent> {
  const content = msg.message.content

  // Handle string content
  if (typeof content === 'string') {
    // User text messages are typically not emitted to the stream
    // They represent input, not output
    return
  }

  // Handle array content
  const blocks = Array.isArray(content) ? content : [content]

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      yield mapToolResult(block as ToolResultContent, ctx, msg.uuid)
    }
    // Text blocks in user messages are typically not emitted
  }
}

/** Maps a tool_result content block to a ToolResultEvent. */
function mapToolResult(
  block: ToolResultContent,
  ctx: MapperContext,
  messageUuid: string,
): ToolResultEvent {
  // Extract text from content
  let resultText: string
  if (typeof block.content === 'string') {
    resultText = block.content
  } else if (Array.isArray(block.content)) {
    resultText = block.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
  } else {
    resultText = ''
  }

  return {
    ...createEventBase(ctx),
    type: 'tool_result',
    callId: block.tool_use_id,
    name: 'unknown', // SDK doesn't provide tool name in result
    result: block.is_error ? undefined : resultText,
    error: block.is_error ? resultText : undefined,
    providerContext: {
      provider: 'claude-code',
      data: { messageUuid },
    },
  } as ToolResultEvent
}

/** Maps an SDKPartialAssistantMessage to streaming delta events. */
export function mapPartialMessage(
  msg: SDKPartialAssistantMessage,
  ctx: MapperContext,
): StreamEvent | null {
  const delta = msg.delta

  if (delta.type === 'text_delta' && delta.text) {
    ctx.accumulatedText += delta.text
    return {
      ...createEventBase(ctx),
      type: 'assistant_delta',
      delta: delta.text,
      text: ctx.accumulatedText,
      providerContext: {
        provider: 'claude-code',
        data: { messageUuid: msg.uuid },
      },
    } as AssistantDeltaEvent
  }

  if (delta.type === 'thinking_delta' && delta.thinking) {
    ctx.accumulatedThinking += delta.thinking
    return {
      ...createEventBase(ctx),
      type: 'thought_delta',
      delta: delta.thinking,
      text: ctx.accumulatedThinking,
      providerContext: {
        provider: 'claude-code',
        data: { messageUuid: msg.uuid },
      },
    } as ThoughtDeltaEvent
  }

  return null
}

/** Maps an SDKSystemMessage to a SystemEvent. */
export function mapSystemMessage(msg: SDKSystemMessage, ctx: MapperContext): SystemEvent | null {
  // Only emit init messages as system events
  if (msg.subtype !== 'init') {
    return null
  }

  return {
    ...createEventBase(ctx),
    type: 'system',
    text: `Claude Code initialized with ${msg.tools?.length ?? 0} tools, ${msg.agents?.length ?? 0} agents`,
    providerContext: {
      provider: 'claude-code',
      data: {
        tools: msg.tools,
        agents: msg.agents,
        mcpServers: msg.mcp_servers,
        permissionMode: msg.permissionMode,
      },
    },
  } as SystemEvent
}

/** Maps an SDKResultMessage to a CodingResult. */
export function mapResultToCodingResult(
  msg: SDKResultMessage,
  sessionId: string,
  startTime: number,
  modifiedFiles: string[],
  accumulatedText: string,
): CodingResult {
  const durationMs = Date.now() - startTime

  // Map SDK result subtype to CodingStatus
  const status = mapResultSubtypeToStatus(msg.subtype, msg.errors)

  // Calculate cached tokens from SDK usage
  const cachedTokens =
    (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)

  // Build usage summary aligned with ADK's UsageSummary
  const usage: UsageSummary = {
    models: [
      {
        modelName: 'claude-code',
        calls: 1,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cachedTokens,
        reasoningTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        cost: {
          inputCost: 0, // SDK doesn't break down by type
          outputCost: 0,
          totalCost: msg.total_cost_usd,
          currency: 'USD',
        } as CostEstimate,
      },
    ],
    totalInputTokens: msg.usage.input_tokens,
    totalOutputTokens: msg.usage.output_tokens,
    totalCachedTokens: cachedTokens,
    totalReasoningTokens: 0,
    totalAudioInputTokens: 0,
    totalAudioOutputTokens: 0,
    modelCalls: 1,
    cost: {
      inputCost: 0,
      outputCost: 0,
      totalCost: msg.total_cost_usd,
      currency: 'USD',
    } as CostEstimate,
  }

  // Build output aligned with ADK's Output structure
  const outputValue: CodingOutput = {
    modifiedFiles,
    metadata: msg.permission_denials?.length
      ? { permissionDenials: msg.permission_denials }
      : undefined,
  }

  const result: CodingResult = {
    status,
    sessionId,
    durationMs,
    usage,
    output: {
      text: msg.result ?? accumulatedText,
      value: outputValue,
      items: [],
    },
  }

  // Add error information if present
  if (msg.errors && msg.errors.length > 0) {
    result.error = {
      message: msg.errors.map((e) => e.message).join('; '),
      code: mapErrorToCode(msg.subtype, msg.errors),
    }
  }

  return result
}

/** Maps SDK result subtype to CodingStatus. */
function mapResultSubtypeToStatus(
  subtype: SDKResultMessage['subtype'],
  errors?: Array<{ message: string }>,
): CodingStatus {
  switch (subtype) {
    case 'success':
      return 'completed'
    case 'error_max_turns':
      return 'max_turns'
    case 'error_max_budget_usd':
      return 'completed' // Completed but hit budget limit
    case 'error_during_execution':
      // Check if it's a context window error
      if (errors?.some((e) => e.message.toLowerCase().includes('context'))) {
        return 'error' // Will have context_exhausted code
      }
      return 'error'
    case 'error_max_structured_output_retries':
      return 'error'
    default:
      return 'error'
  }
}

/** Maps error information to a CodingErrorCode. */
function mapErrorToCode(
  subtype: SDKResultMessage['subtype'],
  errors?: Array<{ message: string }>,
): CodingError['code'] {
  if (errors?.some((e) => e.message.toLowerCase().includes('context'))) {
    return 'context_exhausted'
  }
  if (errors?.some((e) => e.message.toLowerCase().includes('rate limit'))) {
    return 'rate_limited'
  }
  if (subtype === 'error_during_execution') {
    return 'sdk_error'
  }
  return 'unknown'
}

/** Maps an SDKRateLimitEvent to an error event or outcome. */
export function mapRateLimitEvent(
  event: SDKRateLimitEvent,
  _ctx: MapperContext,
): { event?: StreamEvent; shouldStop: boolean; retryAfter?: number } {
  // Only handle rejected rate limits as errors
  if (event.status !== 'rejected') {
    return { shouldStop: false }
  }

  // Parse retry time if available
  let retryAfter: number | undefined
  if (event.reset_at) {
    const resetTime = new Date(event.reset_at).getTime()
    retryAfter = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000))
  }

  return {
    shouldStop: true,
    retryAfter,
  }
}

/** Creates an error result from an error condition. */
export function createErrorResult(
  sessionId: string,
  startTime: number,
  error: CodingError,
  status: CodingStatus = 'error',
): CodingResult {
  return {
    status,
    sessionId,
    durationMs: Date.now() - startTime,
    error,
    output: {
      text: undefined,
      value: { modifiedFiles: [] },
      items: [],
    },
  }
}

/**
 * Extracts modified files from tool call events. Tracks file paths from write, edit, and similar
 * tool calls.
 */
export function extractModifiedFile(event: ToolCallEvent): string | null {
  const writingTools = ['write', 'edit', 'Write', 'Edit', 'file_write', 'file_edit']

  if (!writingTools.includes(event.name)) {
    return null
  }

  const args = event.args
  // Try common path argument names
  const path = args.path ?? args.file_path ?? args.filePath ?? args.file

  if (typeof path === 'string') {
    return path
  }

  return null
}

/** Maps a generic SDK message to ADK StreamEvents. This is the main entry point for message mapping. */
export function* mapSDKMessage(msg: SDKMessage, ctx: MapperContext): Generator<StreamEvent> {
  switch (msg.type) {
    case 'assistant':
      yield* mapAssistantMessage(msg, ctx)
      break

    case 'user':
      yield* mapUserMessage(msg, ctx)
      break

    case 'partial_assistant':
      const deltaEvent = mapPartialMessage(msg, ctx)
      if (deltaEvent) {
        yield deltaEvent
      }
      break

    case 'system':
      const sysEvent = mapSystemMessage(msg, ctx)
      if (sysEvent) {
        yield sysEvent
      }
      break

    // Other message types (task_started, task_progress, tool_progress, etc.)
    // are not mapped to stream events as they're internal progress indicators
  }
}
