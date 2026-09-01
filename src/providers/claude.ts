import type { AnthropicVertex } from '@anthropic-ai/vertex-sdk'

import { z } from 'zod'

import type {
  Event,
  StreamEvent,
  ToolCallEvent,
  ModelUsage,
  ModelEndEvent,
  UserEvent,
} from '../types/events'
import type {
  ModelStepResult,
  ModelAdapter,
  ProviderModelConfig,
  ClaudeModel,
  RenderContext,
  FunctionTool,
  ToolChoice,
} from '../types/runnables'

import { withStreamRetry } from '../core/retry'
import { createEventId, createCallId } from '../session'
import { createStreamAccumulator, type RawDeltaEvent } from './accumulator'
import { normalizeSchema } from './normalizeSchema'
import { zodToToolSchema } from './zodToJsonSchema'

interface TextBlock {
  type: 'text'
  text: string
}

interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
}

interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  inputJson: string
}

type ParsedContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock

interface MessageParam {
  role: 'user' | 'assistant'
  content: ContentBlockParam[] | string
}

interface TextBlockParam {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' } | null
}

interface ToolUseBlockParam {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

type ToolResultContent = string | Array<TextBlockParam | ImageBlockParam | DocumentBlockParam>

interface ToolResultBlockParam {
  type: 'tool_result'
  tool_use_id: string
  content: ToolResultContent
  is_error?: boolean
}

interface ThinkingBlockParam {
  type: 'thinking'
  thinking: string
  signature: string
}

interface ImageBlockParam {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
}

interface DocumentBlockParam {
  type: 'document'
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
}

type ContentBlockParam =
  | TextBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlock
  | ImageBlockParam

interface ClaudeTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

function createClientKey(config: ClaudeModel['vertex']): string {
  const creds = config.credentials ?? 'env'
  return `${config.project}:${config.location}:${creds}`
}

function loadAnthropicVertex(): typeof AnthropicVertex {
  try {
    return (require('@anthropic-ai/vertex-sdk') as typeof import('@anthropic-ai/vertex-sdk'))
      .AnthropicVertex
  } catch {
    throw new Error(
      'The "@anthropic-ai/vertex-sdk" package is required for Claude via Vertex AI. ' +
        'Install it with: npm install @anthropic-ai/vertex-sdk',
    )
  }
}

export class ClaudeAdapter implements ModelAdapter {
  private clientCache = new Map<string, AnthropicVertex>()

  private getClient(modelConfig: ProviderModelConfig): AnthropicVertex {
    if (modelConfig.provider !== 'claude') {
      throw new Error(`ClaudeAdapter received non-claude model config`)
    }

    const cacheKey = createClientKey(modelConfig.vertex)
    let client = this.clientCache.get(cacheKey)

    if (!client) {
      const credentials =
        modelConfig.vertex.credentials ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
      if (!credentials) {
        throw new Error(
          `No Google Cloud credentials configured.

Either:
  - Pass credentials path in vertex config: vertex: { project, location, credentials: "/path/to/credentials.json" }
  - Set GOOGLE_APPLICATION_CREDENTIALS environment variable`,
        )
      }
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials
      const AnthropicVertexCtor = loadAnthropicVertex()
      client = new AnthropicVertexCtor({
        projectId: modelConfig.vertex.project,
        region: modelConfig.vertex.location,
      })
      this.clientCache.set(cacheKey, client)
    }

    return client
  }

  async *step(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    if (config.provider !== 'claude') {
      throw new Error(`ClaudeAdapter received non-claude model config`)
    }

    const retryConfig = config.retry
    const thinkingConfig = config.thinking
    const promptCache = normalizePromptCache(config)
    const { messages, system } = serializeContext(ctx, { promptCache })
    const client = this.getClient(config)

    const createStream = async function* (): AsyncGenerator<StreamEvent, ModelStepResult> {
      if (signal?.aborted) {
        throw new Error('Aborted')
      }

      const accumulator = createStreamAccumulator()
      const contentBlocks: ParsedContentBlock[] = []
      let inputTokens = 0
      let outputTokens = 0
      let cachedInputTokens = 0
      let stopReason: string | null = null

      let toolChoice = ctx.toolChoice ?? ctx.agent.toolChoice
      if (
        thinkingConfig &&
        toolChoice !== 'auto' &&
        toolChoice !== 'none' &&
        toolChoice !== undefined
      ) {
        toolChoice = 'auto'
      }

      const buildRequest = (overrideSystem?: typeof system) => ({
        model: config.name,
        max_tokens: config.maxTokens ?? 4096,
        // Anthropic rejects any temperature other than the default (1) when
        // extended thinking is enabled, so it is only forwarded without
        // thinking. With thinking on, a set temperature is dropped rather than
        // failing the request.
        ...(config.temperature != null && !thinkingConfig && { temperature: config.temperature }),
        ...(overrideSystem ? { system: overrideSystem } : system ? { system } : {}),
        messages: messages as Parameters<typeof client.messages.create>[0]['messages'],
        ...(ctx.functionTools.length > 0 && {
          tools: serializeTools(ctx.functionTools),
          tool_choice: serializeToolChoice(
            toolChoice,
            thinkingConfig ? undefined : ctx.allowedTools,
          ),
        }),
        ...(thinkingConfig && {
          thinking: {
            type: 'enabled' as const,
            budget_tokens: thinkingConfig.budgetTokens ?? 1024,
          },
        }),
        stream: true as const,
      })

      const createWithFallback = async () => {
        try {
          return await client.messages.create(buildRequest())
        } catch (err) {
          // If explicit prompt caching is disabled for this Vertex project (or unsupported),
          // retry once without cache_control to avoid breaking existing users when caching
          // is enabled by default.
          if (promptCache.enabled && isPromptCachingUnsupportedError(err)) {
            const fallbackSystem =
              typeof system === 'string'
                ? system
                : system?.map((b) => ({ type: 'text' as const, text: b.text }))
            return await client.messages.create(buildRequest(fallbackSystem))
          }
          throw err
        }
      }

      const response = await createWithFallback()

      for await (const event of response) {
        if (signal?.aborted) {
          throw new Error('Aborted')
        }

        if (event.type === 'message_start') {
          inputTokens = event.message.usage?.input_tokens ?? 0
          cachedInputTokens =
            (event.message.usage as { cache_read_input_tokens?: number | null })
              ?.cache_read_input_tokens ?? 0
        }

        if (event.type === 'message_delta') {
          outputTokens = event.usage?.output_tokens ?? 0
          stopReason = event.delta?.stop_reason ?? null
        }

        if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block.type === 'text') {
            contentBlocks.push({ type: 'text', text: '' })
          } else if (block.type === 'thinking') {
            contentBlocks.push({
              type: 'thinking',
              thinking: '',
              signature: '',
            })
          } else if (block.type === 'redacted_thinking') {
            contentBlocks.push({ type: 'redacted_thinking', data: block.data })
          } else if (block.type === 'tool_use') {
            contentBlocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              inputJson: '',
            })
          }
        }

        if (event.type === 'content_block_delta') {
          const lastBlock = contentBlocks[contentBlocks.length - 1]
          if (!lastBlock) continue

          if (event.delta.type === 'text_delta' && lastBlock.type === 'text') {
            lastBlock.text += event.delta.text
            const rawEvent: RawDeltaEvent = {
              id: createEventId(),
              type: 'assistant_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta.text,
            }
            yield accumulator.push(rawEvent)
          }

          if (event.delta.type === 'thinking_delta' && lastBlock.type === 'thinking') {
            lastBlock.thinking += event.delta.thinking
            const rawEvent: RawDeltaEvent = {
              id: createEventId(),
              type: 'thought_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta.thinking,
            }
            yield accumulator.push(rawEvent)
          }

          if (event.delta.type === 'input_json_delta' && lastBlock.type === 'tool_use') {
            lastBlock.inputJson += event.delta.partial_json || ''
          }

          if (event.delta.type === 'signature_delta' && lastBlock.type === 'thinking') {
            lastBlock.signature += event.delta.signature || ''
          }
        }
      }

      return parseResponse(
        contentBlocks,
        { inputTokens, outputTokens, cachedTokens: cachedInputTokens },
        stopReason,
        ctx.invocationId,
        ctx.agentName,
      )
    }

    return yield* withStreamRetry(createStream, {
      config: retryConfig,
      signal,
    })
  }
}

type PromptCacheConfig = Required<NonNullable<ClaudeModel['promptCache']>> & { enabled: boolean }

function normalizePromptCache(modelConfig: ClaudeModel): PromptCacheConfig {
  const cfg = modelConfig.promptCache
  if (cfg?.enabled === false) {
    return { enabled: false, ttl: '5m', system: 'all' }
  }
  // Default ON for Vertex-Claude to maximize savings; can be disabled explicitly.
  return {
    enabled: true,
    ttl: cfg?.ttl ?? '5m',
    system: cfg?.system ?? 'all',
  }
}

function isPromptCachingUnsupportedError(error: unknown): boolean {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : ''
  // Vertex can reject requests when explicit caching is disabled for the project.
  // Also tolerate generic "unknown field cache_control" style errors.
  return /prompt caching|explicit caching|cache_control|cache control/i.test(message)
}

export function serializeContext(
  ctx: RenderContext,
  options?: { promptCache?: PromptCacheConfig },
): {
  messages: MessageParam[]
  system: string | TextBlockParam[] | undefined
} {
  const messages: MessageParam[] = []
  const systemParts: Array<{
    text: string
    cacheable: boolean
  }> = []
  const toolUseIdMap = new Map<string, string>()

  type ClaudeRole = 'user' | 'assistant'
  let currentRole: ClaudeRole | null = null
  let currentContent: ContentBlockParam[] = []

  const flushCurrent = () => {
    if (currentRole && currentContent.length > 0) {
      messages.push({ role: currentRole, content: currentContent })
    }
    currentContent = []
  }

  const pushContent = (role: ClaudeRole, block: ContentBlockParam) => {
    if (currentRole !== role) {
      flushCurrent()
      currentRole = role
    }
    currentContent.push(block)
  }

  const serializeUserEvent = (event: UserEvent): ContentBlockParam[] => {
    const blocks: ContentBlockParam[] = []
    if (event.text) {
      blocks.push({ type: 'text', text: event.text })
    }
    if (event.media) {
      for (const part of event.media) {
        if (part.type === 'image') {
          const source = part.source
          blocks.push({
            type: 'image',
            source:
              source.type === 'url'
                ? { type: 'url' as const, url: source.url }
                : {
                    type: 'base64' as const,
                    media_type: source.mimeType,
                    data: source.data,
                  },
          })
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
  }

  for (const event of ctx.events) {
    switch (event.type) {
      case 'system':
        systemParts.push({
          text: event.text,
          cacheable: Boolean(
            options?.promptCache?.enabled &&
            (options.promptCache.system === 'all' ||
              (event.providerContext?.provider === 'adk' &&
                (event.providerContext.data as { cacheable?: boolean })?.cacheable)),
          ),
        })
        break

      case 'user':
        for (const block of serializeUserEvent(event)) {
          pushContent('user', block)
        }
        break

      case 'assistant':
        pushContent('assistant', { type: 'text', text: event.text })
        break

      case 'thought': {
        const thinkingCtx = getClaudeContext(event)
        if (thinkingCtx?.redacted) {
          pushContent('assistant', {
            type: 'redacted_thinking',
            data: thinkingCtx.data as string,
          })
        } else {
          pushContent('assistant', {
            type: 'thinking',
            thinking: event.text,
            signature: thinkingCtx?.signature ?? '',
          })
        }
        break
      }

      case 'tool_call': {
        const providerCtx = getClaudeContext(event)
        const toolUseId = providerCtx?.id ?? event.callId
        toolUseIdMap.set(event.callId, toolUseId)
        pushContent('assistant', {
          type: 'tool_use',
          id: toolUseId,
          name: event.name,
          input: event.args,
        })
        break
      }

      case 'tool_result': {
        const toolUseId = toolUseIdMap.get(event.callId) ?? event.callId
        const textContent = event.error ?? JSON.stringify(event.result)

        if (event.media && event.media.length > 0) {
          const contentBlocks: Array<TextBlockParam | ImageBlockParam | DocumentBlockParam> = [
            { type: 'text', text: textContent },
          ]
          for (const part of event.media) {
            if (part.type === 'image') {
              const source = part.source
              contentBlocks.push({
                type: 'image',
                source:
                  source.type === 'url'
                    ? { type: 'url' as const, url: source.url }
                    : {
                        type: 'base64' as const,
                        media_type: source.mimeType,
                        data: source.data,
                      },
              })
            } else if (part.type === 'document') {
              const source = part.source
              contentBlocks.push({
                type: 'document',
                source:
                  source.type === 'url'
                    ? { type: 'url' as const, url: source.url }
                    : {
                        type: 'base64' as const,
                        media_type: source.mimeType,
                        data: source.data,
                      },
              })
            }
          }
          pushContent('user', {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: contentBlocks,
            ...(event.error && { is_error: true }),
          })
        } else {
          pushContent('user', {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: textContent,
            ...(event.error && { is_error: true }),
          })
        }
        break
      }
    }
  }

  flushCurrent()

  return {
    messages,
    system:
      systemParts.length === 0
        ? undefined
        : options?.promptCache?.enabled
          ? systemParts.map((p) => ({
              type: 'text' as const,
              text: p.text,
              ...(p.cacheable && {
                cache_control: {
                  type: 'ephemeral' as const,
                  ttl: options.promptCache!.ttl,
                },
              }),
            }))
          : systemParts.map((p) => p.text).join('\n\n'),
  }
}

function getClaudeContext(event: Pick<Event, 'providerContext'>):
  | {
      id?: string
      tool_use_id?: string
      signature?: string
      redacted?: boolean
      data?: string
    }
  | undefined {
  if (event.providerContext?.provider === 'claude') {
    return event.providerContext.data as {
      id?: string
      tool_use_id?: string
      signature?: string
      redacted?: boolean
      data?: string
    }
  }
  return undefined
}

interface ClaudeUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
}

function parseClaudeUsage(usage: ClaudeUsage): ModelUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedTokens !== undefined && { cachedTokens: usage.cachedTokens }),
  }
}

function parseClaudeFinishReason(
  reason: string | null,
  hasToolCalls: boolean,
): ModelEndEvent['finishReason'] {
  if (hasToolCalls) return 'tool_calls'
  if (reason === 'end_turn') return 'stop'
  if (reason === 'max_tokens') return 'length'
  if (reason === 'stop_sequence') return 'stop'
  if (reason === 'tool_use') return 'tool_calls'
  return 'stop'
}

export function parseResponse(
  blocks: ParsedContentBlock[],
  usage: ClaudeUsage,
  stopReason: string | null,
  invocationId: string,
  agentName: string,
): ModelStepResult {
  const createdAt = Date.now()
  const stepEvents: Event[] = []
  const toolCalls: ToolCallEvent[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'thinking':
        if (block.thinking) {
          stepEvents.push({
            id: createEventId(),
            type: 'thought',
            createdAt,
            invocationId,
            agentName,
            text: block.thinking,
            providerContext: {
              provider: 'claude',
              data: { signature: block.signature },
            },
          } as Event)
        }
        break

      case 'redacted_thinking':
        stepEvents.push({
          id: createEventId(),
          type: 'thought',
          createdAt,
          invocationId,
          agentName,
          text: '[redacted]',
          providerContext: {
            provider: 'claude',
            data: { redacted: true, data: block.data },
          },
        } as Event)
        break

      case 'text':
        if (block.text) {
          stepEvents.push({
            id: createEventId(),
            type: 'assistant',
            createdAt,
            invocationId,
            agentName,
            text: block.text,
          } as Event)
        }
        break

      case 'tool_use': {
        let args: Record<string, unknown> = {}
        try {
          args = block.inputJson ? JSON.parse(block.inputJson) : {}
        } catch {
          args = {}
        }
        const toolCall: ToolCallEvent = {
          id: createEventId(),
          type: 'tool_call',
          createdAt,
          invocationId,
          agentName,
          callId: createCallId(),
          name: block.name,
          args,
          providerContext: {
            provider: 'claude',
            data: { id: block.id },
          },
        }
        stepEvents.push(toolCall)
        toolCalls.push(toolCall)
        break
      }
    }
  }

  return {
    stepEvents,
    toolCalls,
    terminal: toolCalls.length === 0,
    usage: parseClaudeUsage(usage),
    finishReason: parseClaudeFinishReason(stopReason, toolCalls.length > 0),
  }
}

export function serializeTools(tools: readonly FunctionTool[]): ClaudeTool[] {
  return tools.map((t) => {
    const fn = zodToToolSchema(
      t.name,
      t.description,
      normalizeSchema(t.schema as z.ZodType, t.name),
    )
    return {
      name: fn.name,
      description: fn.description ?? t.description,
      input_schema: {
        type: 'object' as const,
        ...fn.parameters,
      },
    }
  })
}

type ClaudeToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string }

export function serializeToolChoice(
  choice: ToolChoice | undefined,
  allowedTools?: readonly string[],
): ClaudeToolChoice {
  if (allowedTools && allowedTools.length === 1) {
    return { type: 'tool', name: allowedTools[0] }
  }

  if (!choice || choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  if (typeof choice === 'object' && 'name' in choice) {
    return { type: 'tool', name: choice.name }
  }

  return { type: 'auto' }
}
