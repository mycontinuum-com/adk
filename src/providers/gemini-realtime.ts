import type { Event, StreamEvent, ToolCallEvent, ModelUsage } from '../types/events'
import type {
  ModelStepResult,
  ModelAdapter,
  ProviderModelConfig,
  RenderContext,
  VertexAIConfig,
} from '../types/runnables'

import { serializeTools, serializeContext } from './gemini'
import { isRealtimeConfig } from './models'
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

// --- Endpoint helpers ---

const GOOGLE_AI_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

function vertexUrl(location: string): string {
  return `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`
}

function vertexModelUri(project: string, location: string, model: string): string {
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`
}

/** Resolve the WebSocket URL, headers, and model identifier for setup. */
async function resolveConnection(
  config: ProviderModelConfig,
  apiKey?: string,
): Promise<{ url: string; headers: Record<string, string>; modelId: string }> {
  const vertex = config.provider === 'gemini' ? config.vertex : undefined

  if (vertex) {
    const token = await getVertexAccessToken(vertex)
    return {
      url: vertexUrl(vertex.location),
      headers: { Authorization: `Bearer ${token}` },
      modelId: vertexModelUri(vertex.project, vertex.location, config.name),
    }
  }

  // Google AI (API key passed as URL query parameter)
  const key = apiKey ?? process.env.GEMINI_API_KEY
  if (!key) {
    throw new Error(
      'GEMINI_API_KEY is required for the Gemini Realtime adapter (or use vertex config).',
    )
  }
  return {
    url: `${GOOGLE_AI_URL}?key=${key}`,
    headers: {},
    modelId: `models/${config.name}`,
  }
}

async function getVertexAccessToken(vertex: VertexAIConfig): Promise<string> {
  // Lazily load google-auth-library to avoid hard dep for non-Vertex users
  let GoogleAuth: any
  try {
    ;({ GoogleAuth } = await import('google-auth-library'))
  } catch {
    throw new Error(
      'The "google-auth-library" package is required for Vertex AI realtime. ' +
        'Install it with: npm install google-auth-library',
    )
  }

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    ...(vertex.credentials && { keyFile: vertex.credentials }),
  })
  const client = await auth.getClient()
  const { token } = await client.getAccessToken()
  if (!token) {
    throw new Error('Failed to obtain access token for Vertex AI.')
  }
  return token
}

// --- Active session tracking ---

/**
 * Tracks a WebSocket that is kept alive between step() calls while the runner executes tools. The
 * Gemini Live API requires tool responses to be sent on the _same_ WebSocket connection that issued
 * the toolCall.
 */
interface ActiveSession {
  ws: WebSocketLike
  /** Maps ADK callId → Gemini functionCall id for pending tool calls. */
  pendingToolCalls: Map<string, string>
  /** Removes the abort listener registered between steps. */
  removeAbortHandler?: () => void
}

/** Shape of data stored in providerContext.data for Gemini realtime events. */
interface GeminiProviderData {
  functionCallId?: string
}

/** Detect native-audio models that don't support responseModalities: ["TEXT"]. */
function isNativeAudioModel(name: string): boolean {
  return name.includes('native-audio')
}

/**
 * Strip JSON Schema properties (`$schema`, `additionalProperties`) that the Gemini Live API
 * rejects. The standard generateContent API tolerates them, but the Live (BidiGenerateContent) API
 * does not.
 */
function cleanToolSchemas(
  tools: Array<{ functionDeclarations: any[] }>,
): Array<{ functionDeclarations: any[] }> {
  return tools.map((tool) => ({
    functionDeclarations: tool.functionDeclarations.map((fn) => ({
      ...fn,
      parameters: fn.parameters ? stripSchemaProps(fn.parameters) : undefined,
    })),
  }))
}

function stripSchemaProps(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _, additionalProperties: __, ...rest } = schema
  if (rest.properties && typeof rest.properties === 'object') {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'object' && v !== null ? stripSchemaProps(v as Record<string, unknown>) : v,
      ]),
    )
  }
  if (rest.items && typeof rest.items === 'object') {
    rest.items = stripSchemaProps(rest.items as Record<string, unknown>)
  }
  return rest
}

// --- Adapter ---

export class GeminiRealtimeTextAdapter implements ModelAdapter {
  private apiKey?: string
  private wsConstructor?: WSConstructor
  /**
   * Active WebSocket sessions keyed by invocation ID. When a step returns tool calls, the WS is
   * kept alive so the next step can send `toolResponse` on the same connection (required by the
   * Gemini Live protocol).
   */
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
      // Remove the between-steps abort handler before starting the new step
      existing.removeAbortHandler?.()
      existing.removeAbortHandler = undefined
      return yield* this.handleToolResponse(existing, key, ctx, signal)
    }

    return yield* this.handleNewSession(key, ctx, config, signal)
  }

  // --- New session: connect, setup, send history, process response ---

  private async *handleNewSession(
    key: string,
    ctx: RenderContext,
    config: ProviderModelConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ModelStepResult> {
    const { url, headers, modelId } = await resolveConnection(config, this.apiKey)

    const WSCtor = loadWebSocket(this.wsConstructor)
    const ws = new WSCtor(url, { headers })

    let keepAlive = false
    const onAbort = () => ws.close()
    signal?.addEventListener('abort', onAbort)

    try {
      await waitForOpen(ws)

      // 1. Send setup message
      const { contents, systemInstruction } = serializeContext(ctx)
      const tools = cleanToolSchemas(serializeTools(ctx.functionTools))

      const nativeAudio = isNativeAudioModel(config.name)
      const rtConfig =
        ctx.agent?.model && isRealtimeConfig(ctx.agent.model) ? ctx.agent.model : undefined

      send(ws, {
        setup: {
          model: modelId,
          ...(systemInstruction && {
            systemInstruction: { parts: [{ text: systemInstruction }] },
          }),
          ...(tools.length > 0 && { tools }),
          generationConfig: {
            responseModalities: [nativeAudio ? 'AUDIO' : 'TEXT'],
            ...(rtConfig?.voice && {
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: rtConfig.voice },
                },
              },
            }),
            ...(config.temperature != null && {
              temperature: config.temperature,
            }),
            ...(config.maxTokens != null && {
              maxOutputTokens: config.maxTokens,
            }),
          },
          // Native audio models require AUDIO modality; enable transcription
          // so we can extract text from the audio response.
          ...(nativeAudio && { outputAudioTranscription: {} }),
        },
      })

      await waitForMessage(ws, (msg) => 'setupComplete' in msg)

      // 2. Send conversation history and trigger generation.
      // Strip thoughtSignature/thought properties that are only for the
      // standard generateContent API, not the Live API.
      let sanitized = sanitizeForLiveApi(contents)

      // The Live API requires at least one user turn to trigger generation.
      // When there are no conversation turns (e.g. greeting-only context),
      // inject a minimal user turn so the model responds.
      if (sanitized.length === 0) {
        console.debug(
          '[adk/gemini-realtime] No conversation history — injecting synthetic user turn (Gemini Live API requires at least one).',
        )
        sanitized = [{ role: 'user', parts: [{ text: 'Start' }] }]
      }

      send(ws, {
        clientContent: {
          turns: sanitized,
          turnComplete: true,
        },
      })

      // 3. Process streamed response events
      const result = yield* processRealtimeResponse(ws, ctx, createGeminiClassifier(), signal)

      // 4. If the model made tool calls, keep the WS alive for toolResponse
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
      if (!keepAlive) {
        ws.close()
      }
    }
  }

  // --- Resume after tool execution: send toolResponse on existing WS ---

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
      // Build and send toolResponse for each pending tool result
      const functionResponses = buildToolResponses(ctx.events, pendingToolCalls)
      send(ws, { toolResponse: { functionResponses } })

      // Process the model's next response
      const result = yield* processRealtimeResponse(ws, ctx, createGeminiClassifier(), signal)

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

  // --- Helpers ---

  private storeSession(
    key: string,
    ws: WebSocketLike,
    toolCalls: ToolCallEvent[],
    signal?: AbortSignal,
  ) {
    const pending = new Map<string, string>()
    for (const tc of toolCalls) {
      const fnId = (tc.providerContext?.data as GeminiProviderData | undefined)?.functionCallId
      if (fnId) pending.set(tc.callId, fnId)
    }

    const session: ActiveSession = { ws, pendingToolCalls: pending }
    this.activeSessions.set(key, session)

    // Register abort handler for the between-steps period
    if (signal && !signal.aborted) {
      const handler = () => this.cleanupSession(key)
      signal.addEventListener('abort', handler)
      session.removeAbortHandler = () => signal.removeEventListener('abort', handler)
    }
  }
}

// --- Gemini event classifier ---

function createGeminiClassifier(): RealtimeEventClassifier {
  return {
    providerName: 'gemini-realtime',
    prematureCloseMessage: 'Gemini Realtime connection closed before response completed.',

    classify(raw: Record<string, unknown>): ClassifiedEvent[] {
      const events: ClassifiedEvent[] = []

      // Usage metadata — can arrive at any point
      if ('usageMetadata' in raw) {
        events.push({
          kind: 'usage',
          usage: parseGeminiUsage(raw.usageMetadata as Record<string, unknown>),
        })
      }

      // Tool call — arguments arrive complete in one message.
      // Emit tool_calls + done so the shared processor returns immediately.
      if ('toolCall' in raw) {
        const tc = raw.toolCall as {
          functionCalls?: Array<{
            id: string
            name: string
            args: Record<string, unknown>
          }>
        }
        if (tc.functionCalls) {
          events.push({
            kind: 'tool_calls',
            calls: tc.functionCalls.map((fn) => ({
              name: fn.name,
              args: fn.args ?? {},
              providerData: { functionCallId: fn.id },
            })),
          })
          events.push({ kind: 'done' })
        }
        return events
      }

      // Server content — streamed text, transcription, and turn completion
      if ('serverContent' in raw) {
        const sc = raw.serverContent as {
          modelTurn?: {
            parts?: Array<{
              text?: string
              thought?: boolean
              inlineData?: unknown
            }>
          }
          outputTranscription?: { text?: string; finished?: boolean }
          turnComplete?: boolean
        }

        if (sc.modelTurn?.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.text && part.thought) {
              events.push({
                kind: 'text_delta',
                delta: part.text,
                isThought: true,
              })
            } else if (part.text) {
              events.push({ kind: 'text_delta', delta: part.text })
            }
          }
        }

        if (sc.outputTranscription?.text) {
          events.push({
            kind: 'text_delta',
            delta: sc.outputTranscription.text,
          })
        }

        if (sc.turnComplete) {
          events.push({ kind: 'done' })
        }
      }

      return events
    },
  }
}

// --- Gemini-specific protocol helpers ---

function parseGeminiUsage(raw: Record<string, unknown>): ModelUsage {
  return {
    inputTokens: (raw.promptTokenCount as number) ?? 0,
    outputTokens: (raw.candidatesTokenCount as number) ?? 0,
    ...(raw.cachedContentTokenCount != null && {
      cachedTokens: raw.cachedContentTokenCount as number,
    }),
    ...(raw.thoughtsTokenCount != null && {
      reasoningTokens: raw.thoughtsTokenCount as number,
    }),
  }
}

/**
 * Strip properties from serialized Content[] that are only relevant to the standard generateContent
 * API and not supported by the Live API: - `thoughtSignature` (thinking model feature) - `thought`
 * flag (thinking model feature)
 */
function sanitizeForLiveApi(
  contents: Array<{ role?: string; parts?: any[] }>,
): Array<{ role?: string; parts: any[] }> {
  return contents
    .map((turn) => ({
      role: turn.role,
      parts: (turn.parts ?? [])
        .map((part: any) => {
          const { thoughtSignature: _, thought: __, ...clean } = part
          return clean
        })
        .filter((part: any) => {
          // Remove empty text-only parts
          if (Object.keys(part).length === 1 && 'text' in part && !part.text) return false
          return true
        }),
    }))
    .filter((turn) => turn.parts.length > 0)
}

/**
 * Build the `toolResponse.functionResponses` array by matching tool_result events in the context
 * against the pending tool call IDs from the previous step's toolCall message.
 */
function buildToolResponses(
  events: readonly Event[],
  pendingToolCalls: Map<string, string>,
): Array<{ id: string; name: string; response: unknown }> {
  const responses: Array<{ id: string; name: string; response: unknown }> = []

  for (const event of events) {
    if (event.type === 'tool_result') {
      const geminiId = pendingToolCalls.get(event.callId)
      if (geminiId) {
        responses.push({
          id: geminiId,
          name: event.name,
          response: event.error
            ? { error: event.error }
            : (event.result as Record<string, unknown>),
        })
      }
    }
  }

  return responses
}
