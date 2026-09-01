import type { EventChannel } from '../channels'
import type {
  Runnable,
  SpawnHandle,
  SpawnResult,
  DispatchHandle,
  SubRunResult,
  HandoffOptions,
  RunResult,
  Output,
  StreamEvent,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationEndReason,
  UserEvent,
  OrchestrationContext,
  SessionService,
  SubRunner,
  MessageInput,
  MediaPart,
  NoteOpts,
} from '../types'
import type { Session } from '../types'
import type { AnnotationEvent } from '../types/events'
import type { StateSchema } from '../types/schema'

import { createEventId, BaseSession } from '../session'
import { createInvocationId } from './invocation'

function statusToEndReason(status: RunResult['status']): InvocationEndReason {
  if (
    status === 'yielded_tool' ||
    status === 'yielded_message' ||
    status === 'skipped' ||
    status === 'terminated'
  )
    return 'completed'
  return status
}

async function drainGenerator<T>(stream: AsyncGenerator<unknown, T>): Promise<T> {
  let iterResult = await stream.next()
  while (!iterResult.done) {
    iterResult = await stream.next()
  }
  return iterResult.value
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function emitHandoffStart(
  session: Session,
  sessionService: SessionService,
  onStream: ((e: StreamEvent) => void) | undefined,
  agent: Runnable,
  invocationId: string,
  handoffType: 'run' | 'spawn' | 'dispatch',
  parentInvocationId: string,
  callId?: string,
) {
  const event: InvocationStartEvent = {
    id: createEventId(),
    type: 'invocation_start',
    createdAt: Date.now(),
    invocationId,
    agentName: agent.name,
    kind: agent.kind,
    parentInvocationId,
    handoffOrigin: {
      type: handoffType,
      invocationId: parentInvocationId,
      callId,
    },
  }
  await sessionService.appendEvent(session, event)
  onStream?.(event)
}

async function emitHandoffEnd(
  session: Session,
  sessionService: SessionService,
  onStream: ((e: StreamEvent) => void) | undefined,
  agent: Runnable,
  invocationId: string,
  parentInvocationId: string,
  result: RunResult,
) {
  const event: InvocationEndEvent = {
    id: createEventId(),
    type: 'invocation_end',
    createdAt: Date.now(),
    invocationId,
    agentName: agent.name,
    kind: agent.kind,
    parentInvocationId,
    reason: statusToEndReason(result.status),
    iterations: result.iterations,
    error: result.status === 'error' ? result.error : undefined,
  }
  await sessionService.appendEvent(session, event)
  onStream?.(event)
}

async function emitHandoffEndError(
  session: Session,
  sessionService: SessionService,
  onStream: ((e: StreamEvent) => void) | undefined,
  agent: Runnable,
  invocationId: string,
  parentInvocationId: string,
  error: unknown,
) {
  const event: InvocationEndEvent = {
    id: createEventId(),
    type: 'invocation_end',
    createdAt: Date.now(),
    invocationId,
    agentName: agent.name,
    kind: agent.kind,
    parentInvocationId,
    reason: 'error',
    error: error instanceof Error ? error.message : String(error),
  }
  await sessionService.appendEvent(session, event)
  onStream?.(event)
}

function resolveHandoffInput(optionsOrInput?: string | HandoffOptions): {
  message?: string | MessageInput
  state?: Record<string, unknown>
} {
  if (optionsOrInput === undefined) return {}
  if (typeof optionsOrInput === 'string') return { message: optionsOrInput }
  if (optionsOrInput.input === undefined) return {}
  if (typeof optionsOrInput.input === 'string') return { message: optionsOrInput.input }
  return { message: optionsOrInput.input.message, state: optionsOrInput.input.state }
}

function resolveMedia(input: MessageInput): MediaPart[] | undefined {
  return input.media?.length ? input.media : undefined
}

async function emitMessage(
  session: Session,
  sessionService: SessionService,
  onStream: ((e: StreamEvent) => void) | undefined,
  message: string | MessageInput,
  invocationId: string,
  agentName: string,
) {
  const text = typeof message === 'string' ? message : (message.text ?? '')
  const media = typeof message === 'string' ? undefined : resolveMedia(message)

  const event: UserEvent = {
    id: createEventId(),
    type: 'user',
    createdAt: Date.now(),
    text,
    media: media?.length ? media : undefined,
    invocationId,
    agentName,
  }
  await sessionService.appendEvent(session, event)
  onStream?.(event)
}

export function createSpawnHandler(deps: {
  session: Session
  sessionService: SessionService
  invocationId: string
  subRunner?: SubRunner
  onStream?: (e: StreamEvent) => void
  signal?: AbortSignal
  callId?: string
  channel?: EventChannel
}) {
  const { session, sessionService, invocationId, subRunner, onStream, signal, callId, channel } =
    deps

  return (agent: Runnable, optionsOrInput?: string | HandoffOptions): SpawnHandle => {
    if (!subRunner) {
      throw new Error(
        'Orchestration methods (run/spawn/dispatch) require a runner context. ' +
          'This usually means the tool is being executed outside of BaseRunner.run(). ' +
          'Ensure your agent is executed via BaseRunner.',
      )
    }

    const resolved = resolveHandoffInput(optionsOrInput)
    const timeout = typeof optionsOrInput === 'object' ? optionsOrInput?.timeout : undefined

    const spawnInvocationId = createInvocationId()
    let abortController: AbortController | undefined

    ;(session as BaseSession).inheritTempState(invocationId, spawnInvocationId, resolved.state)

    const spawnedPromise = (async (): Promise<SpawnResult> => {
      if (signal?.aborted) {
        await emitHandoffEndError(
          session,
          sessionService,
          onStream,
          agent,
          spawnInvocationId,
          invocationId,
          new Error('Aborted before start'),
        )
        channel?.complete({ status: 'aborted', iterations: 0 })
        return { status: 'aborted', output: { items: [] } }
      }

      try {
        await emitHandoffStart(
          session,
          sessionService,
          onStream,
          agent,
          spawnInvocationId,
          'spawn',
          invocationId,
          callId,
        )

        if (resolved.message) {
          await emitMessage(
            session,
            sessionService,
            onStream,
            resolved.message,
            spawnInvocationId,
            agent.name,
          )
        }

        const stream = subRunner.run(agent, invocationId, {
          id: spawnInvocationId,
          managed: true,
        })

        abortController = new AbortController()
        const emptyOutput: Output = { items: [] }
        const abortHandler = signal
          ? () => {
              stream.return?.({
                status: 'aborted',
                session,
                state: session.state,
                iterations: 0,
                runnable: agent,
                output: emptyOutput,
              })
            }
          : undefined

        signal?.addEventListener('abort', abortHandler!, { once: true })

        let result: RunResult
        try {
          if (channel?.registerGenerator) {
            const { result: genResult, error } = await channel.registerGenerator(
              spawnInvocationId,
              stream,
            )
            if (error) throw error
            result = genResult as RunResult
          } else {
            result = await drainGenerator(stream)
          }
        } finally {
          if (abortHandler) {
            signal?.removeEventListener('abort', abortHandler)
          }
        }

        ;(session as BaseSession).clearTempState(spawnInvocationId)

        await emitHandoffEnd(
          session,
          sessionService,
          onStream,
          agent,
          spawnInvocationId,
          invocationId,
          result,
        )

        const status =
          result.status === 'completed'
            ? 'completed'
            : result.status === 'error'
              ? 'error'
              : 'aborted'

        return {
          status,
          output: {
            text: result.output.text,
            value: result.output.value,
            items: result.output.items,
            media: result.output.media,
          },
          error: result.status === 'error' ? result.error : undefined,
        }
      } catch (error) {
        ;(session as BaseSession).clearTempState(spawnInvocationId)
        await emitHandoffEndError(
          session,
          sessionService,
          onStream,
          agent,
          spawnInvocationId,
          invocationId,
          error,
        )
        return {
          status: 'error',
          output: { items: [] },
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })()

    ;(session as BaseSession).trackSpawnedTask(
      spawnInvocationId,
      agent.name,
      spawnedPromise.then(() => {}),
    )

    const wait = async () => {
      if (timeout) {
        return withTimeout(
          spawnedPromise,
          timeout,
          `Spawned agent '${agent.name}' timed out after ${timeout}ms`,
        )
      }
      return spawnedPromise
    }

    return {
      invocationId: spawnInvocationId,
      agentName: agent.name,
      wait,
      abort: () => abortController?.abort(),
    }
  }
}

export function createRunHandler(deps: {
  session: Session
  sessionService: SessionService
  invocationId: string
  subRunner?: SubRunner
  onStream?: (e: StreamEvent) => void
  signal?: AbortSignal
  callId?: string
}) {
  const { session, sessionService, invocationId, subRunner, onStream, callId } = deps

  return async (
    agent: Runnable,
    optionsOrInput?: string | HandoffOptions,
  ): Promise<SubRunResult> => {
    if (!subRunner) {
      throw new Error(
        'Orchestration methods (run/spawn/dispatch) require a runner context. ' +
          'This usually means the tool is being executed outside of BaseRunner.run(). ' +
          'Ensure your agent is executed via BaseRunner.',
      )
    }

    const resolved = resolveHandoffInput(optionsOrInput)
    const timeout = typeof optionsOrInput === 'object' ? optionsOrInput?.timeout : undefined

    const callInvocationId = createInvocationId()

    ;(session as BaseSession).inheritTempState(invocationId, callInvocationId, resolved.state)

    await emitHandoffStart(
      session,
      sessionService,
      onStream,
      agent,
      callInvocationId,
      'run',
      invocationId,
      callId,
    )

    if (resolved.message) {
      await emitMessage(
        session,
        sessionService,
        onStream,
        resolved.message,
        callInvocationId,
        agent.name,
      )
    }

    const stream = subRunner.run(agent, invocationId, {
      id: callInvocationId,
      managed: true,
    })

    let result
    if (timeout) {
      result = await withTimeout(
        drainGenerator(stream),
        timeout,
        `ctx.run('${agent.name}') timed out after ${timeout}ms`,
      )
    } else {
      result = await drainGenerator(stream)
    }

    if (result.status === 'yielded_tool') {
      throw new Error(
        `Called agent '${agent.name}' yielded, which is not supported in ctx.run(). ` +
          'For human-in-the-loop patterns, use yielding tools directly in the parent agent ' +
          'rather than calling an agent that contains yielding tools.',
      )
    }

    if (result.status === 'transferred' && result.transfer) {
      return {
        status: 'transferred',
        output: {
          text: result.output.text,
          value: result.output.value,
          items: result.output.items,
          media: result.output.media,
        },
        iterations: result.iterations,
        transfer: {
          agent: result.transfer.agent,
          message: result.transfer.message,
        },
      }
    }

    await emitHandoffEnd(
      session,
      sessionService,
      onStream,
      agent,
      callInvocationId,
      invocationId,
      result,
    )

    ;(session as BaseSession).clearTempState(callInvocationId)

    const callStatus: SubRunResult['status'] =
      result.status === 'yielded_message' ||
      result.status === 'skipped' ||
      result.status === 'terminated' ||
      result.status === 'max_turns'
        ? 'completed'
        : result.status === 'max_duration' ||
            result.status === 'inactivity_timeout' ||
            result.status === 'disconnected' ||
            result.status === 'participant_left'
          ? 'aborted'
          : result.status

    return {
      status: callStatus,
      output: {
        text: result.output.text,
        value: result.output.value,
        items: result.output.items,
        media: result.output.media,
      },
      iterations: result.iterations,
      error: result.status === 'error' ? result.error : undefined,
    }
  }
}

export function createDispatchHandler(deps: {
  session: Session
  sessionService: SessionService
  invocationId: string
  subRunner?: SubRunner
  onStream?: (e: StreamEvent) => void
  signal?: AbortSignal
  callId?: string
  channel?: EventChannel
}) {
  const { session, sessionService, invocationId, subRunner, onStream, callId, channel } = deps

  return (agent: Runnable, optionsOrInput?: string | HandoffOptions): DispatchHandle => {
    if (!subRunner) {
      throw new Error(
        'Orchestration methods (run/spawn/dispatch) require a runner context. ' +
          'This usually means the tool is being executed outside of BaseRunner.run(). ' +
          'Ensure your agent is executed via BaseRunner.',
      )
    }

    const resolved = resolveHandoffInput(optionsOrInput)

    const dispatchInvocationId = createInvocationId()

    ;(session as BaseSession).inheritTempState(invocationId, dispatchInvocationId, resolved.state)

    ;(async () => {
      await emitHandoffStart(
        session,
        sessionService,
        onStream,
        agent,
        dispatchInvocationId,
        'dispatch',
        invocationId,
        callId,
      )

      if (resolved.message) {
        await emitMessage(
          session,
          sessionService,
          onStream,
          resolved.message,
          dispatchInvocationId,
          agent.name,
        )
      }

      try {
        const stream = subRunner.run(agent, invocationId, {
          id: dispatchInvocationId,
          managed: true,
        })

        let result: RunResult
        if (channel?.registerGenerator) {
          const { result: genResult, error } = await channel.registerGenerator(
            dispatchInvocationId,
            stream,
          )
          if (error) throw error
          result = genResult as RunResult
        } else {
          result = await drainGenerator(stream)
        }

        await emitHandoffEnd(
          session,
          sessionService,
          onStream,
          agent,
          dispatchInvocationId,
          invocationId,
          result,
        )
      } catch (error) {
        await emitHandoffEndError(
          session,
          sessionService,
          onStream,
          agent,
          dispatchInvocationId,
          invocationId,
          error,
        )
      } finally {
        ;(session as BaseSession).clearTempState(dispatchInvocationId)
      }
    })().catch((err) => {
      console.error(
        `[ADK] Unhandled error in dispatched agent '${agent.name}' (${dispatchInvocationId}):`,
        err,
      )
    })

    return {
      invocationId: dispatchInvocationId,
      agentName: agent.name,
    }
  }
}

let callDeprecationWarned = false

export function createOrchestrationContext<S extends StateSchema = StateSchema>(deps: {
  session: Session
  sessionService: SessionService
  invocationId: string
  subRunner?: SubRunner
  onStream?: (e: StreamEvent) => void
  signal?: AbortSignal
  callId?: string
  channel?: EventChannel
}): OrchestrationContext<S> {
  const runHandler = createRunHandler(deps) as OrchestrationContext<S>['run']

  const note = (message: string, opts?: NoteOpts): void => {
    const event: AnnotationEvent = {
      id: createEventId(),
      type: 'annotation',
      kind: opts?.kind ?? 'log',
      invocationId: deps.invocationId,
      agentName: deps.session.appName ?? 'unknown',
      createdAt: Date.now(),
      label: opts?.label,
      message,
      data: opts?.data,
    }
    // BaseSession.pushEvent is the synchronous buffer path (same as appendEvent uses).
    ;(deps.session as unknown as BaseSession).pushEvent(
      event as unknown as import('../types/events').Event,
    )
    deps.onStream?.(event)
  }

  return {
    note,
    run: runHandler,
    call: ((...args: Parameters<typeof runHandler>) => {
      if (!callDeprecationWarned) {
        callDeprecationWarned = true
        console.warn(
          '[adk] ctx.call() is deprecated and will be removed in 0.6.0. Use ctx.run() instead.',
        )
      }
      return (runHandler as Function)(...args)
    }) as OrchestrationContext<S>['call'],
    spawn: createSpawnHandler(deps) as OrchestrationContext<S>['spawn'],
    dispatch: createDispatchHandler(deps) as OrchestrationContext<S>['dispatch'],
  }
}
