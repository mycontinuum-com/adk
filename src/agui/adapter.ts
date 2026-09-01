import { EventType, type AGUIEvent, type CustomEvent, type StateSnapshotEvent } from '@ag-ui/core'

import type { StreamEvent, ToolYieldEvent } from '../types/events'

export { EventType }

export interface AdapterOptions {
  includeReasoning?: boolean
  includeSteps?: boolean
  includeRawEvents?: boolean
  yieldTransformers?: Record<string, (event: ToolYieldEvent) => CustomEvent | null>
}

export class AgUIAdapter {
  private sessionId: string
  private runId: string
  private options: AdapterOptions
  private messageId = 0
  private currentMsgId: string | null = null
  private inReasoning = false
  private reasoningPhaseId: string | null = null
  private reasoningMsgId: string | null = null

  constructor(sessionId: string, runId: string, options?: AdapterOptions) {
    this.sessionId = sessionId
    this.runId = runId
    this.options = {
      includeReasoning: true,
      includeSteps: false,
      includeRawEvents: false,
      ...options,
    }
  }

  private get reasoning(): boolean {
    return this.options.includeReasoning ?? true
  }

  private baseFields(event: StreamEvent) {
    return {
      timestamp: event.createdAt,
      ...(this.options.includeRawEvents && { rawEvent: event }),
    }
  }

  transform(event: StreamEvent): AGUIEvent[] {
    const out: AGUIEvent[] = []
    const base = this.baseFields(event)

    switch (event.type) {
      case 'thought_delta':
        if (!this.reasoning) break
        if (!this.inReasoning) {
          this.inReasoning = true
          this.reasoningPhaseId = `reasoning_${++this.messageId}`
          this.reasoningMsgId = `reasoning_msg_${this.messageId}`
          out.push({
            type: EventType.REASONING_START,
            messageId: this.reasoningPhaseId,
            ...base,
          })
          out.push({
            type: EventType.REASONING_MESSAGE_START,
            messageId: this.reasoningMsgId,
            role: 'reasoning',
            ...base,
          })
        }
        out.push({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.reasoningMsgId!,
          delta: event.delta,
          ...base,
        })
        break

      case 'thought':
        if (!this.reasoning) break
        if (this.inReasoning) {
          out.push({
            type: EventType.REASONING_MESSAGE_END,
            messageId: this.reasoningMsgId!,
            ...base,
          })
          out.push({
            type: EventType.REASONING_END,
            messageId: this.reasoningPhaseId!,
            ...base,
          })
          this.inReasoning = false
          this.reasoningPhaseId = null
          this.reasoningMsgId = null
        }
        break

      case 'assistant_delta':
        out.push(...this.closeReasoning(base.timestamp))
        if (!this.currentMsgId) {
          this.currentMsgId = `msg_${++this.messageId}`
          out.push({
            type: EventType.TEXT_MESSAGE_START,
            messageId: this.currentMsgId,
            role: 'assistant',
            ...base,
          })
        }
        out.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.currentMsgId,
          delta: event.delta,
          ...base,
        })
        break

      case 'assistant':
        if (this.currentMsgId) {
          out.push({
            type: EventType.TEXT_MESSAGE_END,
            messageId: this.currentMsgId,
            ...base,
          })
          this.currentMsgId = null
        }
        break

      case 'tool_call':
        out.push(...this.closeReasoning(base.timestamp))
        out.push({
          type: EventType.TOOL_CALL_START,
          toolCallId: event.callId,
          toolCallName: event.name,
          ...base,
        })
        out.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: event.callId,
          delta: JSON.stringify(event.args),
          ...base,
        })
        if (!event.yields) {
          out.push({
            type: EventType.TOOL_CALL_END,
            toolCallId: event.callId,
            ...base,
          })
        }
        break

      case 'tool_result':
        out.push({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: event.callId,
          messageId: `result_${event.callId}`,
          role: 'tool',
          content: JSON.stringify(event.result ?? event.error ?? null),
          ...base,
        })
        break

      case 'tool_yield':
        out.push(...this.transformYield(event))
        break

      case 'state_change':
        out.push({
          type: EventType.STATE_DELTA,
          delta: event.changes.map((c) => ({
            op: (c.newValue === undefined
              ? 'remove'
              : c.oldValue === undefined
                ? 'add'
                : 'replace') as 'add' | 'remove' | 'replace',
            path: `/${event.scope}/${c.key}`,
            value: c.newValue,
          })),
          timestamp: event.createdAt,
        })
        break

      case 'invocation_start':
        if (this.options.includeSteps) {
          out.push({
            type: EventType.STEP_STARTED,
            stepName: event.agentName,
            ...base,
          })
        }
        break

      case 'invocation_end':
        if (this.options.includeSteps) {
          out.push({
            type: EventType.STEP_FINISHED,
            stepName: event.agentName,
            ...base,
          })
        }
        break
    }

    return out
  }

  private closeReasoning(timestamp?: number): AGUIEvent[] {
    if (this.inReasoning) {
      this.inReasoning = false
      const events: AGUIEvent[] = [
        {
          type: EventType.REASONING_MESSAGE_END,
          messageId: this.reasoningMsgId!,
          timestamp,
        },
        {
          type: EventType.REASONING_END,
          messageId: this.reasoningPhaseId!,
          timestamp,
        },
      ]
      this.reasoningPhaseId = null
      this.reasoningMsgId = null
      return events
    }
    return []
  }

  private transformYield(event: ToolYieldEvent): AGUIEvent[] {
    const base = this.baseFields(event)
    const transformer = this.options.yieldTransformers?.[event.name]
    if (transformer) {
      const result = transformer(event)
      return result ? [{ ...result, ...base }] : []
    }
    return [
      {
        type: EventType.CUSTOM,
        name: 'TOOL_YIELD',
        value: {
          callId: event.callId,
          toolName: event.name,
          args: event.args,
        },
        ...base,
      },
    ]
  }

  runStarted(): AGUIEvent {
    return {
      type: EventType.RUN_STARTED,
      threadId: this.sessionId,
      runId: this.runId,
    }
  }

  runFinished(result?: unknown): AGUIEvent {
    return {
      type: EventType.RUN_FINISHED,
      threadId: this.sessionId,
      runId: this.runId,
      result,
    }
  }

  runInterrupted(interrupt: { id?: string; reason?: string; payload?: unknown }): AGUIEvent[] {
    return [
      {
        type: EventType.CUSTOM,
        name: 'RUN_INTERRUPTED',
        value: {
          threadId: this.sessionId,
          runId: this.runId,
          ...interrupt,
        },
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: this.sessionId,
        runId: this.runId,
      },
    ]
  }

  runError(message: string, code?: string): AGUIEvent {
    return { type: EventType.RUN_ERROR, message, ...(code && { code }) }
  }

  stateSnapshot(snapshot: Record<string, unknown>): StateSnapshotEvent {
    return { type: EventType.STATE_SNAPSHOT, snapshot }
  }

  custom(name: string, value: unknown): CustomEvent {
    return { type: EventType.CUSTOM, name, value }
  }
}

export function createYieldTransformer(
  name: string,
  transform: (args: unknown, callId: string) => CustomEvent['value'],
): [string, (event: ToolYieldEvent) => CustomEvent] {
  return [
    name,
    (event) => ({
      type: EventType.CUSTOM,
      name: name.toUpperCase(),
      value: transform(event.args, event.callId),
    }),
  ]
}
