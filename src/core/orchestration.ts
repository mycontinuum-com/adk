import type {
  Runnable,
  SpawnHandle,
  DispatchHandle,
  CallResult,
  CallOptions,
  SpawnOptions,
  DispatchOptions,
  RunResult,
  StreamEvent,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationEndReason,
  UserEvent,
  InvocationContext,
  SessionService,
  SubRunner,
} from '../types';
import { BaseSession, createEventId } from '../session';
import { createInvocationId } from './invocation';
import type { EventChannel } from '../channels';

function statusToEndReason(status: RunResult['status']): InvocationEndReason {
  return status === 'yielded' ? 'completed' : status;
}

async function drainGenerator<T>(
  stream: AsyncGenerator<unknown, T>,
): Promise<T> {
  let iterResult = await stream.next();
  while (!iterResult.done) {
    iterResult = await stream.next();
  }
  return iterResult.value;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function emitHandoffStart(
  session: BaseSession,
  sessionService: SessionService,
  onStream: ((e: StreamEvent) => void) | undefined,
  agent: Runnable,
  invocationId: string,
  handoffType: 'call' | 'spawn' | 'dispatch',
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
  };
  await sessionService.appendEvent(session, event);
  onStream?.(event);
}

async function emitHandoffEnd(
  session: BaseSession,
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
  };
  await sessionService.appendEvent(session, event);
  onStream?.(event);
}

async function emitHandoffEndError(
  session: BaseSession,
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
  };
  await sessionService.appendEvent(session, event);
  onStream?.(event);
}

async function emitMessage(
  session: BaseSession,
  sessionService: SessionService,
  onStream: ((e: StreamEvent) => void) | undefined,
  message: string,
  invocationId: string,
  agentName: string,
) {
  const event: UserEvent = {
    id: createEventId(),
    type: 'user',
    createdAt: Date.now(),
    text: message,
    invocationId,
    agentName,
  };
  await sessionService.appendEvent(session, event);
  onStream?.(event);
}

export function createSpawnHandler(deps: {
  session: BaseSession;
  sessionService: SessionService;
  invocationId: string;
  subRunner?: SubRunner;
  onStream?: (e: StreamEvent) => void;
  signal?: AbortSignal;
  callId?: string;
  channel?: EventChannel;
}) {
  const {
    session,
    sessionService,
    invocationId,
    subRunner,
    onStream,
    signal,
    callId,
    channel,
  } = deps;

  return (agent: Runnable, options?: SpawnOptions): SpawnHandle => {
    if (!subRunner) {
      throw new Error(
        'Orchestration methods (call/spawn/dispatch) require a runner context. ' +
          'This usually means the tool is being executed outside of BaseRunner.run(). ' +
          'Ensure your agent is executed via BaseRunner.',
      );
    }

    const spawnInvocationId = createInvocationId();
    let abortController: AbortController | undefined;

    session.inheritTempState(
      invocationId,
      spawnInvocationId,
      options?.tempState,
    );

    const spawnedPromise = (async (): Promise<{
      status: 'completed' | 'error' | 'aborted';
      output?: unknown;
      error?: string;
    }> => {
      if (signal?.aborted) {
        await emitHandoffEndError(
          session,
          sessionService,
          onStream,
          agent,
          spawnInvocationId,
          invocationId,
          new Error('Aborted before start'),
        );
        channel?.complete({ status: 'aborted', iterations: 0 });
        return { status: 'aborted' };
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
        );

        if (options?.message) {
          await emitMessage(
            session,
            sessionService,
            onStream,
            options.message,
            spawnInvocationId,
            agent.name,
          );
        }

        const stream = subRunner.run(agent, invocationId, {
          id: spawnInvocationId,
          managed: true,
        });

        abortController = new AbortController();
        const abortHandler = signal
          ? () => {
              stream.return?.({
                status: 'aborted',
                session,
                iterations: 0,
                runnable: agent,
                stepEvents: [],
              });
            }
          : undefined;

        signal?.addEventListener('abort', abortHandler!, { once: true });

        let result: RunResult;
        try {
          if (channel?.registerGenerator) {
            const { result: genResult, error } =
              await channel.registerGenerator(spawnInvocationId, stream);
            if (error) throw error;
            result = genResult as RunResult;
          } else {
            result = await drainGenerator(stream);
          }
        } finally {
          if (abortHandler) {
            signal?.removeEventListener('abort', abortHandler);
          }
        }

        session.clearTempState(spawnInvocationId);

        await emitHandoffEnd(
          session,
          sessionService,
          onStream,
          agent,
          spawnInvocationId,
          invocationId,
          result,
        );

        const status =
          result.status === 'completed'
            ? 'completed'
            : result.status === 'error'
              ? 'error'
              : 'aborted';

        return {
          status,
          output: result.status === 'completed' ? result.output : undefined,
          error: result.status === 'error' ? result.error : undefined,
        };
      } catch (error) {
        session.clearTempState(spawnInvocationId);
        await emitHandoffEndError(
          session,
          sessionService,
          onStream,
          agent,
          spawnInvocationId,
          invocationId,
          error,
        );
        return {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();

    session.trackSpawnedTask(
      spawnInvocationId,
      agent.name,
      spawnedPromise.then(() => {}),
    );

    const wait = async () => {
      if (options?.timeout) {
        return withTimeout(
          spawnedPromise,
          options.timeout,
          `Spawned agent '${agent.name}' timed out after ${options.timeout}ms`,
        );
      }
      return spawnedPromise;
    };

    return {
      invocationId: spawnInvocationId,
      agentName: agent.name,
      wait,
      abort: () => abortController?.abort(),
    };
  };
}

export function createCallHandler(deps: {
  session: BaseSession;
  sessionService: SessionService;
  invocationId: string;
  subRunner?: SubRunner;
  onStream?: (e: StreamEvent) => void;
  signal?: AbortSignal;
  callId?: string;
}) {
  const { session, sessionService, invocationId, subRunner, onStream, callId } =
    deps;

  return async (
    agent: Runnable,
    options?: CallOptions,
  ): Promise<CallResult> => {
    if (!subRunner) {
      throw new Error(
        'Orchestration methods (call/spawn/dispatch) require a runner context. ' +
          'This usually means the tool is being executed outside of BaseRunner.run(). ' +
          'Ensure your agent is executed via BaseRunner.',
      );
    }

    const callInvocationId = createInvocationId();

    session.inheritTempState(
      invocationId,
      callInvocationId,
      options?.tempState,
    );

    await emitHandoffStart(
      session,
      sessionService,
      onStream,
      agent,
      callInvocationId,
      'call',
      invocationId,
      callId,
    );

    if (options?.message) {
      await emitMessage(
        session,
        sessionService,
        onStream,
        options.message,
        callInvocationId,
        agent.name,
      );
    }

    const stream = subRunner.run(agent, invocationId, {
      id: callInvocationId,
      managed: true,
    });

    let result;
    if (options?.timeout) {
      result = await withTimeout(
        drainGenerator(stream),
        options.timeout,
        `Call to agent '${agent.name}' timed out after ${options.timeout}ms`,
      );
    } else {
      result = await drainGenerator(stream);
    }

    if (result.status === 'yielded') {
      throw new Error(
        `Called agent '${agent.name}' yielded, which is not supported in ctx.call(). ` +
          'For human-in-the-loop patterns, use yielding tools directly in the parent agent ' +
          'rather than calling an agent that contains yielding tools.',
      );
    }

    if (result.status === 'transferred' && result.transfer) {
      return {
        status: 'transferred',
        iterations: result.iterations,
        transfer: {
          agent: result.transfer.agent,
          message: result.transfer.message,
        },
      };
    }

    await emitHandoffEnd(
      session,
      sessionService,
      onStream,
      agent,
      callInvocationId,
      invocationId,
      result,
    );

    session.clearTempState(callInvocationId);

    const lastAssistant = [...session.events]
      .reverse()
      .find(
        (e) => e.type === 'assistant' && e.invocationId === callInvocationId,
      );

    const output =
      result.status === 'completed' && result.output !== undefined
        ? result.output
        : lastAssistant?.type === 'assistant'
          ? lastAssistant.text
          : undefined;

    return {
      status:
        result.status === 'completed'
          ? 'completed'
          : result.status === 'error'
            ? 'error'
            : result.status === 'aborted'
              ? 'aborted'
              : 'max_steps',
      output,
      iterations: result.iterations,
      error: result.status === 'error' ? result.error : undefined,
    };
  };
}

export function createDispatchHandler(deps: {
  session: BaseSession;
  sessionService: SessionService;
  invocationId: string;
  subRunner?: SubRunner;
  onStream?: (e: StreamEvent) => void;
  signal?: AbortSignal;
  callId?: string;
  channel?: EventChannel;
}) {
  const {
    session,
    sessionService,
    invocationId,
    subRunner,
    onStream,
    callId,
    channel,
  } = deps;

  return (agent: Runnable, options?: DispatchOptions): DispatchHandle => {
    if (!subRunner) {
      throw new Error(
        'Orchestration methods (call/spawn/dispatch) require a runner context. ' +
          'This usually means the tool is being executed outside of BaseRunner.run(). ' +
          'Ensure your agent is executed via BaseRunner.',
      );
    }

    const dispatchInvocationId = createInvocationId();

    session.inheritTempState(
      invocationId,
      dispatchInvocationId,
      options?.tempState,
    );

    (async () => {
      await emitHandoffStart(
        session,
        sessionService,
        onStream,
        agent,
        dispatchInvocationId,
        'dispatch',
        invocationId,
        callId,
      );

      if (options?.message) {
        await emitMessage(
          session,
          sessionService,
          onStream,
          options.message,
          dispatchInvocationId,
          agent.name,
        );
      }

      try {
        const stream = subRunner.run(agent, invocationId, {
          id: dispatchInvocationId,
          managed: true,
        });

        let result: RunResult;
        if (channel?.registerGenerator) {
          const { result: genResult, error } = await channel.registerGenerator(
            dispatchInvocationId,
            stream,
          );
          if (error) throw error;
          result = genResult as RunResult;
        } else {
          result = await drainGenerator(stream);
        }

        await emitHandoffEnd(
          session,
          sessionService,
          onStream,
          agent,
          dispatchInvocationId,
          invocationId,
          result,
        );
      } catch (error) {
        await emitHandoffEndError(
          session,
          sessionService,
          onStream,
          agent,
          dispatchInvocationId,
          invocationId,
          error,
        );
      } finally {
        session.clearTempState(dispatchInvocationId);
      }
    })().catch((err) => {
      console.error(
        `[ADK] Unhandled error in dispatched agent '${agent.name}' (${dispatchInvocationId}):`,
        err,
      );
    });

    return {
      invocationId: dispatchInvocationId,
      agentName: agent.name,
    };
  };
}

export function createOrchestrationContext(deps: {
  session: BaseSession;
  sessionService: SessionService;
  invocationId: string;
  subRunner?: SubRunner;
  onStream?: (e: StreamEvent) => void;
  signal?: AbortSignal;
  callId?: string;
  channel?: EventChannel;
}): {
  call: InvocationContext['call'];
  spawn: InvocationContext['spawn'];
  dispatch: InvocationContext['dispatch'];
} {
  return {
    call: createCallHandler(deps),
    spawn: createSpawnHandler(deps),
    dispatch: createDispatchHandler(deps),
  };
}
