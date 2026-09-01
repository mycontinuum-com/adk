import type {
  ModelStepResult,
  ModelAdapter,
  ProviderModelConfig,
  RenderContext,
} from '../types/runnables'

import { type StreamEvent, type Event, type ToolCallEvent, type ModelUsage } from '../types/events'
import { isRealtimeConfig } from './models'
import { serializeTools } from './openai'
import {
  processRealtimeResponse,
  type RealtimeEventClassifier,
  type ClassifiedEvent,
} from './realtime-processor'
import {
  type WebSocketLike,
  type WSConstructor,
  loadWebSocket,
  send,
  waitForOpen,
  waitForMessage,
} from './ws-helpers'

// --- Active session tracking ---

interface ActiveSession {
  ws: WebSocketLike
  pendingToolCalls: Map<string, string>
  removeAbortHandler?: () => void
}

/** Shape of data stored in providerContext.data for OpenAI realtime events. */
interface OpenAIProviderData {
  call_id?: string
  item_id?: string
}

// --- Adapter ---

export class OpenAIRealtimeTextAdapter implements ModelAdapter {
  private apiKey?: string
  private wsConstructor?: WSConstructor
  private activeSessions = new Map<string, ActiveSession>()

  constructor(apiKey?: string, wsConstructor?: WSConstructor) {
    this.apiKey = apiKey
    this.wsConstructor = wsConstructor
  }

  private cleanupSession(key: string) {
    const session = this.activeSessions.get(key)
    if (session) {
      session.removeAbortHandler?.()
      session.ws.close()
      this.activeSessions.delete(key)
    }
  }

  async *step(
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    if (signal?.aborted) {
      this.cleanupSession(ctx.invocationId)
      throw new Error('Aborted')
    }

    const key = ctx.invocationId
    const existing = this.activeSessions.get(key)

    if (existing) {
      existing.removeAbortHandler?.()
      existing.removeAbortHandler = undefined
      return yield* this.handleToolResponse(existing, key, ctx, signal)
    }

    return yield* this.handleNewSession(key, ctx, config, signal)
  }

  private async *handleNewSession(
    key: string,
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const apiKey = this.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for the OpenAI Realtime adapter.')
    }
    const WSCtor = loadWebSocket(this.wsConstructor)
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.name)}`
    const ws = new WSCtor(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    })

    let keepAlive = false
    const onAbort = () => ws.close()
    signal?.addEventListener('abort', onAbort)

    try {
      await waitForOpen(ws)

      const tools = serializeTools(ctx.functionTools, []).map((t) => {
        const { strict: _, ...rest } = t as Record<string, unknown>
        return rest
      })

      const rtConfig =
        ctx.agent?.model && isRealtimeConfig(ctx.agent.model) ? ctx.agent.model : undefined

      send(ws, {
        type: 'session.update',
        session: {
          modalities: ['text'],
          instructions: extractInstructions(ctx),
          tools,
          turn_detection: null,
          ...(rtConfig?.voice && { voice: rtConfig.voice }),
          ...(config.temperature != null && {
            temperature: config.temperature,
          }),
          ...(config.maxTokens != null && {
            max_response_output_tokens: config.maxTokens,
          }),
        },
      })

      await waitForMessage(ws, (msg) => {
        if (msg.type === 'error') {
          throw new Error(`OpenAI Realtime error: ${JSON.stringify(msg.error)}`)
        }
        return msg.type === 'session.updated'
      })

      for (const item of serializeConversation(ctx)) {
        send(ws, { type: 'conversation.item.create', item })
      }

      send(ws, { type: 'response.create' })

      const result = yield* processRealtimeResponse(ws, ctx, createOpenAIClassifier(), signal)

      if (result.toolCalls.length > 0) {
        keepAlive = true
        this.storeSession(key, ws, result.toolCalls, signal)
      }

      return result
    } catch (err) {
      this.cleanupSession(key)
      throw err
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (!keepAlive) ws.close()
    }
  }

  private async *handleToolResponse(
    session: ActiveSession,
    key: string,
    ctx: RenderContext,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const { ws, pendingToolCalls } = session
    let keepAlive = false

    const onAbort = () => this.cleanupSession(key)
    signal?.addEventListener('abort', onAbort)

    try {
      const responses = buildToolResponses(ctx.events, pendingToolCalls)
      for (const response of responses) {
        send(ws, {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: response.callId,
            output: response.output,
          },
        })
      }

      send(ws, { type: 'response.create' })

      const result = yield* processRealtimeResponse(ws, ctx, createOpenAIClassifier(), signal)

      if (result.toolCalls.length > 0) {
        keepAlive = true
        this.storeSession(key, ws, result.toolCalls, signal)
      }

      return result
    } catch (err) {
      keepAlive = false
      throw err
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (!keepAlive) {
        this.cleanupSession(key)
      }
    }
  }

  private storeSession(
    key: string,
    ws: WebSocketLike,
    toolCalls: ToolCallEvent[],
    signal?: AbortSignal,
  ) {
    const pending = new Map<string, string>()
    for (const tc of toolCalls) {
      const callId = (tc.providerContext?.data as OpenAIProviderData | undefined)?.call_id
      if (callId) pending.set(tc.callId, callId)
    }

    const session: ActiveSession = { ws, pendingToolCalls: pending }
    this.activeSessions.set(key, session)

    if (signal && !signal.aborted) {
      const handler = () => this.cleanupSession(key)
      signal.addEventListener('abort', handler)
      session.removeAbortHandler = () => signal.removeEventListener('abort', handler)
    }
  }
}

// --- OpenAI event classifier ---

function createOpenAIClassifier(): RealtimeEventClassifier {
  const fnCallBuffers = new Map<string, { callId: string; name: string }>()

  return {
    providerName: 'openai-realtime',
    prematureCloseMessage: 'OpenAI Realtime connection closed before response completed.',

    classify(raw: Record<string, unknown>): ClassifiedEvent[] {
      const type = raw.type as string

      switch (type) {
        case 'response.text.delta': {
          return [{ kind: 'text_delta', delta: (raw as any).delta }]
        }

        case 'response.output_item.added': {
          const item = (raw as any).item
          if (item?.type === 'function_call') {
            fnCallBuffers.set(item.id, {
              callId: item.call_id,
              name: item.name,
            })
          }
          return []
        }

        case 'response.function_call_arguments.done': {
          const itemId = (raw as any).item_id as string
          const buf = fnCallBuffers.get(itemId)
          if (buf) {
            const finalArgs = (raw as any).arguments as string
            fnCallBuffers.delete(itemId)
            return [
              {
                kind: 'tool_calls',
                calls: [
                  {
                    name: buf.name,
                    args: JSON.parse(finalArgs) as Record<string, unknown>,
                    providerData: { call_id: buf.callId, item_id: itemId },
                  },
                ],
              },
            ]
          }
          return []
        }

        case 'response.done': {
          const response = (raw as any).response
          return [
            {
              kind: 'done',
              usage: response?.usage ? parseUsage(response.usage) : undefined,
              providerData: response,
            },
          ]
        }

        case 'error': {
          const err = (raw as any).error
          return [
            {
              kind: 'error',
              message: `OpenAI Realtime API error: ${err?.message ?? JSON.stringify(err)}`,
            },
          ]
        }

        default:
          return []
      }
    },
  }
}

// --- Serialization helpers ---

function extractInstructions(ctx: RenderContext): string {
  return ctx.events
    .filter((e) => e.type === 'system')
    .map((e) => (e as any).text as string)
    .join('\n\n')
}

function serializeConversation(ctx: RenderContext): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = []

  for (const event of ctx.events) {
    switch (event.type) {
      case 'user':
        items.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: event.text }],
        })
        break
      case 'assistant':
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: event.text }],
        })
        break
      case 'tool_call': {
        const providerData = event.providerContext?.data as any
        items.push({
          type: 'function_call',
          call_id: providerData?.call_id ?? event.callId,
          name: event.name,
          arguments: JSON.stringify(event.args),
        })
        break
      }
      case 'tool_result': {
        const providerData = event.providerContext?.data as any
        items.push({
          type: 'function_call_output',
          call_id: providerData?.call_id ?? event.callId,
          output: event.error ?? JSON.stringify(event.result),
        })
        break
      }
    }
  }

  return items
}

function buildToolResponses(
  events: readonly Event[],
  pendingToolCalls: Map<string, string>,
): Array<{ callId: string; output: string }> {
  const responses: Array<{ callId: string; output: string }> = []

  for (const event of events) {
    if (event.type === 'tool_result') {
      const openAICallId = pendingToolCalls.get(event.callId)
      if (openAICallId) {
        responses.push({
          callId: openAICallId,
          output: event.error ?? JSON.stringify(event.result),
        })
      }
    }
  }

  return responses
}

function parseUsage(usage: any): ModelUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(usage.input_token_details?.cached_tokens != null && {
      cachedTokens: usage.input_token_details.cached_tokens,
    }),
    ...(usage.input_token_details?.audio_tokens != null && {
      audioInputTokens: usage.input_token_details.audio_tokens,
    }),
    ...(usage.output_token_details?.audio_tokens != null && {
      audioOutputTokens: usage.output_token_details.audio_tokens,
    }),
  }
}
