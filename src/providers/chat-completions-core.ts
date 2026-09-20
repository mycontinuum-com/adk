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

const chatTemplateSchema = z
  .object({
    enable_thinking: z.boolean().optional(),
    preserve_thinking: z.boolean().optional(),
    reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  })
  .strict()

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
})
const reasoningDetailsSchema = z.array(z.object({ type: z.string() }).passthrough())
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
              id: z.string().optional(),
              type: z.literal('function').optional(),
              function: z
                .object({ name: z.string().optional(), arguments: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    }),
  ),
})

type AssistantMessage = ChatCompletionAssistantMessageParam & {
  reasoning?: string
  reasoning_content?: string
  reasoning_details?: z.infer<typeof reasoningDetailsSchema>
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
    const context =
      (event.type === 'assistant' || event.type === 'thought' || event.type === 'tool_call') &&
      event.providerContext?.provider === provider
        ? continuationSchema.parse(event.providerContext.data)
        : undefined
    if (context && (provider === 'eurouter' || context.scope === scope)) {
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
      continue
    }
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
  const tools = ctx.functionTools
    .filter((tool) => !ctx.allowedTools || ctx.allowedTools.includes(tool.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        ...zodToToolSchema(
          tool.name,
          tool.description ?? '',
          normalizeSchema(tool.schema, tool.name),
        ),
        strict: true,
      },
    }))
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
    let scope: string | undefined
    if (this.options.provider === 'chat-completions' && config.provider === 'chat-completions') {
      const identity = JSON.stringify([
        this.options.endpoint,
        config.adapter ?? 'chat-completions',
        config.name,
      ])
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
      scope = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      )
    }
    const request = { ...requestFor(ctx, config, label, scope), ...requestMetadata }
    const attempts = config.retry?.maxAttempts ?? 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted()
      let started = false
      try {
        const stream = await client.chat.completions.create(request, { signal })
        let text = ''
        let reasoning: string | undefined
        let reasoningContent: string | undefined
        const reasoningDetails: z.infer<typeof reasoningDetailsSchema> = []
        let modelName = config.name
        const completionId = createEventId()
        let servingProvider: string | undefined
        let finishReason: string | undefined
        let usage: ModelUsage | undefined
        const calls = new Map<number, { id: string; name: string; arguments: string }>()
        const base = { invocationId: ctx.invocationId, agentName: ctx.agentName }
        try {
          for await (const raw of stream) {
            signal?.throwIfAborted()
            const parsed = chunkSchema.safeParse(raw)
            if (!parsed.success) throw new Error(`Invalid ${label} stream response`)
            const chunk = parsed.data
            modelName = chunk.model
            servingProvider = chunk.provider ?? servingProvider
            if (chunk.usage) {
              usage = {
                provider,
                requestedModelName: config.name,
                modelName,
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined && {
                  cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens,
                }),
                ...(chunk.usage.completion_tokens_details?.reasoning_tokens !== undefined && {
                  reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens,
                }),
                ...(chunk.usage.cost !== undefined &&
                  chunk.usage.cost_currency === 'USD' && {
                    reportedCostUSD: chunk.usage.cost,
                  }),
              }
            }
            for (const choice of chunk.choices) {
              if (choice.index !== 0) throw new Error(`${label} returned unexpected choices`)
              if (choice.delta.refusal) throw new Error(`${label} refused the request`)
              const delta = choice.delta
              if (
                delta.content ||
                delta.reasoning != null ||
                delta.reasoning_content != null ||
                delta.reasoning_details?.length ||
                delta.tool_calls?.length
              ) {
                started = true
              }
              if (delta.content) {
                text += delta.content
                yield {
                  ...base,
                  id: createEventId(),
                  createdAt: Date.now(),
                  type: 'assistant_delta',
                  delta: delta.content,
                  text,
                }
              }
              reasoningDetails.push(...(delta.reasoning_details ?? []))
              if (delta.reasoning != null || delta.reasoning_content != null) {
                const thought = delta.reasoning ?? delta.reasoning_content ?? ''
                if (delta.reasoning != null) reasoning = (reasoning ?? '') + delta.reasoning
                if (delta.reasoning_content != null)
                  reasoningContent = (reasoningContent ?? '') + delta.reasoning_content
                yield {
                  ...base,
                  id: createEventId(),
                  createdAt: Date.now(),
                  type: 'thought_delta',
                  delta: thought,
                  text: reasoning || reasoningContent || '',
                }
              }
              for (const fragment of delta.tool_calls ?? []) {
                const call = calls.get(fragment.index) ?? { id: '', name: '', arguments: '' }
                call.id += fragment.id ?? ''
                call.name += fragment.function?.name ?? ''
                call.arguments += fragment.function?.arguments ?? ''
                calls.set(fragment.index, call)
              }
              finishReason = choice.finish_reason ?? finishReason
            }
          }
        } finally {
          stream.controller.abort()
        }
        signal?.throwIfAborted()
        if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
          throw new Error(
            `${label} did not complete the response (${finishReason ?? 'incomplete stream'})`,
          )
        }
        if (!text && calls.size === 0) throw new Error(`${label} returned an empty response`)
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
        const advertisedTools = new Set(request.tools?.map((tool) => tool.function.name))
        if (wireCalls.some((call) => !advertisedTools.has(call.function.name))) {
          throw new Error(`${label} returned an unadvertised tool`)
        }
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
          ...(reasoning !== undefined || reasoningContent !== undefined || reasoningDetails.length
            ? [
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
            : []),
          ...(text
            ? [{ ...eventBase, id: createEventId(), type: 'assistant' as const, text }]
            : []),
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
      } catch (error) {
        if (
          signal?.aborted ||
          started ||
          attempt === attempts ||
          !retryable(error) ||
          (error instanceof Error &&
            config.retry?.retryableErrors &&
            !config.retry.retryableErrors(error))
        ) {
          throw error
        }
        const retry = config.retry
        if (!retry) throw error
        await new Promise<void>((resolve, reject) => {
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
            Math.min(
              retry.initialDelayMs * retry.backoffMultiplier ** (attempt - 1),
              retry.maxDelayMs,
            ),
          )
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      }
    }
    throw new Error(`${label} retry maxAttempts must be positive`)
  }
}
