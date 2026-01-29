import type {
  Parallel,
  RunConfig,
  RunResult,
  StreamEvent,
  Event,
} from '../types';
import { BaseSession } from '../session';
import { createStateAccessor } from '../context';
import {
  withInvocationBoundary,
  createInvocationId,
  type ResumeContext,
} from '../core';
import type { WorkflowRunnerConfig } from './config';
import {
  type WorkflowResult,
  createYieldedResult,
  createErrorResult,
  createTerminalResult,
  workflowResultToRunResult,
  createInvocationBoundaryOptions,
} from './workflows';

interface BranchExecution {
  index: number;
  session: BaseSession;
  result: RunResult | null;
  error: string | null;
  events: StreamEvent[];
}

export interface ParallelResumeContext extends ResumeContext {
  yieldedBranchIndices: number[];
  completedBranchIndices: number[];
  branchResumeContexts: Map<number, ResumeContext>;
}

async function executeBranch(
  branch: BranchExecution,
  generator: AsyncGenerator<StreamEvent, RunResult>,
  onStream?: (event: StreamEvent) => void,
): Promise<void> {
  try {
    let iterResult = await generator.next();
    while (!iterResult.done) {
      const event = iterResult.value;
      branch.events.push(event);
      onStream?.(event);
      iterResult = await generator.next();
    }
    branch.result = iterResult.value;
  } catch (error) {
    branch.error = error instanceof Error ? error.message : String(error);
  }
}

function getNewBranchEvents(
  branchSession: BaseSession,
  parentEventCount: number,
): Event[] {
  return branchSession.events.slice(parentEventCount);
}

function createBranchAbortSignal(
  parentSignal: AbortSignal,
  branchTimeout?: number,
): { signal: AbortSignal; cleanup: () => void } {
  if (!branchTimeout) {
    return { signal: parentSignal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), branchTimeout);

  const onParentAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onParentAbort, { once: true });

  const cleanup = () => {
    clearTimeout(timeoutId);
    parentSignal.removeEventListener('abort', onParentAbort);
  };

  return { signal: controller.signal, cleanup };
}

export async function* runParallel(
  runnable: Parallel,
  session: BaseSession,
  config: RunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: WorkflowRunnerConfig,
  resumeContext?: ParallelResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const invocationId = resumeContext?.invocationId ?? createInvocationId();
  const parentEventCount = session.events.length;
  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0;

  async function* execute(): AsyncGenerator<
    StreamEvent,
    WorkflowResult<Parallel>
  > {
    const branchesToRun = resumeContext
      ? resumeContext.yieldedBranchIndices
      : runnable.runnables.map((_, i) => i);
    const alreadyCompleted = resumeContext?.completedBranchIndices ?? [];

    const branchSignals = branchesToRun.map(() =>
      createBranchAbortSignal(signal, runnable.branchTimeout),
    );

    const branches: BranchExecution[] = branchesToRun.map((index) => ({
      index,
      session: session.clone(),
      result: null,
      error: null,
      events: [],
    }));

    const generators = branches.map((branch, i) => {
      const branchResumeContext = resumeContext?.branchResumeContexts.get(
        branch.index,
      );
      return runnerConfig.run(
        runnable.runnables[branch.index],
        branch.session,
        { ...config, onStream: undefined },
        branchSignals[i].signal,
        invocationId,
        branchResumeContext,
      );
    });

    const branchPromises = branches.map((branch, i) =>
      executeBranch(branch, generators[i], config?.onStream),
    );

    try {
      if (runnable.failFast) {
        await Promise.race([
          Promise.all(branchPromises),
          ...branchPromises.map(async (p, i) => {
            await p;
            const branch = branches[i];
            if (branch.error) {
              throw new Error(branch.error);
            }
            if (branch.result?.status === 'error') {
              throw new Error(branch.result.error);
            }
          }),
        ]);
      } else {
        await Promise.allSettled(branchPromises);
      }
    } finally {
      branchSignals.forEach((s) => s.cleanup());
    }

    const yieldedBranches = branches.filter(
      (b) => b.result?.status === 'yielded',
    );
    const completedBranches = branches.filter(
      (b) => b.result?.status === 'completed',
    );
    const errorBranches = branches.filter(
      (b) => b.error !== null || b.result?.status === 'error',
    );

    for (const branch of branches) {
      const newEvents = getNewBranchEvents(branch.session, parentEventCount);
      for (const event of newEvents) {
        await runnerConfig.sessionService.appendEvent(session, event);
      }
    }

    for (const event of branches.flatMap((b) => b.events)) {
      yield event;
    }

    const totalIterations = branches.reduce(
      (sum, b) => sum + (b.result?.iterations ?? 0),
      0,
    );

    const stepEvents = [...session.events.slice(parentEventCount)];

    if (yieldedBranches.length > 0) {
      const allPendingCalls = yieldedBranches.flatMap((b) => {
        if (b.result?.status === 'yielded') {
          return b.result.pendingCalls;
        }
        return [];
      });

      return createYieldedResult(
        runnable,
        session,
        currentYieldIndex,
        totalIterations,
        stepEvents,
        allPendingCalls,
      );
    }

    const allCompleted = [
      ...alreadyCompleted,
      ...completedBranches.map((b) => b.index),
    ];
    const failedBranches = errorBranches.map((b) => ({
      index: b.index,
      error:
        b.error ??
        (b.result?.status === 'error' ? b.result.error : 'Unknown error'),
    }));

    if (
      runnable.minSuccessful &&
      allCompleted.length < runnable.minSuccessful
    ) {
      const failedSummary = failedBranches
        .map((f) => `Branch ${f.index}: ${f.error}`)
        .join('; ');
      return createErrorResult(
        runnable,
        session,
        currentYieldIndex,
        totalIterations,
        stepEvents,
        `Only ${allCompleted.length} branches succeeded, need ${runnable.minSuccessful}. Failures: ${failedSummary}`,
      );
    }

    const successfulBranches = branches.filter(
      (b) => b.result !== null && b.result.status !== 'error',
    );
    const results = successfulBranches.map((b) => b.result!);

    if (runnable.merge) {
      const mergeCtx = {
        results,
        session,
        state: createStateAccessor(session, invocationId),
        successfulBranches: successfulBranches.map((b) => b.index),
        failedBranches,
      };
      for (const event of runnable.merge(mergeCtx)) {
        await runnerConfig.sessionService.appendEvent(session, event);
      }
    }

    const finalStepEvents = [...session.events.slice(parentEventCount)];
    return createTerminalResult(
      runnable,
      session,
      currentYieldIndex,
      totalIterations,
      finalStepEvents,
      'completed',
    );
  }

  const result = yield* withInvocationBoundary(
    runnable,
    invocationId,
    parentInvocationId,
    session,
    runnerConfig.sessionService,
    execute(),
    createInvocationBoundaryOptions<Parallel>({
      onStream: config?.onStream,
      fingerprint: runnerConfig.fingerprint,
    }),
    resumeContext,
  );

  return workflowResultToRunResult(result, runnable);
}
