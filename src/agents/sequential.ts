import type { Sequence, RunConfig, RunResult, StreamEvent } from '../types';
import type { BaseSession } from '../session';
import {
  withInvocationBoundary,
  createInvocationId,
  type ResumeContext,
} from '../core';
import type { WorkflowRunnerConfig } from './config';
import {
  type WorkflowResult,
  createTerminalResult,
  mapStepResultToWorkflowResult,
  workflowResultToRunResult,
  createInvocationBoundaryOptions,
} from './workflows';

export interface SequenceResumeContext extends ResumeContext {
  stepIndex: number;
  stepResumeContext?: ResumeContext;
}

export async function* runSequence(
  runnable: Sequence,
  session: BaseSession,
  config: RunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: WorkflowRunnerConfig,
  resumeContext?: SequenceResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const initialEventCount = session.events.length;
  const invocationId = resumeContext?.invocationId ?? createInvocationId();
  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0;

  async function* execute(): AsyncGenerator<
    StreamEvent,
    WorkflowResult<Sequence>
  > {
    let totalIterations = 0;
    const startStep = resumeContext?.stepIndex ?? 0;

    for (let i = startStep; i < runnable.runnables.length; i++) {
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

      const step = runnable.runnables[i];
      const stepResumeContext =
        i === startStep ? resumeContext?.stepResumeContext : undefined;

      const gen = runnerConfig.run(
        step,
        session,
        config,
        signal,
        invocationId,
        stepResumeContext,
      );

      let iterResult = await gen.next();
      while (!iterResult.done) {
        yield iterResult.value;
        iterResult = await gen.next();
      }

      const stepResult = iterResult.value;
      totalIterations += stepResult.iterations;

      const stepEvents = [...session.events.slice(initialEventCount)];
      const earlyResult = mapStepResultToWorkflowResult(
        stepResult,
        runnable,
        session,
        currentYieldIndex,
        totalIterations,
        stepEvents,
      );
      if (earlyResult) return earlyResult;
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
    createInvocationBoundaryOptions<Sequence>({
      onStream: config?.onStream,
      fingerprint: runnerConfig.fingerprint,
    }),
    resumeContext,
  );

  return workflowResultToRunResult(result, runnable);
}
