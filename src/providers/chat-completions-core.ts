import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'

import OpenAI, { APIConnectionError, APIError } from 'openai'
import { z } from 'zod'

import type { Event, ModelUsage, StreamEvent, ToolCallEvent } from '../types/events'
import type {
  EurouterModel,
  ChatCompletionsModel,
  ModelAdapter,
  ModelStepResult,
  ProviderModelConfig,
  RenderContext,
} from '../types/runnables'

import { createCallId, createEventId } from '../session'
import { normalizeSchema } from './normalizeSchema'
import { zodToToolSchema } from './zodToJsonSchema'

type ChatModel = EurouterModel | ChatCompletionsModel

export type ChatCompletionsCoreOptions = {
  label: string
  client: OpenAI
  requestMetadata?: { provider: Record<string, unknown> }
} & ({ provider: 'eurouter' } | { provider: 'chat-completions'; endpoint: string })

const chatTemplateSchema = z.strictObject({
  enable_thinking: z.boolean().optional(),
  preserve_thinking: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
})

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
})
const reasoningDetailsSchema = z.array(z.object({ type: z.string() }).catchall(z.unknown()))
const continuationSchema = z.object({
  completionId: z.string(),
  scope: z.string().optional(),
  reasoning: z.string().optional(),
  reasoning_content: z.string().optional(),
  reasoning_details: reasoningDetailsSchema.optional(),
})
const toolContinuationSchema = continuationSchema.extend({ callId: z.string().min(1) })
const tokenCount = z.number().int().nonnegative()
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  prompt_tokens_details: z.object({ cached_tokens: tokenCount.optional() }).nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: tokenCount.optional() }).nullish(),
  cost: z.number().nonnegative().optional(),
  cost_currency: z.string().optional(),
})
const chunkSchema = z.object({
  id: z.string(),
  model: z.string().min(1),
  provider: z.string().optional(),
  usage: usageSchema.nullish(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      finish_reason: z.string().nullable(),
      delta: z.object({
        content: z.string().nullish(),
        reasoning: z.string().nullish(),
        reasoning_content: z.string().nullish(),
        reasoning_details: reasoningDetailsSchema.nullish(),
        refusal: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().nonnegative(),
              id: z.string().nullish(),
              type: z.literal('function').optional(),
              function: z
                .object({ name: z.string().nullish(), arguments: z.string().optional() })
                .nullish(),
            }),
          )
          .nullish(),
      }),
    }),
  ),
})

type AssistantMessage = ChatCompletionAssistantMessageParam & {
  reasoning?: string
  reasoning_content?: string
  reasoning_details?: z.infer<typeof reasoningDetailsSchema>
}

type Continuation = z.infer<typeof continuationSchema>

function continuationFor(
  event: Event,
  provider: ChatModel['provider'],
  scope: string | undefined,
): Continuation | undefined {
  const context =
    (event.type === 'assistant' || event.type === 'thought' || event.type === 'tool_call') &&
    event.providerContext?.provider === provider
      ? continuationSchema.parse(event.providerContext.data)
      : undefined
  return context && (provider === 'eurouter' || context.scope === scope) ? context : undefined
}

/** Replays an event produced by this provider into the assistant message it came from. */
function appendToCompletion(
  event: Event,
  context: Continuation,
  messages: ChatCompletionMessageParam[],
  completions: Map<string, AssistantMessage>,
  wireCallIds: Map<string, string>,
): void {
  let message = completions.get(context.completionId)
  if (!message) {
    message = { role: 'assistant', content: null }
    completions.set(context.completionId, message)
    messages.push(message)
  }
  if (event.type === 'assistant') message.content = event.text
  if (event.type === 'thought') {
    if (context.reasoning !== undefined) message.reasoning = context.reasoning
    if (context.reasoning_content !== undefined)
      message.reasoning_content = context.reasoning_content
    if (context.reasoning_details !== undefined)
      message.reasoning_details = context.reasoning_details
  }
  if (event.type === 'tool_call') {
    const wire = toolContinuationSchema.parse(event.providerContext?.data)
    wireCallIds.set(event.callId, wire.callId)
    message.tool_calls = [
      ...(message.tool_calls ?? []),
      {
        id: wire.callId,
        type: 'function',
        function: { name: event.name, arguments: JSON.stringify(event.args) },
      },
    ]
  }
}

function appendPlainEvent(
  event: Event,
  messages: ChatCompletionMessageParam[],
  wireCallIds: Map<string, string>,
): void {
  switch (event.type) {
    case 'system':
    case 'user':
      messages.push({ role: event.type, content: event.text })
      break
    case 'assistant':
      messages.push({ role: 'assistant', content: event.text })
      break
    case 'tool_call': {
      const call = {
        id: event.callId,
        type: 'function' as const,
        function: { name: event.name, arguments: JSON.stringify(event.args) },
      }
      const previous = messages.at(-1)
      if (previous?.role === 'assistant') {
        previous.tool_calls = [...(previous.tool_calls ?? []), call]
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] })
      }
      break
    }
    case 'tool_result':
      messages.push({
        role: 'tool',
        tool_call_id: wireCallIds.get(event.callId) ?? event.callId,
        content: event.error ?? JSON.stringify(event.result) ?? 'null',
      })
      break
  }
}

function messagesFor(
  ctx: RenderContext,
  provider: ChatModel['provider'],
  label: string,
  scope: string | undefined,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = []
  const completions = new Map<string, AssistantMessage>()
  const wireCallIds = new Map<string, string>()
  for (const event of ctx.events) {
    if ('media' in event && event.media?.length) {
      throw new Error(`${label} currently supports text context only`)
    }
    const context = continuationFor(event, provider, scope)
    if (context) {
      appendToCompletion(event, context, messages, completions, wireCallIds)
      continue
    }
    appendPlainEvent(event, messages, wireCallIds)
  }
  return messages
}

function requestFor(
  ctx: RenderContext,
  config: ChatModel,
  label: string,
  scope: string | undefined,
) {
  if (ctx.providerTools.length)
    throw new Error(`${label} does not support ADK provider-native tools`)
  const choice = ctx.toolChoice ?? ctx.agent.toolChoice
  const toolChoice: ChatCompletionToolChoiceOption | undefined =
    typeof choice === 'object' ? { type: 'function', function: { name: choice.name } } : choice
  const allowedTools = ctx.allowedTools && new Set(ctx.allowedTools)
  const tools = ctx.functionTools.flatMap((tool) =>
    allowedTools && !allowedTools.has(tool.name)
      ? []
      : [
          {
            type: 'function' as const,
            function: {
              ...zodToToolSchema(
                tool.name,
                tool.description ?? '',
                normalizeSchema(tool.schema, tool.name),
              ),
              strict: true,
            },
          },
        ],
  )
  // Compatible servers support effort values beyond the OpenAI SDK's enum.
  const extensions: Record<string, unknown> =
    config.provider === 'chat-completions'
      ? {
          ...(config.reasoningEffort && { reasoning_effort: config.reasoningEffort }),
          ...(config.chatTemplate && {
            chat_template_kwargs: chatTemplateSchema.parse(config.chatTemplate),
          }),
        }
      : {}
  return {
    model: config.name,
    messages: messagesFor(ctx, config.provider, label, scope),
    stream: true as const,
    stream_options: { include_usage: true },
    ...(tools.length > 0 && { tools }),
    ...(toolChoice && { tool_choice: toolChoice }),
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.maxTokens !== undefined && { max_tokens: config.maxTokens }),
    ...(config.provider === 'eurouter' && config.reasoning && { reasoning: config.reasoning }),
    ...extensions,
    ...(ctx.outputSchema &&
      ctx.outputMode !== 'prompt' && {
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: 'output_schema',
            strict: true,
            schema: zodToToolSchema(
              'output_schema',
              '',
              normalizeSchema(ctx.outputSchema, 'output_schema'),
            ).parameters,
          },
        },
      }),
  }
}

function retryable(error: unknown): boolean {
  return (
    error instanceof APIConnectionError ||
    (error instanceof APIError &&
      error.status !== undefined &&
      (error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500))
  )
}

type ReasoningDetails = z.infer<typeof reasoningDetailsSchema>
type ChatChunk = z.infer<typeof chunkSchema>
type ChatChoice = ChatChunk['choices'][number]
type ChatDelta = ChatChoice['delta']
type WireToolCall = z.infer<typeof toolCallSchema>
type EventBase = { invocationId: string; agentName: string }

/** Mutable state accumulated while one completion stream is read. */
type StreamAccumulator = {
  started: boolean
  text: string
  reasoning: string | undefined
  reasoningContent: string | undefined
  reasoningDetails: ReasoningDetails
  modelName: string
  servingProvider: string | undefined
  finishReason: string | undefined
  usage: ModelUsage | undefined
  calls: Map<number, { id: string; name: string; arguments: string }>
}

function createStreamAccumulator(modelName: string): StreamAccumulator {
  return {
    started: false,
    text: '',
    reasoning: undefined,
    reasoningContent: undefined,
    reasoningDetails: [],
    modelName,
    servingProvider: undefined,
    finishReason: undefined,
    usage: undefined,
    calls: new Map(),
  }
}

async function continuationScope(
  options: ChatCompletionsCoreOptions,
  config: ChatModel,
): Promise<string | undefined> {
  if (options.provider !== 'chat-completions' || config.provider !== 'chat-completions') {
    return undefined
  }
  const identity = JSON.stringify([
    options.endpoint,
    config.adapter ?? 'chat-completions',
    config.name,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseChunk(raw: unknown, label: string): ChatChunk {
  const parsed = chunkSchema.safeParse(raw)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`)
    throw new Error(`Invalid ${label} stream response (${fields.join(', ')})`)
  }
  return parsed.data
}

function usageFromChunk(
  usage: NonNullable<ChatChunk['usage']>,
  provider: ChatModel['provider'],
  requestedModelName: string,
  modelName: string,
): ModelUsage {
  return {
    provider,
    requestedModelName,
    modelName,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined && {
      cachedTokens: usage.prompt_tokens_details.cached_tokens,
    }),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined && {
      reasoningTokens: usage.completion_tokens_details.reasoning_tokens,
    }),
    ...(usage.cost !== undefined &&
      usage.cost_currency === 'USD' && {
        reportedCostUSD: usage.cost,
      }),
  }
}

function deltaStartsResponse(delta: ChatDelta): boolean {
  return Boolean(
    delta.content ||
    delta.reasoning != null ||
    delta.reasoning_content != null ||
    delta.reasoning_details?.length ||
    delta.tool_calls?.length,
  )
}

function accumulateToolCallFragments(acc: StreamAccumulator, delta: ChatDelta): void {
  for (const fragment of delta.tool_calls ?? []) {
    const call = acc.calls.get(fragment.index) ?? { id: '', name: '', arguments: '' }
    call.id += fragment.id ?? ''
    call.name += fragment.function?.name ?? ''
    call.arguments += fragment.function?.arguments ?? ''
    acc.calls.set(fragment.index, call)
  }
}

function* choiceDeltaEvents(
  choice: ChatChoice,
  acc: StreamAccumulator,
  base: EventBase,
  label: string,
): Generator<StreamEvent> {
  if (choice.index !== 0) throw new Error(`${label} returned unexpected choices`)
  if (choice.delta.refusal) throw new Error(`${label} refused the request`)
  const delta = choice.delta
  if (deltaStartsResponse(delta)) {
    acc.started = true
  }
  if (delta.content) {
    acc.text += delta.content
    yield {
      ...base,
      id: createEventId(),
      createdAt: Date.now(),
      type: 'assistant_delta',
      delta: delta.content,
      text: acc.text,
    }
  }
  acc.reasoningDetails.push(...(delta.reasoning_details ?? []))
  if (delta.reasoning != null || delta.reasoning_content != null) {
    const thought = delta.reasoning ?? delta.reasoning_content ?? ''
    if (delta.reasoning != null) acc.reasoning = (acc.reasoning ?? '') + delta.reasoning
    if (delta.reasoning_content != null)
      acc.reasoningContent = (acc.reasoningContent ?? '') + delta.reasoning_content
    yield {
      ...base,
      id: createEventId(),
      createdAt: Date.now(),
      type: 'thought_delta',
      delta: thought,
      text: acc.reasoning || acc.reasoningContent || '',
    }
  }
  accumulateToolCallFragments(acc, delta)
  acc.finishReason = choice.finish_reason ?? acc.finishReason
}

/** Checks the finished stream and returns its tool calls in index order. */
function completedWireCalls(
  acc: StreamAccumulator,
  label: string,
  advertisedToolNames: readonly string[] | undefined,
): { finishReason: 'stop' | 'tool_calls'; wireCalls: WireToolCall[] } {
  const { finishReason, calls } = acc
  if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
    throw new Error(
      `${label} did not complete the response (${finishReason ?? 'incomplete stream'})`,
    )
  }
  if (!acc.text && calls.size === 0) throw new Error(`${label} returned an empty response`)
  if ((finishReason === 'tool_calls') !== calls.size > 0) {
    throw new Error(`${label} returned inconsistent tool completion`)
  }
  const wireCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) =>
      toolCallSchema.parse({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }),
    )
  if (new Set(wireCalls.map((call) => call.id)).size !== wireCalls.length) {
    throw new Error(`${label} returned duplicate tool call IDs`)
  }
  const advertisedTools = new Set(advertisedToolNames)
  const unadvertised = wireCalls.find((call) => !advertisedTools.has(call.function.name))
  if (unadvertised) {
    throw new Error(
      `${label} returned an unadvertised tool ${JSON.stringify(unadvertised.function.name.slice(0, 128))}; allowed tools: ${[...advertisedTools].join(', ') || '(none)'}`,
    )
  }
  return { finishReason, wireCalls }
}

function thoughtStepEvents(
  acc: StreamAccumulator,
  eventBase: EventBase & { createdAt: number },
  provider: ChatModel['provider'],
  continuation: { completionId: string; scope?: string },
): Event[] {
  const { reasoning, reasoningContent, reasoningDetails } = acc
  if (reasoning === undefined && reasoningContent === undefined && !reasoningDetails.length) {
    return []
  }
  return [
    {
      ...eventBase,
      id: createEventId(),
      type: 'thought' as const,
      text: reasoning || reasoningContent || '',
      providerContext: {
        provider,
        data: {
          ...continuation,
          ...(reasoning !== undefined && { reasoning }),
          ...(reasoningContent !== undefined && {
            reasoning_content: reasoningContent,
          }),
          ...(reasoningDetails.length && { reasoning_details: reasoningDetails }),
        },
      },
    },
  ]
}

function buildStepResult(
  acc: StreamAccumulator,
  { finishReason, wireCalls }: { finishReason: 'stop' | 'tool_calls'; wireCalls: WireToolCall[] },
  base: EventBase,
  provider: ChatModel['provider'],
  completionId: string,
  scope: string | undefined,
): ModelStepResult {
  const { text, usage, modelName, servingProvider } = acc
  const continuation = { completionId, ...(scope && { scope }) }
  const providerContext = { provider, data: continuation }
  const eventBase = { ...base, createdAt: Date.now(), providerContext }
  const toolCalls: ToolCallEvent[] = wireCalls.map((call) => ({
    ...eventBase,
    id: createEventId(),
    type: 'tool_call',
    callId: createCallId(),
    providerContext: { provider, data: { ...continuation, callId: call.id } },
    name: call.function.name,
    args: z.record(z.string(), z.unknown()).parse(JSON.parse(call.function.arguments)),
  }))
  const stepEvents: Event[] = [
    ...thoughtStepEvents(acc, eventBase, provider, continuation),
    ...(text ? [{ ...eventBase, id: createEventId(), type: 'assistant' as const, text }] : []),
    ...toolCalls,
  ]
  return {
    stepEvents,
    toolCalls,
    terminal: toolCalls.length === 0,
    finishReason,
    ...(usage && {
      usage: { ...usage, modelName, ...(servingProvider && { servingProvider }) },
    }),
  }
}

function mustRethrow(
  error: unknown,
  config: ChatModel,
  signal: AbortSignal | undefined,
  started: boolean,
  attempt: number,
  attempts: number,
): boolean {
  return Boolean(
    signal?.aborted ||
    started ||
    attempt === attempts ||
    !retryable(error) ||
    (error instanceof Error &&
      config.retry?.retryableErrors &&
      !config.retry.retryableErrors(error)),
  )
}

function waitBeforeRetry(
  retry: NonNullable<ChatModel['retry']>,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      },
      Math.min(retry.initialDelayMs * retry.backoffMultiplier ** (attempt - 1), retry.maxDelayMs),
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export class ChatCompletionsCore implements ModelAdapter {
  constructor(private readonly options: ChatCompletionsCoreOptions) {}

  async *step(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const { provider, label, client, requestMetadata } = this.options
    if (
      (config.provider !== 'eurouter' && config.provider !== 'chat-completions') ||
      config.provider !== provider
    ) {
      throw new Error(`${label} requires a ${provider} model`)
    }
    const scope = await continuationScope(this.options, config)
    const request = { ...requestFor(ctx, config, label, scope), ...requestMetadata }
    const attempts = config.retry?.maxAttempts ?? 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted()
      const acc = createStreamAccumulator(config.name)
      try {
        const stream = await client.chat.completions.create(request, { signal })
        const completionId = createEventId()
        const base = { invocationId: ctx.invocationId, agentName: ctx.agentName }
        try {
          for await (const raw of stream) {
            signal?.throwIfAborted()
            const chunk = parseChunk(raw, label)
            acc.modelName = chunk.model
            acc.servingProvider = chunk.provider ?? acc.servingProvider
            if (chunk.usage) {
              acc.usage = usageFromChunk(chunk.usage, provider, config.name, acc.modelName)
            }
            for (const choice of chunk.choices) {
              yield* choiceDeltaEvents(choice, acc, base, label)
            }
          }
        } finally {
          stream.controller.abort()
        }
        signal?.throwIfAborted()
        const completed = completedWireCalls(
          acc,
          label,
          request.tools?.map((tool) => tool.function.name),
        )
        return buildStepResult(acc, completed, base, provider, completionId, scope)
      } catch (error) {
        if (mustRethrow(error, config, signal, acc.started, attempt, attempts)) {
          throw error
        }
        const retry = config.retry
        if (!retry) throw error
        await waitBeforeRetry(retry, attempt, signal)
      }
    }
    throw new Error(`${label} retry maxAttempts must be positive`)
  }
}
