import { EventType, type AGUIEvent, type CustomEvent } from '@ag-ui/core';
import type { Middleware } from '../middleware/types';
import type { ToolYieldEvent } from '../types';
import { AgUIAdapter, type AdapterOptions } from './adapter';

export type AgUISink = (event: AGUIEvent) => void;

export interface AgUIMiddlewareConfig extends AdapterOptions {
  threadId: string;
  runId: string;
  sink: AgUISink;
  emitLifecycle?: boolean;
  initialState?: Record<string, unknown>;
}

export interface AgUIMiddlewareResult {
  middleware: Middleware;
  adapter: AgUIAdapter;
  emitRunStarted: () => void;
  emitRunFinished: (result?: unknown) => void;
  emitRunError: (message: string, code?: string) => void;
}

export function aguiMiddleware(
  config: AgUIMiddlewareConfig,
): AgUIMiddlewareResult {
  const adapter = new AgUIAdapter(config.threadId, config.runId, {
    includeThinking: config.includeThinking,
    includeSteps: config.includeSteps,
    includeRawEvents: config.includeRawEvents,
    yieldTransformers: config.yieldTransformers,
  });

  const middleware: Middleware = {
    name: 'agui',

    beforeAgent: config.emitLifecycle
      ? () => {
          config.sink(adapter.runStarted());
          if (config.initialState) {
            config.sink(adapter.stateSnapshot(config.initialState));
          }
        }
      : undefined,

    afterAgent: config.emitLifecycle
      ? () => {
          config.sink(adapter.runFinished());
        }
      : undefined,

    onStream: (event) => {
      for (const e of adapter.transform(event)) {
        config.sink(e);
      }
    },
  };

  return {
    middleware,
    adapter,
    emitRunStarted: () => config.sink(adapter.runStarted()),
    emitRunFinished: (result?: unknown) =>
      config.sink(adapter.runFinished(result)),
    emitRunError: (message: string, code?: string) =>
      config.sink(adapter.runError(message, code)),
  };
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
      value: transform(event.preparedArgs, event.callId),
    }),
  ];
}
