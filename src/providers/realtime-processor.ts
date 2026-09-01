/**
 * Shared response processor for realtime text-mode adapters.
 *
 * Both OpenAI and Gemini realtime adapters follow the same loop pattern: 1. Iterate over WebSocket
 * messages 2. Accumulate text deltas (assistant and/or thought) 3. Collect tool calls 4. On a
 * completion signal, flush accumulated text and return a ModelStepResult
 *
 * This module extracts that shared loop. Each provider supplies a RealtimeEventClassifier that
 * transforms raw WS messages into normalized ClassifiedEvent values.
 */
import type { Event, StreamEvent, ToolCallEvent, ModelUsage } from '../types/events'
import type { ModelStepResult, RenderContext } from '../types/runnables'

import { createEventId } from '../core/constants'
import { createCallId } from '../session'
import { createStreamAccumulator, type RawDeltaEvent } from './accumulator'
import { type WebSocketLike, receiveEvents } from './ws-helpers'

// --- Classifier interface ---

export interface ToolCallInfo {
  name: string
  args: Record<string, unknown>
  /** Provider-specific data stored in providerContext.data (e.g. { call_id, item_id } for OpenAI). */
  providerData?: Record<string, unknown>
}

export type ClassifiedEvent =
  | { kind: 'text_delta'; delta: string; isThought?: boolean }
  | { kind: 'tool_calls'; calls: ToolCallInfo[] }
  | { kind: 'done'; usage?: ModelUsage; providerData?: unknown }
  | { kind: 'usage'; usage: ModelUsage }
  | { kind: 'error'; message: string }

/**
 * Transforms raw WebSocket messages into normalized ClassifiedEvent values. Stateful classifiers
 * (e.g. OpenAI's incremental tool-call buffering) maintain their own internal state between calls
 * to classify().
 */
export interface RealtimeEventClassifier {
  /** Classify a raw WS message. Return empty array to skip the message. */
  classify(raw: Record<string, unknown>): ClassifiedEvent[]
  /** Provider name used in providerContext (e.g. 'openai-realtime'). */
  providerName: string
  /** Error message when the WS closes before the response completes. */
  prematureCloseMessage: string
}

// --- Shared processor ---

export async function* processRealtimeResponse(
  ws: WebSocketLike,
  ctx: RenderContext,
  classifier: RealtimeEventClassifier,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, ModelStepResult> {
  const accumulator = createStreamAccumulator()
  const stepEvents: Event[] = []
  const toolCalls: ToolCallEvent[] = []
  let usage: ModelUsage | undefined

  for await (const raw of receiveEvents(ws)) {
    if (signal?.aborted) throw new Error('Aborted')

    for (const event of classifier.classify(raw)) {
      switch (event.kind) {
        case 'text_delta': {
          const deltaEvent: RawDeltaEvent = {
            id: createEventId(),
            type: event.isThought ? 'thought_delta' : 'assistant_delta',
            createdAt: Date.now(),
            invocationId: ctx.invocationId,
            agentName: ctx.agentName,
            delta: event.delta,
          }
          yield accumulator.push(deltaEvent)
          break
        }

        case 'tool_calls': {
          for (const call of event.calls) {
            const tc: ToolCallEvent = {
              id: createEventId(),
              type: 'tool_call',
              createdAt: Date.now(),
              invocationId: ctx.invocationId,
              agentName: ctx.agentName,
              callId: createCallId(),
              name: call.name,
              args: call.args,
              providerContext: {
                provider: classifier.providerName,
                data: call.providerData ?? {},
              },
            }
            stepEvents.push(tc)
            toolCalls.push(tc)
          }
          break
        }

        case 'done': {
          if (event.usage) usage = event.usage

          // Flush accumulated text
          const { thoughtText, assistantText } = accumulator.getAccumulatedText()
          if (thoughtText) {
            stepEvents.push(
              createTextEvent(
                'thought',
                thoughtText,
                ctx,
                classifier.providerName,
                event.providerData,
              ),
            )
          }
          if (assistantText) {
            stepEvents.push(
              createTextEvent(
                'assistant',
                assistantText,
                ctx,
                classifier.providerName,
                event.providerData,
              ),
            )
          }

          return {
            stepEvents,
            toolCalls,
            terminal: toolCalls.length === 0,
            usage,
            finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }
        }

        case 'usage': {
          usage = event.usage
          break
        }

        case 'error': {
          throw new Error(event.message)
        }
      }
    }
  }

  // WebSocket closed before completion
  if (signal?.aborted) throw new Error('Aborted')
  throw new Error(classifier.prematureCloseMessage)
}

// --- Helpers ---

function createTextEvent(
  type: 'assistant' | 'thought',
  text: string,
  ctx: RenderContext,
  providerName: string,
  providerData?: unknown,
): Event {
  return {
    id: createEventId(),
    type,
    createdAt: Date.now(),
    invocationId: ctx.invocationId,
    agentName: ctx.agentName,
    text,
    providerContext: { provider: providerName, data: providerData ?? {} },
  } as Event
}
