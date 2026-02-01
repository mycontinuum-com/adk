import type {
  Step,
  StepContext,
  StepSignal,
  StepResult,
  Runnable,
  RunConfig,
  RunResult,
  StreamEvent,
  AssistantEvent,
} from '../types';
import type { BaseSession } from '../session';
import { createStateAccessor } from '../context';
import {
  withInvocationBoundary,
  createInvocationId,
  createOrchestrationContext,
  type ResumeContext,
} from '../core';
import { createEventId } from '../session';
import type { WorkflowRunnerConfig } from './config';
import {
  type WorkflowResult,
  createTerminalResult,
  createErrorResult,
  mapStepResultToWorkflowResult,
  workflowResultToRunResult,
  createInvocationBoundaryOptions,
} from './workflows';

export interface StepResumeContext extends ResumeContext {
  childResumeContext?: ResumeContext;
}

function isStepSignal(value: StepResult): value is StepSignal {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    'signal' in value &&
    typeof value.signal === 'string'
  );
}

function isRunnable(value: StepResult): value is Runnable {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof value.kind === 'string'
  );
}

function createStepContext(
  invocationId: string,
  session: BaseSession,
  runnerConfig: WorkflowRunnerConfig,
): StepContext {
  const orchestration = createOrchestrationContext({
    session,
    sessionService: runnerConfig.sessionService,
    invocationId,
    subRunner: runnerConfig.subRunner,
    onStream: runnerConfig.onStream,
    signal: runnerConfig.signal,
    channel: runnerConfig.channel,
  });

  return {
    invocationId,
    session,
    state: createStateAccessor(session, invocationId),
    skip: () => ({ signal: 'skip' }),
    fail: (message: string) => ({ signal: 'fail', message }),
    respond: (text: string) => ({ signal: 'respond', text }),
    complete: <T>(value: T, key?: string) => ({
      signal: 'complete',
      value,
      key,
    }),
    ...orchestration,
  };
}

export async function* runStep(
  runnable: Step,
  session: BaseSession,
  config: RunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: WorkflowRunnerConfig,
  resumeContext?: StepResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const initialEventCount = session.events.length;
  const invocationId = resumeContext?.invocationId ?? createInvocationId();
  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0;

  async function* execute(): AsyncGenerator<StreamEvent, WorkflowResult<Step>> {
    if (signal.aborted) {
      const stepEvents = [...session.events.slice(initialEventCount)];
      return createTerminalResult(
        runnable,
        session,
        currentYieldIndex,
        0,
        stepEvents,
        'aborted',
      );
    }

    try {
      const stepCtx = createStepContext(invocationId, session, runnerConfig);
      const result = await runnable.execute(stepCtx);

      if (result === undefined || result === null) {
        const stepEvents = [...session.events.slice(initialEventCount)];
        return createTerminalResult(
          runnable,
          session,
          currentYieldIndex,
          0,
          stepEvents,
          'completed',
        );
      }

      if (isStepSignal(result)) {
        const stepEvents = [...session.events.slice(initialEventCount)];

        switch (result.signal) {
          case 'skip':
            return createTerminalResult(
              runnable,
              session,
              currentYieldIndex,
              0,
              stepEvents,
              'completed',
            );

          case 'fail':
            return createErrorResult(
              runnable,
              session,
              currentYieldIndex,
              0,
              stepEvents,
              result.message,
            );

          case 'respond': {
            const assistantEvent: AssistantEvent = {
              id: createEventId(),
              type: 'assistant',
              createdAt: Date.now(),
              invocationId,
              agentName: runnable.name,
              text: result.text,
            };
            await runnerConfig.sessionService.appendEvent(
              session,
              assistantEvent,
            );
            config?.onStream?.(assistantEvent);
            yield assistantEvent;

            const updatedStepEvents = [
              ...session.events.slice(initialEventCount),
            ];
            return createTerminalResult(
              runnable,
              session,
              currentYieldIndex,
              0,
              updatedStepEvents,
              'completed',
            );
          }

          case 'complete': {
            if (result.key) {
              session.boundState(invocationId)[result.key] = result.value;
            }
            return createTerminalResult(
              runnable,
              session,
              currentYieldIndex,
              0,
              stepEvents,
              'completed',
            );
          }
        }
      }

      if (isRunnable(result)) {
        const childResumeContext = resumeContext?.childResumeContext;

        const gen = runnerConfig.run(
          result,
          session,
          config,
          signal,
          invocationId,
          childResumeContext,
        );

        let iterResult = await gen.next();
        while (!iterResult.done) {
          yield iterResult.value;
          iterResult = await gen.next();
        }

        const childResult = iterResult.value;
        const stepEvents = [...session.events.slice(initialEventCount)];

        const earlyResult = mapStepResultToWorkflowResult(
          childResult,
          runnable,
          session,
          currentYieldIndex,
          childResult.iterations,
          stepEvents,
        );
        if (earlyResult) return earlyResult;

        return createTerminalResult(
          runnable,
          session,
          currentYieldIndex,
          childResult.iterations,
          stepEvents,
          'completed',
        );
      }

      const stepEvents = [...session.events.slice(initialEventCount)];
      return createTerminalResult(
        runnable,
        session,
        currentYieldIndex,
        0,
        stepEvents,
        'completed',
      );
    } catch (error) {
      const stepEvents = [...session.events.slice(initialEventCount)];
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResult(
        runnable,
        session,
        currentYieldIndex,
        0,
        stepEvents,
        message,
      );
    }
  }

  const result = yield* withInvocationBoundary(
    runnable,
    invocationId,
    parentInvocationId,
    session,
    runnerConfig.sessionService,
    execute(),
    createInvocationBoundaryOptions<Step>({
      onStream: config?.onStream,
      fingerprint: runnerConfig.fingerprint,
    }),
    resumeContext,
  );

  return workflowResultToRunResult(result, runnable);
}
