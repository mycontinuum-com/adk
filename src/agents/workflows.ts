import type {
  Runnable,
  RunResult,
  RunStatus,
  ToolCallEvent,
  InvocationEndReason,
  Event,
} from '../types';
import type { BaseSession } from '../session';
import type { InvocationBoundaryOptions } from '../core';

export interface WorkflowResult<TRunnable extends Runnable = Runnable> {
  status: RunStatus;
  session: BaseSession;
  iterations: number;
  runnable: TRunnable;
  yieldIndex: number;
  stepEvents: Event[];
  pendingCalls?: ToolCallEvent[];
  awaitingInput?: boolean;
  yieldedInvocationId?: string;
  error?: string;
}

export function createWorkflowResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: BaseSession,
  yieldIndex: number,
  status: RunStatus,
  iterations: number,
  stepEvents: Event[],
  extra?: { pendingCalls?: ToolCallEvent[]; error?: string },
): WorkflowResult<TRunnable> {
  return {
    status,
    session,
    iterations,
    runnable,
    yieldIndex,
    stepEvents,
    ...extra,
  };
}

export function createYieldedResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: BaseSession,
  yieldIndex: number,
  iterations: number,
  stepEvents: Event[],
  pendingCalls: ToolCallEvent[],
): WorkflowResult<TRunnable> {
  return createWorkflowResult(
    runnable,
    session,
    yieldIndex,
    'yielded',
    iterations,
    stepEvents,
    {
      pendingCalls,
    },
  );
}

export function createInputYieldResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: BaseSession,
  yieldIndex: number,
  iterations: number,
  stepEvents: Event[],
  yieldedInvocationId?: string,
): WorkflowResult<TRunnable> {
  return {
    ...createWorkflowResult(
      runnable,
      session,
      yieldIndex,
      'yielded',
      iterations,
      stepEvents,
    ),
    awaitingInput: true,
    yieldedInvocationId,
  };
}

export function createErrorResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: BaseSession,
  yieldIndex: number,
  iterations: number,
  stepEvents: Event[],
  error: string,
): WorkflowResult<TRunnable> {
  return createWorkflowResult(
    runnable,
    session,
    yieldIndex,
    'error',
    iterations,
    stepEvents,
    {
      error,
    },
  );
}

export function createTerminalResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: BaseSession,
  yieldIndex: number,
  iterations: number,
  stepEvents: Event[],
  status: 'completed' | 'aborted' | 'max_steps',
): WorkflowResult<TRunnable> {
  return createWorkflowResult(
    runnable,
    session,
    yieldIndex,
    status,
    iterations,
    stepEvents,
  );
}

export function mapStepResultToWorkflowResult<TRunnable extends Runnable>(
  stepResult: RunResult,
  runnable: TRunnable,
  session: BaseSession,
  yieldIndex: number,
  totalIterations: number,
  stepEvents: Event[],
): WorkflowResult<TRunnable> | null {
  switch (stepResult.status) {
    case 'yielded':
      return createYieldedResult(
        runnable,
        session,
        yieldIndex,
        totalIterations,
        stepEvents,
        stepResult.pendingCalls,
      );
    case 'error':
      return createErrorResult(
        runnable,
        session,
        yieldIndex,
        totalIterations,
        stepEvents,
        stepResult.error,
      );
    case 'aborted':
      return createTerminalResult(
        runnable,
        session,
        yieldIndex,
        totalIterations,
        stepEvents,
        'aborted',
      );
    case 'max_steps':
      return createTerminalResult(
        runnable,
        session,
        yieldIndex,
        totalIterations,
        stepEvents,
        'max_steps',
      );
    default:
      return null;
  }
}

export function workflowResultToRunResult<TRunnable extends Runnable>(
  result: WorkflowResult<TRunnable>,
  runnable: TRunnable,
): RunResult {
  const base = {
    runnable,
    session: result.session,
    iterations: result.iterations,
    stepEvents: result.stepEvents,
  };

  switch (result.status) {
    case 'yielded':
      return {
        ...base,
        status: 'yielded',
        pendingCalls: result.pendingCalls ?? [],
        awaitingInput: result.awaitingInput,
        yieldedInvocationId: result.yieldedInvocationId,
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        error: result.error ?? 'Unknown error',
      };
    case 'aborted':
      return { ...base, status: 'aborted' };
    case 'max_steps':
      return { ...base, status: 'max_steps' };
    default:
      return { ...base, status: 'completed' };
  }
}

export interface InvocationBoundaryConfig {
  onStream?: (event: unknown) => void;
  fingerprint?: string;
}

export function createInvocationBoundaryOptions<TRunnable extends Runnable>(
  config: InvocationBoundaryConfig | undefined,
): InvocationBoundaryOptions<WorkflowResult<TRunnable>> {
  return {
    onStream: config?.onStream as InvocationBoundaryOptions<
      WorkflowResult<TRunnable>
    >['onStream'],
    getIterations: (r) => r.iterations,
    getEndReason: (r) => r.status as InvocationEndReason,
    getError: (r) => r.error,
    isYielded: (r) => r.status === 'yielded',
    getYieldInfo: (r) => ({
      pendingCallIds: r.pendingCalls?.map((c) => c.callId) ?? [],
      yieldIndex: r.yieldIndex,
      awaitingInput: r.awaitingInput,
    }),
    fingerprint: config?.fingerprint,
  };
}
