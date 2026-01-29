import { useState, useCallback, useRef } from 'react';
import type {
  Runnable,
  Event,
  StreamEvent,
  RunResult,
  ToolCallEvent,
} from '../../types';
import { BaseRunner } from '../../core';
import { BaseSession } from '../../session';
import type { CLIOptions, CLIStatus } from '../types';
import { useOnTick } from '../components/SpinnerContext';

export type CLIEvent = Event | StreamEvent;

export interface UseAgentState {
  status: CLIStatus;
  events: CLIEvent[];
  error: string | null;
  pendingCalls: ToolCallEvent[];
  executingCallIds: Set<string>;
  awaitingInput: boolean;
  yieldedInvocationId: string | null;
  iterations: number;
  startTime: number | null;
  endTime: number | null;
  result: RunResult | null;
}

export interface UseAgentReturn extends UseAgentState {
  run: (prompt: string) => void;
  resume: (responses: Map<string, unknown>) => void;
  resumeWithInput: (message: string) => void;
  reset: () => void;
  runner: BaseRunner;
  session: BaseSession;
}

export interface UseAgentConfig {
  runner?: BaseRunner;
  session?: BaseSession;
  options?: CLIOptions;
}

const DELTA_TYPES = new Set(['thought_delta', 'assistant_delta']);
const STREAMING_FLUSH_INTERVAL_MS = 100;
const MIN_FLUSH_EVENTS = 5;

function applyRunResult(
  result: RunResult,
  setState: React.Dispatch<React.SetStateAction<UseAgentState>>,
): void {
  if (result.status === 'yielded') {
    setState((prev) => ({
      ...prev,
      status: 'yielded',
      pendingCalls: result.pendingCalls,
      executingCallIds: new Set<string>(),
      awaitingInput: result.awaitingInput ?? false,
      yieldedInvocationId: result.yieldedInvocationId ?? null,
      iterations: result.iterations,
      result,
    }));
  } else if (result.status === 'error') {
    setState((prev) => ({
      ...prev,
      status: 'error',
      error: result.error,
      executingCallIds: new Set<string>(),
      iterations: result.iterations,
      endTime: Date.now(),
      result,
    }));
  } else {
    setState((prev) => ({
      ...prev,
      status: 'completed',
      executingCallIds: new Set<string>(),
      iterations: result.iterations,
      endTime: Date.now(),
      result,
    }));
  }
}

export function useAgent(
  runnable: Runnable,
  config: UseAgentConfig = {},
): UseAgentReturn {
  const {
    runner: externalRunner,
    session: externalSession,
    options = {},
  } = config;

  const [state, setState] = useState<UseAgentState>({
    status: 'idle',
    events: [],
    error: null,
    pendingCalls: [],
    executingCallIds: new Set<string>(),
    awaitingInput: false,
    yieldedInvocationId: null,
    iterations: 0,
    startTime: null,
    endTime: null,
    result: null,
  });

  const sessionRef = useRef<BaseSession>(
    externalSession ?? new BaseSession('cli'),
  );
  const runnerRef = useRef<BaseRunner>(
    externalRunner ?? new BaseRunner({ middleware: options.middleware }),
  );
  const eventBufferRef = useRef<StreamEvent[]>([]);
  const lastFlushTimeRef = useRef<number>(0);
  const pendingFlushRef = useRef<boolean>(false);

  const flushEvents = useCallback(() => {
    if (eventBufferRef.current.length === 0) {
      pendingFlushRef.current = false;
      return;
    }

    const eventsToFlush = eventBufferRef.current;
    eventBufferRef.current = [];
    pendingFlushRef.current = false;
    lastFlushTimeRef.current = Date.now();

    setState((prev) => ({
      ...prev,
      events: [...prev.events, ...eventsToFlush],
    }));
  }, []);

  const scheduleFlush = useCallback(() => {
    const now = Date.now();
    const timeSinceLastFlush = now - lastFlushTimeRef.current;
    const bufferSize = eventBufferRef.current.length;

    if (
      bufferSize >= MIN_FLUSH_EVENTS ||
      timeSinceLastFlush >= STREAMING_FLUSH_INTERVAL_MS
    ) {
      flushEvents();
    } else if (!pendingFlushRef.current) {
      pendingFlushRef.current = true;
    }
  }, [flushEvents]);

  useOnTick(() => {
    if (pendingFlushRef.current || eventBufferRef.current.length > 0) {
      const now = Date.now();
      const timeSinceLastFlush = now - lastFlushTimeRef.current;
      if (timeSinceLastFlush >= STREAMING_FLUSH_INTERVAL_MS) {
        flushEvents();
      }
    }
  });

  const handleStreamEvent = useCallback(
    (event: StreamEvent) => {
      eventBufferRef.current.push(event);

      if (event.type === 'tool_call') {
        const toolCall = event as ToolCallEvent;
        if (!toolCall.yields) {
          setState((prev) => ({
            ...prev,
            executingCallIds: new Set([
              ...prev.executingCallIds,
              toolCall.callId,
            ]),
          }));
        }
      } else if (event.type === 'tool_result') {
        const toolResult = event as { callId: string };
        setState((prev) => {
          const next = new Set(prev.executingCallIds);
          next.delete(toolResult.callId);
          return { ...prev, executingCallIds: next };
        });
      }

      if (DELTA_TYPES.has(event.type)) {
        scheduleFlush();
      } else {
        flushEvents();
      }
    },
    [flushEvents, scheduleFlush],
  );

  const run = useCallback(
    async (prompt: string) => {
      const session = sessionRef.current;
      const runner = runnerRef.current;

      session.addMessage(prompt);

      const initialEvents = [...session.events];
      eventBufferRef.current = [];

      setState((prev) => ({
        ...prev,
        status: 'running',
        events: initialEvents,
        error: null,
        pendingCalls: [],
        executingCallIds: new Set<string>(),
        awaitingInput: false,
        yieldedInvocationId: null,
        iterations: 0,
        startTime: Date.now(),
        endTime: null,
      }));

      try {
        const result = await runner.run(runnable, session, {
          onStream: handleStreamEvent,
        });
        flushEvents();
        applyRunResult(result, setState);
      } catch (err) {
        flushEvents();
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          endTime: Date.now(),
        }));
      }
    },
    [runnable, handleStreamEvent, flushEvents],
  );

  const resume = useCallback(
    async (responses: Map<string, unknown>) => {
      const session = sessionRef.current;
      const runner = runnerRef.current;

      const addedEvents: Event[] = [];
      for (const [callId, input] of responses) {
        session.addToolInput(callId, input);
        const inputEvent = session.events.find(
          (e) =>
            e.type === 'tool_input' &&
            (e as { callId: string }).callId === callId,
        );
        if (inputEvent) {
          addedEvents.push(inputEvent);
        }
      }

      eventBufferRef.current = [];

      setState((prev) => ({
        ...prev,
        status: 'running',
        events: [...prev.events, ...addedEvents],
        pendingCalls: [],
        executingCallIds: new Set<string>(),
        awaitingInput: false,
      }));

      try {
        const result = await runner.run(runnable, session, {
          onStream: handleStreamEvent,
        });
        flushEvents();
        applyRunResult(result, setState);
      } catch (err) {
        flushEvents();
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          endTime: Date.now(),
        }));
      }
    },
    [runnable, handleStreamEvent, flushEvents],
  );

  const resumeWithInput = useCallback(
    async (message: string) => {
      const session = sessionRef.current;
      const runner = runnerRef.current;

      session.addMessage(message, state.yieldedInvocationId ?? undefined);

      const userEvent = session.events[session.events.length - 1];

      eventBufferRef.current = [];

      setState((prev) => ({
        ...prev,
        status: 'running',
        events: [...prev.events, userEvent],
        pendingCalls: [],
        executingCallIds: new Set<string>(),
        awaitingInput: false,
        yieldedInvocationId: null,
      }));

      try {
        const result = await runner.run(runnable, session, {
          onStream: handleStreamEvent,
        });
        flushEvents();
        applyRunResult(result, setState);
      } catch (err) {
        flushEvents();
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          endTime: Date.now(),
        }));
      }
    },
    [runnable, handleStreamEvent, flushEvents, state.yieldedInvocationId],
  );

  const reset = useCallback(() => {
    eventBufferRef.current = [];
    sessionRef.current = externalSession ?? new BaseSession('cli');
    runnerRef.current =
      externalRunner ?? new BaseRunner({ middleware: options.middleware });
    setState({
      status: 'idle',
      events: [],
      error: null,
      pendingCalls: [],
      executingCallIds: new Set<string>(),
      awaitingInput: false,
      yieldedInvocationId: null,
      iterations: 0,
      startTime: null,
      endTime: null,
      result: null,
    });
  }, [externalSession, externalRunner, options.middleware]);

  return {
    ...state,
    run,
    resume,
    resumeWithInput,
    reset,
    runner: runnerRef.current,
    session: sessionRef.current,
  };
}
