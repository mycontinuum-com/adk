import {
  EventType,
  type AGUIEvent,
  type CustomEvent,
  type StateSnapshotEvent,
} from '@ag-ui/core';
import type { StreamEvent, ToolYieldEvent } from '../types';

export interface AdapterOptions {
  includeThinking?: boolean;
  includeSteps?: boolean;
  includeRawEvents?: boolean;
  yieldTransformers?: Record<
    string,
    (event: ToolYieldEvent) => CustomEvent | null
  >;
}

export class AgUIAdapter {
  private threadId: string;
  private runId: string;
  private options: AdapterOptions;
  private messageId = 0;
  private currentMsgId: string | null = null;
  private inThinking = false;

  constructor(threadId: string, runId: string, options?: AdapterOptions) {
    this.threadId = threadId;
    this.runId = runId;
    this.options = {
      includeThinking: true,
      includeSteps: false,
      includeRawEvents: false,
      ...options,
    };
  }

  private baseFields(event: StreamEvent) {
    return {
      timestamp: event.createdAt,
      ...(this.options.includeRawEvents && { rawEvent: event }),
    };
  }

  transform(event: StreamEvent): AGUIEvent[] {
    const out: AGUIEvent[] = [];
    const base = this.baseFields(event);

    switch (event.type) {
      // TODO: THINKING_TEXT_MESSAGE_* events are deprecated in AG-UI and will be replaced
      // with REASONING_* events. Update to use REASONING_START, REASONING_MESSAGE_*,
      // and REASONING_END when available in @ag-ui/core.
      // See: https://docs.ag-ui.com/drafts/reasoning
      case 'thought_delta':
        if (!this.options.includeThinking) break;
        if (!this.inThinking) {
          this.inThinking = true;
          out.push({ type: EventType.THINKING_TEXT_MESSAGE_START, ...base });
        }
        out.push({
          type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
          delta: event.delta,
          ...base,
        });
        break;

      case 'thought':
        if (!this.options.includeThinking) break;
        if (this.inThinking) {
          out.push({ type: EventType.THINKING_TEXT_MESSAGE_END, ...base });
          this.inThinking = false;
        }
        break;

      case 'assistant_delta':
        out.push(...this.closeThinking(base.timestamp));
        if (!this.currentMsgId) {
          this.currentMsgId = `msg_${++this.messageId}`;
          out.push({
            type: EventType.TEXT_MESSAGE_START,
            messageId: this.currentMsgId,
            role: 'assistant',
            ...base,
          });
        }
        out.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.currentMsgId,
          delta: event.delta,
          ...base,
        });
        break;

      case 'assistant':
        if (this.currentMsgId) {
          out.push({
            type: EventType.TEXT_MESSAGE_END,
            messageId: this.currentMsgId,
            ...base,
          });
          this.currentMsgId = null;
        }
        break;

      case 'tool_call':
        out.push(...this.closeThinking(base.timestamp));
        out.push({
          type: EventType.TOOL_CALL_START,
          toolCallId: event.callId,
          toolCallName: event.name,
          ...base,
        });
        out.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: event.callId,
          delta: JSON.stringify(event.args),
          ...base,
        });
        if (!event.yields) {
          out.push({
            type: EventType.TOOL_CALL_END,
            toolCallId: event.callId,
            ...base,
          });
        }
        break;

      case 'tool_result':
        out.push({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: event.callId,
          messageId: `result_${event.callId}`,
          content: JSON.stringify(event.result ?? event.error ?? null),
          ...base,
        });
        break;

      case 'tool_yield':
        out.push(...this.transformYield(event));
        break;

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
        });
        break;

      case 'invocation_start':
        if (this.options.includeSteps) {
          out.push({
            type: EventType.STEP_STARTED,
            stepName: event.agentName,
            ...base,
          });
        }
        break;

      case 'invocation_end':
        if (this.options.includeSteps) {
          out.push({
            type: EventType.STEP_FINISHED,
            stepName: event.agentName,
            ...base,
          });
        }
        break;
    }

    return out;
  }

  private closeThinking(timestamp?: number): AGUIEvent[] {
    if (this.inThinking) {
      this.inThinking = false;
      return [{ type: EventType.THINKING_TEXT_MESSAGE_END, timestamp }];
    }
    return [];
  }

  private transformYield(event: ToolYieldEvent): AGUIEvent[] {
    const base = this.baseFields(event);
    const transformer = this.options.yieldTransformers?.[event.name];
    if (transformer) {
      const result = transformer(event);
      return result ? [{ ...result, ...base }] : [];
    }
    return [
      {
        type: EventType.CUSTOM,
        name: 'TOOL_YIELD',
        value: {
          callId: event.callId,
          toolName: event.name,
          args: event.preparedArgs,
        },
        ...base,
      },
    ];
  }

  runStarted(): AGUIEvent {
    return {
      type: EventType.RUN_STARTED,
      threadId: this.threadId,
      runId: this.runId,
    };
  }

  runFinished(result?: unknown): AGUIEvent {
    return {
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId: this.runId,
      result,
    };
  }

  // TODO: AG-UI has a draft proposal for interrupt-aware run lifecycle that adds
  // `outcome: "interrupt"` and `interrupt: {...}` fields to RUN_FINISHED.
  // When @ag-ui/core adds these fields, update to use:
  //   { type: RUN_FINISHED, outcome: "interrupt", interrupt: { id, reason, payload } }
  // See: https://docs.ag-ui.com/drafts/interrupts
  runInterrupted(interrupt: {
    id?: string;
    reason?: string;
    payload?: unknown;
  }): AGUIEvent[] {
    return [
      {
        type: EventType.CUSTOM,
        name: 'RUN_INTERRUPTED',
        value: {
          threadId: this.threadId,
          runId: this.runId,
          ...interrupt,
        },
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: this.threadId,
        runId: this.runId,
      },
    ];
  }

  runError(message: string, code?: string): AGUIEvent {
    return { type: EventType.RUN_ERROR, message, ...(code && { code }) };
  }

  stateSnapshot(snapshot: Record<string, unknown>): StateSnapshotEvent {
    return { type: EventType.STATE_SNAPSHOT, snapshot };
  }

  custom(name: string, value: unknown): CustomEvent {
    return { type: EventType.CUSTOM, name, value };
  }
}
