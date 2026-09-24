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
import type { AnnotationEvent, Event } from '../types/events'
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

/** Consumes a nested run, forwarding each event into the enclosing run's stream. */
async function forward<T>(
  stream: AsyncGenerator<StreamEvent, T>,
  channel: EventChannel | undefined,
): Promise<T> {
  let iterResult = await stream.next()
  while (!iterResult.done) {
    channel?.push(iterResult.value)
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

async function append<E extends Event>(
  session: Session,
  sessionService: SessionService,
  event: E,
): Promise<E> {
  await sessionService.appendEvent(session, event)
  return event
}

function handoffStartEvent(
  agent: Runnable,
  invocationId: string,
  handoffType: 'run' | 'spawn' | 'dispatch',
  parentInvocationId: string,
  callId?: string,
): InvocationStartEvent {
  return {
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
}

function handoffEndEvent(
  agent: Runnable,
  invocationId: string,
  parentInvocationId: string,
  result: RunResult,
): InvocationEndEvent {
  return {
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
}

function handoffErrorEvent(
  agent: Runnable,
  invocationId: string,
  parentInvocationId: string,
  error: unknown,
): InvocationEndEvent {
  return {
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

function messageEvent(
  message: string | MessageInput,
  invocationId: string,
  agentName: string,
): UserEvent {
  const text = typeof message === 'string' ? message : (message.text ?? '')
  const media = typeof message === 'string' ? undefined : resolveMedia(message)

  return {
    id: createEventId(),
    type: 'user',
    createdAt: Date.now(),
    text,
    media: media?.length ? media : undefined,
    invocationId,
    agentName,
  }
}

interface HandoffDeps {
  session: Session
  sessionService: SessionService
  invocationId: string
  callId?: string
}

/**
 * A nested run with its handoff boundary: the start, the input message, the nested run's own events
 * and the end, each appended to the session and then yielded, so the enclosing run streams them in
 * ledger order. A handoff left open (a ctx.run that yielded or transferred) keeps its temp state
 * and appends no end.
 */
async function* handoff(
  deps: HandoffDeps,
  agent: Runnable,
  handoffType: 'run' | 'spawn' | 'dispatch',
  childInvocationId: string,
  message: string | MessageInput | undefined,
  run: AsyncGenerator<StreamEvent, RunResult>,
  leavesOpen: (result: RunResult) => boolean = () => false,
): AsyncGenerator<StreamEvent, RunResult> {
  const { session, sessionService, invocationId, callId } = deps
  let result: RunResult
  try {
    yield await append(
      session,
      sessionService,
      handoffStartEvent(agent, childInvocationId, handoffType, invocationId, callId),
    )
    if (message) {
      yield await append(
        session,
        sessionService,
        messageEvent(message, childInvocationId, agent.name),
      )
    }
    result = yield* run
  } catch (error) {
    ;(session as BaseSession).clearTempState(childInvocationId)
    yield await append(
      session,
      sessionService,
      handoffErrorEvent(agent, childInvocationId, invocationId, error),
    )
    throw error
  }
  if (leavesOpen(result)) return result
  ;(session as BaseSession).clearTempState(childInvocationId)
  yield await append(
    session,
    sessionService,
    handoffEndEvent(agent, childInvocationId, invocationId, result),
  )
  return result
}

/** Runs a concurrent handoff as its own producer on the run's channel, which stays open for it. */
async function runConcurrently(
  id: string,
  stream: AsyncGenerator<StreamEvent, RunResult>,
  channel: EventChannel | undefined,
): Promise<RunResult> {
  if (!channel?.registerGenerator) return forward(stream, channel)
  const { result, error } = await channel.registerGenerator(id, stream)
  if (error) throw error
  return result as RunResult
}

interface OrchestrationDeps extends HandoffDeps {
  subRunner?: SubRunner
  signal?: AbortSignal
  channel?: EventChannel
}

function requireSubRunner(subRunner: SubRunner | undefined): SubRunner {
  if (!subRunner) {
    throw new Error(
      'Orchestration methods (run/spawn/dispatch) require a runner context. ' +
        'This usually means the tool is being executed outside of BaseRunner.run(). ' +
        'Ensure your agent is executed via BaseRunner.',
    )
  }
  return subRunner
}

function createSpawnHandler(deps: OrchestrationDeps) {
  const { session, sessionService, invocationId, signal, channel } = deps

  return (agent: Runnable, optionsOrInput?: string | HandoffOptions): SpawnHandle => {
    const subRunner = requireSubRunner(deps.subRunner)
    const resolved = resolveHandoffInput(optionsOrInput)
    const timeout = typeof optionsOrInput === 'object' ? optionsOrInput?.timeout : undefined

    const spawnInvocationId = createInvocationId()
    let abortController: AbortController | undefined

    ;(session as BaseSession).inheritTempState(invocationId, spawnInvocationId, resolved.state)

    const spawnedPromise = (async (): Promise<SpawnResult> => {
      if (signal?.aborted) {
        channel?.push(
          await append(
            session,
            sessionService,
            handoffErrorEvent(
              agent,
              spawnInvocationId,
              invocationId,
              new Error('Aborted before start'),
            ),
          ),
        )
        return { status: 'aborted', output: { items: [] } }
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
        result = await runConcurrently(
          spawnInvocationId,
          handoff(deps, agent, 'spawn', spawnInvocationId, resolved.message, stream),
          channel,
        )
      } catch (error) {
        ;(session as BaseSession).clearTempState(spawnInvocationId)
        return {
          status: 'error',
          output: { items: [] },
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        if (abortHandler) {
          signal?.removeEventListener('abort', abortHandler)
        }
      }

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

export function createRunHandler(deps: OrchestrationDeps) {
  const { session, invocationId, channel } = deps

  return async (
    agent: Runnable,
    optionsOrInput?: string | HandoffOptions,
  ): Promise<SubRunResult> => {
    const subRunner = requireSubRunner(deps.subRunner)
    deps.signal?.throwIfAborted()
    const resolved = resolveHandoffInput(optionsOrInput)
    const timeout = typeof optionsOrInput === 'object' ? optionsOrInput?.timeout : undefined

    const callInvocationId = createInvocationId()

    ;(session as BaseSession).inheritTempState(invocationId, callInvocationId, resolved.state)

    const stream = handoff(
      deps,
      agent,
      'run',
      callInvocationId,
      resolved.message,
      subRunner.run(agent, invocationId, { id: callInvocationId, managed: true }),
      (result) =>
        result.status === 'yielded_tool' ||
        (result.status === 'transferred' && result.transfer !== undefined),
    )

    // The calling tool is awaiting this run, so its events belong in the stream at this point.
    const complete = channel?.registerOperation()
    const forwarded = forward(stream, channel).finally(() => complete?.())
    const result = timeout
      ? await withTimeout(
          forwarded,
          timeout,
          `ctx.run('${agent.name}') timed out after ${timeout}ms`,
        )
      : await forwarded

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

function createDispatchHandler(deps: OrchestrationDeps) {
  const { session, invocationId, channel } = deps

  return (agent: Runnable, optionsOrInput?: string | HandoffOptions): DispatchHandle => {
    const subRunner = requireSubRunner(deps.subRunner)
    const resolved = resolveHandoffInput(optionsOrInput)

    const dispatchInvocationId = createInvocationId()

    ;(session as BaseSession).inheritTempState(invocationId, dispatchInvocationId, resolved.state)

    runConcurrently(
      dispatchInvocationId,
      handoff(
        deps,
        agent,
        'dispatch',
        dispatchInvocationId,
        resolved.message,
        subRunner.run(agent, invocationId, { id: dispatchInvocationId, managed: true }),
      ),
      channel,
    ).catch((err) => {
      ;(session as BaseSession).clearTempState(dispatchInvocationId)
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

export function createOrchestrationContext<S extends StateSchema = StateSchema>(
  deps: OrchestrationDeps,
): OrchestrationContext<S> {
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
    deps.channel?.push(event)
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
