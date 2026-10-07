import type {
  Response as ProviderResponse,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses'

import OpenAI, { AzureOpenAI, NotFoundError } from 'openai'
import { z } from 'zod'

import type { Answer, DecisionRequest, DecisionResponse } from '../types/decisions'
import type {
  Event,
  StreamEvent,
  ToolCallEvent,
  ModelUsage,
  ModelEndEvent,
  UserEvent,
  MediaPart,
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
import { DecisionsUnavailableError } from '../errors/types'
import { createEventId, createCallId } from '../session'
import { createStreamAccumulator, type RawDeltaEvent, type AccumulatedText } from './accumulator'
import {
  type OpenAIEndpoint,
  getDefaultEndpoints,
  resolveModelName,
  isRetryableForFallback,
} from './openai-endpoints'
import { zodToToolSchema } from './zodToJsonSchema'

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

/**
 * `parallel_tool_calls: false` when the agent's config explicitly turns it off; otherwise nothing,
 * leaving the Responses API's own default (`true`) in place.
 */
export function serializeParallelToolCallsOption(
  config: ProviderModelConfig,
): { parallel_tool_calls: false } | Record<string, never> {
  if (config.provider !== 'openai' || config.parallelToolCalls !== false) return {}
  return { parallel_tool_calls: false }
}

function createEndpointKey(endpoint: OpenAIEndpoint, model?: string): string {
  return `${endpoint.type}:${endpoint.baseUrl ?? 'default'}:${
    endpoint.apiVersion ?? ''
  }:${model ?? ''}`
}

class PrematureOpenAIStreamError extends Error {}

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

  /**
   * Answers a decision on the Decisions API (`POST /decisions`) of the first OpenAI endpoint that
   * serves the model. Azure endpoints are skipped. After a rate limit, a timeout or a server error
   * the next endpoint is asked.
   *
   * @throws {DecisionsUnavailableError} When an endpoint answers 404 for the model, or every
   *   endpoint is an Azure deployment. The input is not sent to a further endpoint after a 404.
   * @throws The provider's error for any other failure, and an `Error` for a response that is not a
   *   decisions response.
   */
  async decide(
    request: DecisionRequest,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): Promise<DecisionResponse> {
    let failure: unknown

    for (const endpoint of this.endpoints) {
      // The Decisions API is an OpenAI platform route. An Azure deployment has none.
      if (endpoint.type === 'azure') continue
      const { client, resolvedModel } = this.getOrCreateClient(endpoint, config.name)
      try {
        // The pinned SDK predates `client.decisions`, so the request goes through its generic path.
        const body = await client.post<unknown>('/decisions', {
          body: {
            model: resolvedModel,
            input: request.input,
            questions: Object.entries(request.questions).map(([name, question]) => ({
              name,
              ...question,
            })),
          },
          signal,
        })
        return parseDecisionResponse(body)
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new DecisionsUnavailableError(config, { cause: error })
        }
        if (!isRetryableForFallback(error)) throw error
        failure = error
      }
    }

    if (failure) throw failure
    throw new DecisionsUnavailableError(config)
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
    const retryConfig = (config.provider === 'openai' ? config.retry : undefined) ?? {
      maxAttempts: 2,
      initialDelayMs: 250,
      maxDelayMs: 250,
      backoffMultiplier: 1,
      retryableErrors: (error: Error) => error instanceof PrematureOpenAIStreamError,
    }
    let emitted = false
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
        ...samplingOptions(config, reasoning),
        ...serializeParallelToolCallsOption(config),
        ...(reasoning && {
          reasoning,
          include: ['reasoning.encrypted_content'],
        }),
        ...(useNativeStructuredOutput && {
          text: {
            format: serializeOutputSchema(ctx.outputSchema!),
          },
        }),
      } as Parameters<typeof client.responses.stream>[0]
      const stream = client.responses.stream(request)

      const cleanup = signal ? registerAbortHandler(signal, () => stream.abort()) : undefined

      const accumulator = createStreamAccumulator()
      let terminalResponse: ProviderResponse | undefined

      type OpenAIStreamEvent = typeof stream extends AsyncIterable<infer E> ? E : never
      const deltaEventFor = (event: OpenAIStreamEvent): RawDeltaEvent | null => {
        if (event.type === 'response.reasoning_summary_text.delta') {
          return {
            id: createEventId(),
            type: 'thought_delta',
            createdAt: Date.now(),
            invocationId: ctx.invocationId,
            agentName: ctx.agentName,
            delta: event.delta,
          }
        } else if (event.type === 'response.output_text.delta') {
          return {
            id: createEventId(),
            type: 'assistant_delta',
            createdAt: Date.now(),
            invocationId: ctx.invocationId,
            agentName: ctx.agentName,
            delta: event.delta,
          }
        }
        return null
      }

      try {
        for await (const event of stream) {
          if (signal?.aborted) {
            throw new Error('Aborted')
          }

          if (
            event.type === 'response.completed' ||
            event.type === 'response.incomplete' ||
            event.type === 'response.failed'
          )
            terminalResponse = event.response

          const rawEvent = deltaEventFor(event)

          if (rawEvent) {
            emitted = true
            yield accumulator.push(rawEvent)
          }
        }

        await stream.finalResponse()
        if (!terminalResponse)
          throw new PrematureOpenAIStreamError('OpenAI stream ended without a terminal response')
        if (terminalResponse.status === 'failed') throw new Error('OpenAI response failed')
        return parseResponse(
          terminalResponse,
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
      config: {
        ...retryConfig,
        retryableErrors: (error) => !emitted && (retryConfig.retryableErrors?.(error) ?? true),
      },
      signal,
    })
  }
}

// Active OpenAI reasoning rejects temperature. Explicit effort none
// allows sampling on models that support disabling reasoning.
// Do not infer reasoning settings from a sampling parameter.
function samplingOptions(config: ProviderModelConfig, reasoning: { effort?: string } | undefined) {
  return {
    ...(config.temperature != null &&
      (!reasoning || reasoning.effort === 'none') && { temperature: config.temperature }),
    ...(config.maxTokens != null && { max_output_tokens: config.maxTokens }),
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

function serializeSystemItem(
  event: Extract<Event, { type: 'system' }>,
  promptCache: boolean | undefined,
): ResponseInputItem {
  const marked = Boolean(promptCache && isCacheableEvent(event))
  return {
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
  } as ResponseInputItem
}

/**
 * Serializes the user event at `index`. A cacheable user message absorbs the following uncached
 * user message; `consumed` says how many events were used.
 */
function serializeUserItem(
  events: RenderContext['events'],
  index: number,
  event: UserEvent,
  promptCache: boolean | undefined,
): { item: ResponseInputItem; consumed: number } {
  const marked = Boolean(promptCache && isCacheableEvent(event))
  if (!marked) {
    return {
      item: {
        role: 'user',
        content: serializeUserEvent(event),
      } as ResponseInputItem,
      consumed: 1,
    }
  }

  const content = asInputContentParts(serializeUserEvent(event, true))
  const nextEvent = events[index + 1]
  let consumed = 1
  if (nextEvent?.type === 'user' && !isCacheableEvent(nextEvent)) {
    content.push(...asInputContentParts(serializeUserEvent(nextEvent)))
    consumed = 2
  }
  return { item: { role: 'user', content } as ResponseInputItem, consumed }
}

type ToolResultMediaPart = {
  type: 'input_image' | 'input_file'
  image_url?: string
  detail?: 'auto'
  file_data?: string
  filename?: string
}

function toolResultMediaParts(media: MediaPart[]): ToolResultMediaPart[] {
  const mediaParts: ToolResultMediaPart[] = []
  for (const p of media) {
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
  return mediaParts
}

function serializeToolResultItem(
  event: Extract<Event, { type: 'tool_result' }>,
): ResponseInputItem {
  const providerCtx = getOpenAIContext(event) as ResponseFunctionToolCall | undefined
  const callId = providerCtx?.call_id ?? normalizeCallId(event.callId)
  const textOutput = event.error ?? JSON.stringify(event.result)

  if (event.media && event.media.length > 0) {
    const mediaParts = toolResultMediaParts(event.media)
    return toolOutput(callId, [{ type: 'input_text', text: textOutput }, ...mediaParts])
  }

  return toolOutput(callId, textOutput)
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
      case 'system':
        items.push(serializeSystemItem(event, options?.promptCache))
        break
      case 'user': {
        const { item, consumed } = serializeUserItem(ctx.events, index, event, options?.promptCache)
        index += consumed - 1
        items.push(item)
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
      case 'tool_result':
        items.push(serializeToolResultItem(event))
        break
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

const decisionResponseSchema = z.object({
  answers: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('refusal'), name: z.string() }),
      z.object({ type: z.literal('predicate'), name: z.string(), probability: z.number() }),
      z.object({
        type: z.literal('choice'),
        name: z.string(),
        choice: z.string(),
        confidence: z.number(),
        probabilities: z.array(z.object({ value: z.string(), probability: z.number() })),
      }),
      z.object({
        type: z.literal('score'),
        name: z.string(),
        score: z.number(),
        confidence: z.number(),
      }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number(),
      input_tokens_details: z
        .object({ cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional() })
        .optional(),
      output_tokens: z.number(),
      output_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
    })
    .optional(),
})

/**
 * Parses a `POST /decisions` response body into its answers, keyed by question name.
 *
 * @throws When the body is not a decisions response, or answers a question twice.
 */
export function parseDecisionResponse(body: unknown): DecisionResponse {
  const parsed = decisionResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`OpenAI decisions response has an unrecognised shape: ${parsed.error.message}`)
  }

  const named = parsed.data.answers.map(({ name, ...answer }): [string, Answer] => [name, answer])
  const names = named.map(([name]) => name)
  const twice = names.find((name, index) => names.indexOf(name) !== index)
  if (twice !== undefined) {
    throw new Error(`OpenAI decisions response answers '${twice}' more than once`)
  }
  // `Object.fromEntries` makes every name an own property, a question named `__proto__` included.
  return { answers: Object.fromEntries(named), usage: parseUsage(parsed.data.usage) }
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
        reasoning.summary?.flatMap((s) => (s.type === 'summary_text' ? [s.text] : [])).join('\n') ??
        ''
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
        ?.flatMap((c) => (c.type === 'output_text' ? [c.text] : []))
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

export function serializeOutputSchema(schema: NonNullable<RenderContext['outputSchema']>) {
  return {
    type: 'json_schema' as const,
    name: 'output_schema',
    strict: true,
    schema: zodToToolSchema('output_schema', '', schema).parameters,
  }
}

export function serializeTools(
  functionTools: readonly FunctionTool[],
  providerTools?: readonly ProviderTool[],
) {
  const serializedFunctionTools = functionTools.map((t) => {
    const fn = zodToToolSchema(t.name, t.description, t.schema)
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
