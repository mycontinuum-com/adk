import type { StateSchema } from '../types/schema'
import type { Hook } from './types'

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
}

export interface LoggingHookOptions {
  logger?: Logger
  level?: 'info' | 'debug'
  onLog?: (level: 'info' | 'debug', message: string, data?: unknown) => void
}

export function loggingHook<S extends StateSchema = StateSchema>(
  options?: LoggingHookOptions,
): Hook<S> {
  const log =
    options?.onLog ??
    (options?.logger
      ? (level: 'info' | 'debug', msg: string, data?: unknown) => {
          if (level === 'debug' && options.level !== 'debug') return
          options.logger![level](msg, data as Record<string, unknown>)
        }
      : defaultLog)

  return {
    name: 'logging',
    beforeAgent: (ctx) => {
      log('info', `Agent starting: ${ctx.runnable.name}`, {
        invocationId: ctx.invocationId,
        parentInvocationId: ctx.parentInvocationId,
      })
    },
    afterAgent: (ctx, output) => {
      log('info', `Agent completed: ${ctx.runnable.name}`, {
        invocationId: ctx.invocationId,
        outputType: typeof output,
      })
    },
    beforeTool: (ctx, call) => {
      log('debug', `Tool call: ${call.name}`, {
        invocationId: ctx.invocationId,
        callId: call.callId,
        args: call.args,
      })
    },
    afterTool: (ctx, result) => {
      log('debug', `Tool result: ${result.name}`, {
        invocationId: ctx.invocationId,
        callId: result.callId,
        durationMs: result.durationMs,
        error: result.error,
      })
    },
  }
}

function defaultLog(level: 'info' | 'debug', message: string, data?: unknown): void {
  const prefix = level === 'info' ? '[INFO]' : '[DEBUG]'
  if (data) {
    console.log(`${prefix} ${message}`, data)
  } else {
    console.log(`${prefix} ${message}`)
  }
}
