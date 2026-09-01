import type { StateSchema } from '../types/schema'
import type { Hook } from './types'

export interface MetricsHookOptions {
  onToolCall?: (name: string, args: unknown) => void
  onToolResult?: (name: string, durationMs: number, error?: string) => void
  onModelResult?: (
    agentName: string,
    modelName: string,
    durationMs: number,
    usage?: { inputTokens: number; outputTokens: number },
  ) => void
  onComplete?: (durationMs: number) => void
}

export function metricsHook<S extends StateSchema = StateSchema>(
  options: MetricsHookOptions,
): Hook<S> {
  let runStart: number | undefined

  return {
    name: 'metrics',
    onEvent: (event) => {
      switch (event.type) {
        case 'invocation_start':
          if (!event.parentInvocationId) {
            runStart = Date.now()
          }
          break
        case 'tool_call':
          options.onToolCall?.(event.name, event.args)
          break
        case 'tool_result':
          options.onToolResult?.(event.name, event.durationMs ?? 0, event.error)
          break
        case 'model_end':
          options.onModelResult?.(
            event.agentName,
            event.usage?.modelName ?? '',
            event.durationMs ?? 0,
            event.usage
              ? { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens }
              : undefined,
          )
          break
        case 'invocation_end':
          if (!event.parentInvocationId && runStart !== undefined) {
            options.onComplete?.(Date.now() - runStart)
            runStart = undefined
          }
          break
      }
    },
  }
}
