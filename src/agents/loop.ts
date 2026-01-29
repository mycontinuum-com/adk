import type {
  Loop,
  LoopContext,
  RunConfig,
  RunResult,
  StreamEvent,
} from '../types';
import type { BaseSession } from '../session';
import { createStateAccessor } from '../context';
import {
  withInvocationBoundary,
  createInvocationId,
  type ResumeContext,
} from '../core';
import type { WorkflowRunnerConfig } from './config';
import {
  type WorkflowResult,
  createTerminalResult,
  createInputYieldResult,
  mapStepResultToWorkflowResult,
  workflowResultToRunResult,
  createInvocationBoundaryOptions,
} from './workflows';

export interface LoopResumeContext extends ResumeContext {
  iteration: number;
  iterationResumeContext?: ResumeContext;
}

export async function* runLoop(
  runnable: Loop,
  session: BaseSession,
  config: RunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: WorkflowRunnerConfig,
  resumeContext?: LoopResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const initialEventCount = session.events.length;
  const invocationId = resumeContext?.invocationId ?? createInvocationId();
  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0;

  async function* execute(): AsyncGenerator<StreamEvent, WorkflowResult<Loop>> {
    let totalIterations = 0;
    let lastResult: RunResult | null = null;
    const startIteration = resumeContext?.iteration ?? 0;

    for (
      let iteration = startIteration;
      iteration < runnable.maxIterations;
      iteration++
    ) {
      if (signal.aborted) {
        const stepEvents = [...session.events.slice(initialEventCount)];
        return createTerminalResult(
          runnable,
          session,
          currentYieldIndex,
          totalIterations,
          stepEvents,
          'aborted',
        );
      }

      const loopCtx: LoopContext = {
        invocationId,
        session,
        state: createStateAccessor(session, invocationId),
        iteration,
        lastResult,
      };
      const shouldContinue = await runnable.while(loopCtx);
      if (!shouldContinue) break;

      const iterationResumeContext =
        iteration === startIteration
          ? resumeContext?.iterationResumeContext
          : undefined;

      const gen = runnerConfig.run(
        runnable.runnable,
        session,
        config,
        signal,
        invocationId,
        iterationResumeContext,
      );
      let iterResult = await gen.next();
      while (!iterResult.done) {
        yield iterResult.value;
        iterResult = await gen.next();
      }

      lastResult = iterResult.value;
      totalIterations += iterResult.value.iterations;

      const stepEvents = [...session.events.slice(initialEventCount)];
      const earlyResult = mapStepResultToWorkflowResult(
        lastResult,
        runnable,
        session,
        currentYieldIndex,
        totalIterations,
        stepEvents,
      );
      if (earlyResult) return earlyResult;

      if (runnable.yields) {
        const nextIteration = iteration + 1;
        if (nextIteration < runnable.maxIterations) {
          const nextLoopCtx: LoopContext = {
            invocationId,
            session,
            state: createStateAccessor(session, invocationId),
            iteration: nextIteration,
            lastResult,
          };
          const willContinue = await runnable.while(nextLoopCtx);
          if (willContinue) {
            const yieldStepEvents = [
              ...session.events.slice(initialEventCount),
            ];
            return createInputYieldResult(
              runnable,
              session,
              currentYieldIndex,
              totalIterations,
              yieldStepEvents,
              invocationId,
            );
          }
        }
      }
    }

    const stepEvents = [...session.events.slice(initialEventCount)];
    return createTerminalResult(
      runnable,
      session,
      currentYieldIndex,
      totalIterations,
      stepEvents,
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
    createInvocationBoundaryOptions<Loop>({
      onStream: config?.onStream,
      fingerprint: runnerConfig.fingerprint,
    }),
    resumeContext,
  );

  return workflowResultToRunResult(result, runnable);
}
