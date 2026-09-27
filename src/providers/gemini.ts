import type {
  GoogleGenAI,
  ThinkingLevel,
  Content,
  Part,
  FunctionCall,
  ToolConfig,
} from '@google/genai'

import { normalizeSchema } from './normalizeSchema'
import { zodToToolSchema } from './zodToJsonSchema'

let _genai: typeof import('@google/genai')
function loadGenAI(): typeof import('@google/genai') {
  if (_genai) return _genai
  try {
    _genai = require('@google/genai') as typeof import('@google/genai')
    return _genai
  } catch {
    throw new Error(
      'The "@google/genai" package is required for the Gemini provider. ' +
        'Install it with: npm install @google/genai',
    )
  }
}
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
  VertexAIConfig,
} from '../types/runnables'
import type { AnyZodSchema } from '../types/zod'

import { withStreamRetry } from '../core/retry'
import { createEventId, createCallId } from '../session'
import { createStreamAccumulator, type RawDeltaEvent } from './accumulator'

const normalizeText = (text: string) => text.replace(/\n{3,}/g, '\n\n').trim()

const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

export interface GeminiAdapterConfig {
  apiKey?: string
  vertex?: VertexAIConfig
}

function createClientKey(config: GeminiAdapterConfig): string {
  if (config.vertex) {
    const creds = config.vertex.credentials ?? 'env'
    return `vertex:${config.vertex.project}:${config.vertex.location}:${creds}`
  }
  return `apikey:${config.apiKey ?? 'env'}`
}

export class GeminiAdapter implements ModelAdapter {
  private defaultConfig: GeminiAdapterConfig
  private clientCache = new Map<string, GoogleGenAI>()

  constructor(config?: GeminiAdapterConfig | string) {
    if (typeof config === 'string') {
      this.defaultConfig = { apiKey: config }
    } else {
      this.defaultConfig = config ?? {}
    }
  }

  private getClient(modelConfig: ProviderModelConfig): GoogleGenAI {
    const vertexConfig = modelConfig.provider === 'gemini' ? modelConfig.vertex : undefined

    const effectiveConfig: GeminiAdapterConfig = vertexConfig
      ? { vertex: vertexConfig }
      : this.defaultConfig

    const cacheKey = createClientKey(effectiveConfig)
    let client = this.clientCache.get(cacheKey)

    if (!client) {
      client = this.createClient(effectiveConfig)
      this.clientCache.set(cacheKey, client)
    }

    return client
  }

  private createClient(config: GeminiAdapterConfig): GoogleGenAI {
    if (config.vertex) {
      const credentials = config.vertex.credentials ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
      if (!credentials) {
        throw new Error(
          `No Google Cloud credentials configured.

Either:
- Set GOOGLE_APPLICATION_CREDENTIALS environment variable to credentials JSON file path
- Pass credentials path in vertex config: vertex: { project, location, credentials: "/path/to/credentials.json" } (recommended)`,
        )
      }
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials
      return new (loadGenAI().GoogleGenAI)({
        vertexai: true,
        project: config.vertex.project,
        location: config.vertex.location,
      })
    }

    const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error(
        `No Gemini API key configured.

Either:
- Pass apiKey to GeminiAdapter constructor
- Set GEMINI_API_KEY environment variable
- Use vertex config for Google Cloud authentication`,
      )
    }

    return new (loadGenAI().GoogleGenAI)({ apiKey })
  }

  async *step(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const thinkingConfig =
      config.provider === 'gemini' ? mapThinkingConfig(config.thinkingConfig) : undefined
    const retryConfig = config.provider === 'gemini' ? config.retry : undefined
    const { contents, systemInstruction } = serializeContext(ctx)
    const client = this.getClient(config)

    const createStream = async function* (): AsyncGenerator<StreamEvent, ModelStepResult> {
      if (signal?.aborted) {
        throw new Error('Aborted')
      }

      const allParts: Part[] = []
      const accumulator = createStreamAccumulator()
      let usageMetadata: GeminiUsage | undefined
      let finishReason: string | undefined

      const toolChoice = ctx.toolChoice ?? ctx.agent.toolChoice
      const useNativeStructuredOutput = ctx.outputSchema && ctx.outputMode !== 'prompt'
      const stream = await client.models.generateContentStream({
        model: config.name,
        contents,
        config: {
          systemInstruction,
          tools: serializeTools(ctx.functionTools),
          toolConfig: serializeToolConfig(toolChoice, ctx.allowedTools),
          thinkingConfig,
          ...samplingOptions(config),
          ...(useNativeStructuredOutput && {
            responseMimeType: 'application/json',
            responseJsonSchema: zodToGeminiSchema(ctx.outputSchema!),
          }),
        },
      })

      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw new Error('Aborted')
        }

        if (chunk.usageMetadata) {
          usageMetadata = chunk.usageMetadata as GeminiUsage
        }
        if (chunk.candidates?.[0]?.finishReason) {
          finishReason = chunk.candidates[0].finishReason
        }

        const parts = chunk.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          allParts.push(part)

          const rawEvent = partDeltaEvent(part, ctx)

          if (rawEvent) {
            yield accumulator.push(rawEvent)
          }
        }
      }

      return parseResponse(allParts, usageMetadata, finishReason, ctx.invocationId, ctx.agentName)
    }

    return yield* withStreamRetry(createStream, {
      config: retryConfig,
      signal,
    })
  }
}

function samplingOptions(config: ProviderModelConfig) {
  return {
    ...(config.temperature != null && { temperature: config.temperature }),
    ...(config.maxTokens != null && { maxOutputTokens: config.maxTokens }),
  }
}

function partDeltaEvent(part: Part, ctx: RenderContext): RawDeltaEvent | null {
  if (part.thought && part.text) {
    return {
      id: createEventId(),
      type: 'thought_delta',
      createdAt: Date.now(),
      invocationId: ctx.invocationId,
      agentName: ctx.agentName,
      delta: normalizeText(part.text) + '\n',
    }
  } else if (part.text && !part.thought) {
    return {
      id: createEventId(),
      type: 'assistant_delta',
      createdAt: Date.now(),
      invocationId: ctx.invocationId,
      agentName: ctx.agentName,
      delta: normalizeText(part.text),
    }
  }
  return null
}

function thoughtPart(text: string, geminiCtx: Part | undefined): Part {
  if (geminiCtx?.thoughtSignature) {
    return {
      thought: true,
      text,
      thoughtSignature: geminiCtx.thoughtSignature,
    }
  }
  return { text }
}

function mediaSourcePart(source: MediaPart['source'], urlMimeType: string): Part {
  if (source.type === 'url') {
    return {
      fileData: {
        fileUri: source.url,
        mimeType: urlMimeType,
      },
    }
  }
  return {
    inlineData: {
      mimeType: source.mimeType,
      data: source.data,
    },
  }
}

/** Parts that follow a function response to carry the tool result's images and documents. */
function toolResultMediaParts(event: { media?: MediaPart[] }): Part[] {
  const parts: Part[] = []
  if (event.media && event.media.length > 0) {
    for (const part of event.media) {
      if (part.type === 'image') {
        parts.push({ text: '[Image from tool result:]' })
        parts.push(mediaSourcePart(part.source, 'image/jpeg'))
      } else if (part.type === 'document') {
        parts.push({ text: '[Document from tool result:]' })
        parts.push(mediaSourcePart(part.source, 'application/pdf'))
      }
    }
  }
  return parts
}

function getGeminiContext(event: Pick<Event, 'providerContext'>): Part | undefined {
  if (event.providerContext?.provider === 'gemini') {
    return event.providerContext.data as Part
  }
  return undefined
}

export function serializeContext(ctx: RenderContext): {
  contents: Content[]
  systemInstruction: string | undefined
} {
  const contents: Content[] = []
  const systemParts: string[] = []

  type RoleGroup = { role: 'user' | 'model'; parts: Part[] }
  let current: RoleGroup | null = null

  const pushPart = (role: 'user' | 'model', part: Part) => {
    if (current?.role !== role) {
      if (current) contents.push(current)
      current = { role, parts: [] }
    }
    current.parts.push(part)
  }

  const serializeUserEvent = (event: UserEvent): Part[] => {
    const parts: Part[] = []
    if (event.text) {
      parts.push({ text: event.text })
    }
    if (event.media) {
      for (const part of event.media) {
        if (part.type === 'image') {
          if (part.source.type === 'url') {
            parts.push({
              fileData: { fileUri: part.source.url, mimeType: 'image/jpeg' },
            })
          } else {
            parts.push({
              inlineData: {
                mimeType: part.source.mimeType,
                data: part.source.data,
              },
            })
          }
        } else if (part.type === 'audio') {
          if (part.source.type === 'url') {
            parts.push({
              fileData: { fileUri: part.source.url, mimeType: 'audio/mp3' },
            })
          } else {
            parts.push({
              inlineData: {
                mimeType: part.source.mimeType,
                data: part.source.data,
              },
            })
          }
        }
      }
    }
    return parts.length > 0 ? parts : [{ text: '' }]
  }

  for (const event of ctx.events) {
    const geminiCtx = getGeminiContext(event)

    switch (event.type) {
      case 'system':
        systemParts.push(event.text)
        break

      case 'user':
        for (const part of serializeUserEvent(event)) {
          pushPart('user', part)
        }
        break

      case 'assistant': {
        const part: Part = { text: event.text }
        if (geminiCtx?.thoughtSignature) {
          part.thoughtSignature = geminiCtx.thoughtSignature
        }
        pushPart('model', part)
        break
      }

      case 'thought': {
        if (!event.text) break
        pushPart('model', thoughtPart(event.text, geminiCtx))
        break
      }

      case 'tool_call': {
        const part: Part = {
          functionCall: geminiCtx?.functionCall ?? {
            name: event.name,
            args: event.args,
          },
        }
        part.thoughtSignature = geminiCtx?.thoughtSignature ?? SYNTHETIC_THOUGHT_SIGNATURE
        pushPart('model', part)
        break
      }

      case 'tool_result': {
        const responseData = event.error
          ? { error: event.error }
          : (event.result as Record<string, unknown>)
        pushPart('user', {
          functionResponse: {
            name: event.name,
            response: responseData,
          },
        })
        for (const part of toolResultMediaParts(event)) {
          pushPart('user', part)
        }
        break
      }
    }
  }

  if (current) contents.push(current)

  return {
    contents,
    systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  }
}

interface GeminiUsage {
  promptTokenCount?: number
  cachedContentTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

function parseGeminiUsage(usage?: GeminiUsage): ModelUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    cachedTokens: usage.cachedContentTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
    outputTokens: usage.candidatesTokenCount ?? 0,
  }
}

function parseGeminiFinishReason(
  reason?: string,
  hasToolCalls?: boolean,
): ModelEndEvent['finishReason'] {
  if (hasToolCalls) return 'tool_calls'
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter'
  if (reason === 'ERROR') return 'error'
  return 'stop'
}

export function parseResponse(
  parts: Part[],
  usage: GeminiUsage | undefined,
  finishReason: string | undefined,
  invocationId: string,
  agentName: string,
): ModelStepResult {
  const createdAt = Date.now()

  const thoughtParts = parts.filter((p) => p.thought && p.text)
  const assistantParts = parts.filter((p) => p.text && !p.thought && !p.functionCall)
  const functionParts = parts.filter((p) => p.functionCall)

  const thoughtText = normalizeText(thoughtParts.map((p) => p.text).join(''))
  const assistantText = normalizeText(assistantParts.map((p) => p.text).join(''))

  const sharedSignature = parts.find((p) => p.thoughtSignature)?.thoughtSignature

  const thoughtEvent: Event | null = thoughtText
    ? ({
        id: createEventId(),
        type: 'thought',
        createdAt,
        invocationId,
        agentName,
        text: thoughtText,
        providerContext: sharedSignature
          ? { provider: 'gemini', data: { thoughtSignature: sharedSignature } }
          : undefined,
      } as Event)
    : null

  const assistantEvent: Event | null = assistantText
    ? ({
        id: createEventId(),
        type: 'assistant',
        createdAt,
        invocationId,
        agentName,
        text: assistantText,
        providerContext: sharedSignature
          ? { provider: 'gemini', data: { thoughtSignature: sharedSignature } }
          : undefined,
      } as Event)
    : null

  const toolCalls: ToolCallEvent[] = functionParts.map((part, index) => {
    const fn = part.functionCall as FunctionCall
    const signature =
      index === 0 ? (part.thoughtSignature ?? sharedSignature) : part.thoughtSignature

    return {
      id: createEventId(),
      type: 'tool_call',
      createdAt,
      invocationId,
      agentName,
      callId: createCallId(),
      name: fn.name!,
      args: (fn.args ?? {}) as Record<string, unknown>,
      providerContext: {
        provider: 'gemini',
        data: {
          functionCall: part.functionCall,
          ...(signature && { thoughtSignature: signature }),
        },
      },
    }
  })

  const stepEvents: Event[] = [
    ...(thoughtEvent ? [thoughtEvent] : []),
    ...toolCalls,
    ...(assistantEvent ? [assistantEvent] : []),
  ]

  return {
    stepEvents,
    toolCalls,
    terminal: toolCalls.length === 0,
    usage: parseGeminiUsage(usage),
    finishReason: parseGeminiFinishReason(finishReason, toolCalls.length > 0),
  }
}

export function serializeTools(tools: readonly FunctionTool[]) {
  if (tools.length === 0) return []

  return [
    {
      functionDeclarations: tools.map((t) => {
        const fn = zodToToolSchema(t.name, t.description, normalizeSchema(t.schema, t.name))
        return {
          name: fn.name,
          description: fn.description ?? t.description,
          parametersJsonSchema: fn.parameters,
        }
      }),
    },
  ]
}

function getThinkingLevelMap(): Record<string, ThinkingLevel> {
  const { ThinkingLevel: TL } = loadGenAI()
  return {
    minimal: TL.MINIMAL,
    low: TL.LOW,
    medium: TL.MEDIUM,
    high: TL.HIGH,
  }
}

function mapThinkingConfig(config?: {
  thinkingBudget?: number
  thinkingLevel?: string
  includeThoughts?: boolean
}) {
  if (!config) return undefined
  return {
    ...config,
    thinkingLevel: config.thinkingLevel ? getThinkingLevelMap()[config.thinkingLevel] : undefined,
  }
}

function zodToGeminiSchema(schema: AnyZodSchema): Record<string, unknown> {
  const fn = zodToToolSchema('output', 'Output schema', normalizeSchema(schema, 'output'))
  return fn.parameters
}

export function serializeToolConfig(
  choice: ToolChoice | undefined,
  allowedTools?: readonly string[],
): ToolConfig | undefined {
  if (!choice && !allowedTools) return undefined

  const FCM = loadGenAI().FunctionCallingConfigMode

  if (allowedTools && allowedTools.length > 0) {
    const mode = choice === 'required' ? FCM.ANY : FCM.AUTO
    return {
      functionCallingConfig: {
        mode,
        allowedFunctionNames: [...allowedTools],
      },
    }
  }

  if (choice === 'none') {
    return { functionCallingConfig: { mode: FCM.NONE } }
  }

  if (choice === 'required') {
    return { functionCallingConfig: { mode: FCM.ANY } }
  }

  if (typeof choice === 'object' && 'name' in choice) {
    return {
      functionCallingConfig: {
        mode: FCM.ANY,
        allowedFunctionNames: [choice.name],
      },
    }
  }

  return { functionCallingConfig: { mode: FCM.AUTO } }
}
