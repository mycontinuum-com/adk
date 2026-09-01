import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses'

import OpenAI, { AzureOpenAI } from 'openai'
import { zodResponsesFunction, zodTextFormat } from 'openai/helpers/zod'
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
  RenderContext,
  FunctionTool,
  ToolChoice,
  ProviderTool,
} from '../types/runnables'

import { CALL_ID_PREFIX } from '../core/constants'
import { withStreamRetry } from '../core/retry'
import { createEventId, createCallId } from '../session'
import { createStreamAccumulator, type RawDeltaEvent, type AccumulatedText } from './accumulator'
import { normalizeSchema } from './normalizeSchema'
import {
  type OpenAIEndpoint,
  getDefaultEndpoints,
  resolveModelName,
  isRetryableForFallback,
} from './openai-endpoints'

interface OpenAIPromptCacheRequestOptions {
  prompt_cache_key: string
  prompt_cache_options: {
    mode: 'explicit'
    ttl: '30m'
  }
}

export function serializePromptCacheOptions(
  config: ProviderModelConfig,
): OpenAIPromptCacheRequestOptions | Record<string, never> {
  if (config.provider !== 'openai' || !config.promptCache) return {}

  const key = config.promptCache.key.trim()
  if (key.length === 0) {
    throw new Error('OpenAI prompt cache key must not be empty')
  }
  if (key.length > 64) {
    throw new Error('OpenAI prompt cache key must be at most 64 characters')
  }

  return {
    prompt_cache_key: key,
    prompt_cache_options: {
      mode: config.promptCache.mode,
      ttl: config.promptCache.ttl,
    },
  }
}

function createEndpointKey(endpoint: OpenAIEndpoint, model?: string): string {
  return `${endpoint.type}:${endpoint.baseUrl ?? 'default'}:${
    endpoint.apiVersion ?? ''
  }:${model ?? ''}`
}

export class OpenAIAdapter implements ModelAdapter {
  private endpoints: OpenAIEndpoint[]
  private clientCache = new Map<string, OpenAI>()

  constructor(endpoints?: OpenAIEndpoint[]) {
    this.endpoints = endpoints ?? getDefaultEndpoints()
  }

  static withDefaults(): OpenAIAdapter {
    return new OpenAIAdapter(getDefaultEndpoints())
  }

  static withFallback(endpoints: OpenAIEndpoint[]): OpenAIAdapter {
    return new OpenAIAdapter(endpoints)
  }

  async *step(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    let lastError: Error | undefined

    for (let i = 0; i < this.endpoints.length; i++) {
      const endpoint = this.endpoints[i]
      const isLast = i === this.endpoints.length - 1

      try {
        return yield* this.executeStep(ctx, config, signal, endpoint)
      } catch (error) {
        lastError = error as Error
        if (isLast || !isRetryableForFallback(error)) {
          throw error
        }
      }
    }

    throw lastError ?? new Error('No endpoints configured')
  }

  private getOrCreateClient(
    endpoint: OpenAIEndpoint,
    modelName: string,
  ): { client: OpenAI; resolvedModel: string } {
    const resolvedModel = resolveModelName(modelName, endpoint)
    const cacheKey = createEndpointKey(
      endpoint,
      endpoint.type === 'azure' ? resolvedModel : undefined,
    )

    let client = this.clientCache.get(cacheKey)
    if (!client) {
      client = this.createClient(endpoint, resolvedModel)
      this.clientCache.set(cacheKey, client)
    }

    return { client, resolvedModel }
  }

  private createClient(endpoint: OpenAIEndpoint, resolvedModel: string): OpenAI {
    if (endpoint.type === 'azure') {
      const base = endpoint.baseUrl!.replace(/\/$/, '')
      const deploymentUrl = `${base}/openai/deployments/${resolvedModel}`
      return new AzureOpenAI({
        endpoint: deploymentUrl,
        apiVersion: endpoint.apiVersion!,
        apiKey: endpoint.apiKey,
        ...(endpoint.dangerouslyAllowBrowser === true ? { dangerouslyAllowBrowser: true } : {}),
      })
    }

    return new OpenAI({
      apiKey: endpoint.apiKey,
      baseURL: endpoint.baseUrl,
      ...(endpoint.dangerouslyAllowBrowser === true ? { dangerouslyAllowBrowser: true } : {}),
    })
  }

  private async *executeStep(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal: AbortSignal | undefined,
    endpoint: OpenAIEndpoint,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const reasoning = config.provider === 'openai' ? config.reasoning : undefined
    const retryConfig = config.provider === 'openai' ? config.retry : undefined
    const promptCache = config.provider === 'openai' ? config.promptCache : undefined
    const { client, resolvedModel } = this.getOrCreateClient(endpoint, config.name)

    const createStream = async function* (): AsyncGenerator<StreamEvent, ModelStepResult> {
      if (signal?.aborted) {
        throw new Error('Aborted')
      }
      const input = serializeContext(ctx, { promptCache: Boolean(promptCache) })
      const promptCacheOptions = serializePromptCacheOptions(config)
      const toolChoice = ctx.toolChoice ?? ctx.agent.toolChoice
      const serializedTools = serializeTools(ctx.functionTools, ctx.providerTools)
      const serializedToolChoice = serializeToolChoice(toolChoice, ctx.allowedTools)
      const useNativeStructuredOutput = ctx.outputSchema && ctx.outputMode !== 'prompt'
      // The OpenAI SDK runtime forwards these documented fields, while the pinned SDK's types lag
      // the Responses API prompt-caching surface.
      const request = {
        model: resolvedModel,
        input,
        tools: serializedTools,
        store: false,
        ...promptCacheOptions,
        ...(serializedToolChoice && { tool_choice: serializedToolChoice }),
        // OpenAI reasoning models (o-series, GPT-5.x) reject a non-default
        // temperature, so it is only forwarded to non-reasoning models --
        // mirroring how python drops it for those families.
        ...(config.temperature != null && !reasoning && { temperature: config.temperature }),
        ...(config.maxTokens != null && { max_output_tokens: config.maxTokens }),
        ...(reasoning && {
          reasoning,
          include: ['reasoning.encrypted_content'],
        }),
        ...(useNativeStructuredOutput && {
          text: {
            format: zodTextFormat(
              normalizeSchema(ctx.outputSchema!, 'output_schema') as z.ZodType,
              'output_schema',
            ),
          },
        }),
      } as Parameters<typeof client.responses.stream>[0]
      const stream = client.responses.stream(request)

      const cleanup = signal ? registerAbortHandler(signal, () => stream.abort()) : undefined

      const accumulator = createStreamAccumulator()

      try {
        for await (const event of stream) {
          if (signal?.aborted) {
            throw new Error('Aborted')
          }

          let rawEvent: RawDeltaEvent | null = null

          if (event.type === 'response.reasoning_summary_text.delta') {
            rawEvent = {
              id: createEventId(),
              type: 'thought_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta,
            }
          } else if (event.type === 'response.output_text.delta') {
            rawEvent = {
              id: createEventId(),
              type: 'assistant_delta',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              delta: event.delta,
            }
          }

          if (rawEvent) {
            yield accumulator.push(rawEvent)
          }
        }

        const response = await stream.finalResponse()
        return parseResponse(
          response,
          endpoint,
          ctx.invocationId,
          ctx.agentName,
          accumulator.getAccumulatedText(),
        )
      } finally {
        cleanup?.()
      }
    }

    return yield* withStreamRetry(createStream, {
      config: retryConfig,
      signal,
    })
  }
}

function registerAbortHandler(signal: AbortSignal, handler: () => void): () => void {
  signal.addEventListener('abort', handler)
  return () => signal.removeEventListener('abort', handler)
}

type InputContentPart =
  | {
      type: 'input_text'
      text: string
      prompt_cache_breakpoint?: { mode: 'explicit' }
    }
  | { type: 'input_image'; image_url: string; detail: 'auto' | 'low' | 'high' }
  | { type: 'input_audio'; data: string; format: string }

function isCacheableEvent(event: Event): boolean {
  return Boolean(
    event.providerContext?.provider === 'adk' &&
    (event.providerContext.data as { cacheable?: boolean })?.cacheable,
  )
}

function serializeUserEvent(
  event: UserEvent,
  markCacheBreakpoint = false,
): string | InputContentPart[] {
  if ((!event.media || event.media.length === 0) && !markCacheBreakpoint) {
    return event.text
  }

  const parts: InputContentPart[] = []
  if (event.text) {
    parts.push({
      type: 'input_text',
      text: event.text,
      ...(markCacheBreakpoint && {
        prompt_cache_breakpoint: { mode: 'explicit' as const },
      }),
    })
  } else if (markCacheBreakpoint) {
    parts.push({
      type: 'input_text',
      text: '',
      prompt_cache_breakpoint: { mode: 'explicit' },
    })
  }

  for (const part of event.media ?? []) {
    if (part.type === 'image') {
      if (part.source.type === 'url') {
        parts.push({
          type: 'input_image',
          image_url: part.source.url,
          detail: 'auto',
        })
      } else {
        parts.push({
          type: 'input_image',
          image_url: `data:${part.source.mimeType};base64,${part.source.data}`,
          detail: 'auto',
        })
      }
    } else if (part.type === 'audio') {
      const source = part.source
      const data = source.type === 'url' ? source.url : source.data
      const format = source.type === 'url' ? 'mp3' : source.mimeType.split('/')[1] || 'mp3'
      parts.push({ type: 'input_audio', data, format })
    }
  }

  return parts
}

function asInputContentParts(content: string | InputContentPart[]): InputContentPart[] {
  return typeof content === 'string' ? [{ type: 'input_text', text: content }] : content
}

const OPENAI_CALL_ID_PREFIX = 'fc_'

function normalizeCallId(callId: string): string {
  if (callId.startsWith(OPENAI_CALL_ID_PREFIX)) return callId
  if (callId.startsWith(CALL_ID_PREFIX)) {
    return OPENAI_CALL_ID_PREFIX + callId.slice(CALL_ID_PREFIX.length)
  }
  return OPENAI_CALL_ID_PREFIX + callId
}

function toolOutput(callId: string, output: unknown): ResponseInputItem {
  return {
    type: 'function_call_output',
    call_id: callId,
    output,
  } as ResponseInputItem
}

export function serializeContext(
  ctx: RenderContext,
  options?: { promptCache?: boolean },
): ResponseInputItem[] {
  if (options?.promptCache && !ctx.events.some(isCacheableEvent)) {
    throw new Error('OpenAI explicit prompt caching requires a tagged cacheable context message')
  }

  const items: ResponseInputItem[] = []
  for (let index = 0; index < ctx.events.length; index++) {
    const event = ctx.events[index]
    switch (event.type) {
      case 'system': {
        const marked = Boolean(options?.promptCache && isCacheableEvent(event))
        items.push({
          role: 'system',
          content: marked
            ? [
                {
                  type: 'input_text',
                  text: event.text,
                  prompt_cache_breakpoint: { mode: 'explicit' },
                },
              ]
            : event.text,
        } as ResponseInputItem)
        break
      }
      case 'user': {
        const marked = Boolean(options?.promptCache && isCacheableEvent(event))
        if (!marked) {
          items.push({
            role: 'user',
            content: serializeUserEvent(event),
          } as ResponseInputItem)
          break
        }

        const content = asInputContentParts(serializeUserEvent(event, true))
        const nextEvent = ctx.events[index + 1]
        if (nextEvent?.type === 'user' && !isCacheableEvent(nextEvent)) {
          content.push(...asInputContentParts(serializeUserEvent(nextEvent)))
          index++
        }
        items.push({ role: 'user', content } as ResponseInputItem)
        break
      }
      case 'assistant':
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: event.text }],
        } as ResponseInputItem)
        break
      case 'thought': {
        const providerCtx = getOpenAIContext(event) as ResponseReasoningItem | undefined
        if (providerCtx?.encrypted_content) {
          items.push({
            type: 'reasoning' as const,
            id: providerCtx.id,
            summary: providerCtx.summary,
            encrypted_content: providerCtx.encrypted_content,
          } as ResponseInputItem)
        }
        break
      }
      case 'tool_call': {
        const providerCtx = getOpenAIContext(event) as ResponseFunctionToolCall | undefined
        const callId = providerCtx?.call_id ?? normalizeCallId(event.callId)
        items.push({
          type: 'function_call',
          id: providerCtx?.id ?? callId,
          call_id: callId,
          name: event.name,
          arguments: JSON.stringify(event.args),
        } as ResponseInputItem)
        break
      }
      case 'tool_result': {
        const providerCtx = getOpenAIContext(event) as ResponseFunctionToolCall | undefined
        const callId = providerCtx?.call_id ?? normalizeCallId(event.callId)
        const textOutput = event.error ?? JSON.stringify(event.result)

        if (event.media && event.media.length > 0) {
          const mediaParts: Array<{
            type: 'input_image' | 'input_file'
            image_url?: string
            detail?: 'auto'
            file_data?: string
            filename?: string
          }> = []

          for (const p of event.media) {
            if (p.type === 'image') {
              mediaParts.push({
                type: 'input_image',
                image_url:
                  p.source.type === 'url'
                    ? p.source.url
                    : `data:${p.source.mimeType};base64,${p.source.data}`,
                detail: 'auto',
              })
            } else if (p.type === 'document') {
              mediaParts.push({
                type: 'input_file',
                file_data:
                  p.source.type === 'url'
                    ? p.source.url
                    : `data:${p.source.mimeType};base64,${p.source.data}`,
                filename: 'document.pdf',
              })
            }
          }

          items.push(toolOutput(callId, [{ type: 'input_text', text: textOutput }, ...mediaParts]))
          break
        }

        items.push(toolOutput(callId, textOutput))
        break
      }
      default:
        break
    }
  }
  return items
}

interface OpenAIUsage {
  input_tokens: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens: number
  output_tokens_details?: { reasoning_tokens?: number }
}

interface OpenAIResponse {
  output: ResponseOutputItem[]
  status?: string
  usage?: OpenAIUsage
}

function parseUsage(usage?: OpenAIUsage): ModelUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    outputTokens: usage.output_tokens,
  }
}

function parseFinishReason(status?: string, hasToolCalls?: boolean): ModelEndEvent['finishReason'] {
  if (hasToolCalls) return 'tool_calls'
  if (status === 'completed') return 'stop'
  if (status === 'failed') return 'error'
  if (status === 'incomplete') return 'length'
  return 'stop'
}

export function parseResponse(
  response: OpenAIResponse,
  endpoint: OpenAIEndpoint,
  invocationId: string,
  agentName: string,
  streamedText?: AccumulatedText,
): ModelStepResult {
  const stepEvents: Event[] = []
  const toolCalls: ToolCallEvent[] = []
  const providerName = endpoint.type === 'azure' ? 'azure-openai' : 'openai'

  for (const item of response.output) {
    const createdAt = Date.now()

    if (item.type === 'reasoning') {
      const reasoning = item as ResponseReasoningItem
      const summaryText =
        reasoning.summary
          ?.filter((s) => s.type === 'summary_text')
          .map((s) => s.text)
          .join('\n') ?? ''
      const text = summaryText || streamedText?.thoughtText || ''
      stepEvents.push({
        id: createEventId(),
        type: 'thought',
        createdAt,
        invocationId,
        agentName,
        text,
        providerContext: { provider: providerName, data: reasoning },
      } as Event)
    }

    if (item.type === 'function_call') {
      const fn = item as ResponseFunctionToolCall
      const toolCall: ToolCallEvent = {
        id: createEventId(),
        type: 'tool_call',
        createdAt,
        invocationId,
        agentName,
        callId: createCallId(),
        name: fn.name,
        args: JSON.parse(fn.arguments) as Record<string, unknown>,
        providerContext: { provider: providerName, data: fn },
      }
      stepEvents.push(toolCall)
      toolCalls.push(toolCall)
    }

    if (item.type === 'message') {
      const msg = item as ResponseOutputMessage
      const text = msg.content
        ?.filter((c) => c.type === 'output_text')
        .map((c) => (c as { text: string }).text)
        .join('\n')
      if (text) {
        stepEvents.push({
          id: createEventId(),
          type: 'assistant',
          createdAt,
          invocationId,
          agentName,
          text,
          providerContext: { provider: providerName, data: msg },
        } as Event)
      }
    }
  }

  return {
    stepEvents,
    toolCalls,
    terminal: toolCalls.length === 0,
    usage: parseUsage(response.usage),
    finishReason: parseFinishReason(response.status, toolCalls.length > 0),
  }
}

export function serializeTools(
  functionTools: readonly FunctionTool[],
  providerTools?: readonly ProviderTool[],
) {
  const serializedFunctionTools = functionTools.map((t) => {
    const fn = zodResponsesFunction({
      name: t.name,
      description: t.description,
      parameters: normalizeSchema(t.schema as z.ZodType, t.name),
    })
    return {
      type: 'function' as const,
      name: fn.name,
      description: fn.description ?? t.description,
      parameters: fn.parameters ?? {},
      strict: true,
    }
  })

  const serializedProviderTools = (providerTools ?? []).map((pt) => {
    if (pt.type === 'web_search') {
      return {
        type: 'web_search' as const,
        ...(pt.searchContextSize && {
          search_context_size: pt.searchContextSize,
        }),
        ...(pt.userLocation && { user_location: pt.userLocation }),
      }
    }
    return pt
  })

  return [...serializedFunctionTools, ...serializedProviderTools]
}

function getOpenAIContext(event: Pick<Event, 'providerContext'>): ResponseOutputItem | undefined {
  const provider = event.providerContext?.provider
  if (provider === 'openai' || provider === 'azure-openai') {
    return event.providerContext?.data as ResponseOutputItem
  }
  return undefined
}

export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }
  | {
      type: 'allowed_tools'
      mode: 'auto' | 'required'
      tools: Array<{ type: 'function'; name: string }>
    }

export function serializeToolChoice(
  choice: ToolChoice | undefined,
  allowedTools?: readonly string[],
): OpenAIToolChoice | undefined {
  if (allowedTools && allowedTools.length > 0) {
    const mode = choice === 'required' ? 'required' : 'auto'
    return {
      type: 'allowed_tools',
      mode,
      tools: allowedTools.map((name) => ({ type: 'function', name })),
    }
  }
  if (!choice) return undefined
  if (typeof choice === 'string') return choice
  return { type: 'function', name: choice.name }
}
