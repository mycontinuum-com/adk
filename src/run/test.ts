import type { Hook } from '../hook/types'
import type { InvocationYieldEvent } from '../types/events'
import type { Runnable } from '../types/runnables'
import type { RunResult, StreamResult } from '../types/runtime'
import type { Session, Input } from '../types/session'

export type ToolHandler = unknown[] | ((args: unknown) => unknown)

export interface TestOptions {
  session?: Session
  input?:
    | string
    | (Input & {
        toolHandlers?: Record<string, ToolHandler>
        userHandler?: string[]
      })
  maxTurns?: number
  hooks?: Hook<any>[]
  timeout?: number
}

export interface TestRunFn {
  (
    runnable: Runnable<any>,
    config: {
      session?: Session
      input?: Input
      hooks?: Hook<any>[]
      timeout?: number
    },
  ): StreamResult
}

export async function runTestLoop(
  runnable: Runnable<any>,
  run: TestRunFn,
  options: TestOptions,
): Promise<RunResult> {
  const input = typeof options.input === 'string' ? { message: options.input } : options.input
  const maxIterations = options.maxTurns ?? 100
  const toolCounters = new Map<string, number>()
  let messageIndex = 0
  let iterations = 0

  let result = await run(runnable, {
    session: options.session,
    input: {
      message: input?.message,
      state: input?.state,
    },
    hooks: options.hooks,
    timeout: options.timeout,
  })

  while (
    (result.status === 'yielded_tool' || result.status === 'yielded_message') &&
    iterations < maxIterations
  ) {
    iterations++

    if (result.status === 'yielded_message') {
      applyMessageResume(result.session, input?.userHandler, messageIndex++)
    } else {
      applyToolResume(result, input?.toolHandlers, toolCounters)
    }

    result = await run(runnable, {
      session: result.session,
      hooks: options.hooks,
      timeout: options.timeout,
    })
  }

  if (
    iterations >= maxIterations &&
    (result.status === 'yielded_tool' || result.status === 'yielded_message')
  ) {
    return {
      runnable: result.runnable,
      session: result.session,
      state: result.state,
      iterations: result.iterations,
      usage: result.usage,
      output: result.output,
      status: 'error' as const,
      error: `Max iterations (${maxIterations}) exceeded`,
    }
  }

  return result
}

function applyMessageResume(session: Session, messages: string[] | undefined, index: number): void {
  if (!messages || index >= messages.length) {
    throw new Error(
      `No message available at index ${index}. Provide more entries in 'userHandler'.`,
    )
  }
  const yieldEvent = [...session.events]
    .toReversed()
    .find(
      (e): e is InvocationYieldEvent => e.type === 'invocation_yield' && e.awaitingInput === true,
    )
  session.input.message({
    text: messages[index],
    invocationId: yieldEvent?.invocationId,
  })
}

function applyToolResume(
  result: RunResult,
  toolHandlers: Record<string, ToolHandler> | undefined,
  counters: Map<string, number>,
): void {
  if (result.status !== 'yielded_tool') return

  for (const call of result.yieldedTools) {
    const data = resolveToolCall(call.name, call.args, toolHandlers, counters)
    result.session.input.tool({ callId: call.callId, input: data })
  }
}

function resolveToolCall(
  name: string,
  args: unknown,
  toolHandlers: Record<string, ToolHandler> | undefined,
  counters: Map<string, number>,
): unknown {
  const handler = toolHandlers?.[name]
  if (!handler) {
    throw new Error(`No handler for tool '${name}'. Add it to the 'toolHandlers' option.`)
  }

  if (typeof handler === 'function') {
    return handler(args)
  }

  const index = counters.get(name) ?? 0
  if (index >= handler.length) {
    throw new Error(`Tool '${name}' handler exhausted after ${handler.length} responses.`)
  }
  counters.set(name, index + 1)
  return handler[index]
}
