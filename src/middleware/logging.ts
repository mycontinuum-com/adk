import type { Middleware } from './types';

export interface LoggingMiddlewareOptions {
  onLog?: (level: 'info' | 'debug', message: string, data?: unknown) => void;
}

export function loggingMiddleware(
  options?: LoggingMiddlewareOptions,
): Middleware {
  const log = options?.onLog ?? defaultLog;

  return {
    name: 'logging',
    beforeAgent: (ctx) => {
      log('info', `Agent starting: ${ctx.runnable.name}`, {
        invocationId: ctx.invocationId,
        parentInvocationId: ctx.parentInvocationId,
      });
    },
    afterAgent: (ctx, output) => {
      log('info', `Agent completed: ${ctx.runnable.name}`, {
        invocationId: ctx.invocationId,
        outputLength: output.length,
      });
    },
    beforeTool: (ctx, call) => {
      log('debug', `Tool call: ${call.name}`, {
        invocationId: ctx.invocationId,
        callId: call.callId,
        args: call.args,
      });
    },
    afterTool: (ctx, result) => {
      log('debug', `Tool result: ${result.name}`, {
        invocationId: ctx.invocationId,
        callId: result.callId,
        durationMs: result.durationMs,
        error: result.error,
      });
    },
  };
}

function defaultLog(
  level: 'info' | 'debug',
  message: string,
  data?: unknown,
): void {
  const prefix = level === 'info' ? '[INFO]' : '[DEBUG]';
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}
