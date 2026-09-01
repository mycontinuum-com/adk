import type { Sequence, RunResult, StreamEvent } from '../types'
import type { Session } from '../types'
import type { InternalRunConfig } from '../types/runtime'
import type { WorkflowRunnerConfig } from './config'

import { withInvocationBoundary, createInvocationId, type ResumeContext } from '../core'
import {
  type WorkflowResult,
  createTerminalResult,
  mapStepResultToWorkflowResult,
  workflowResultToRunResult,
  createInvocationBoundaryOptions,
} from './workflows'

export interface SequenceResumeContext extends ResumeContext {
  stepIndex: number
  stepResumeContext?: ResumeContext
}

export async function* runSequence(
  runnable: Sequence,
  session: Session,
  config: InternalRunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: WorkflowRunnerConfig,
  resumeContext?: SequenceResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const invocationId = resumeContext?.invocationId ?? createInvocationId()
  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0

  async function* execute(): AsyncGenerator<StreamEvent, WorkflowResult<Sequence>> {
    let totalIterations = 0
    const startStep = resumeContext?.stepIndex ?? 0

    for (let i = startStep; i < runnable.runnables.length; i++) {
      if (signal.aborted) {
        return createTerminalResult(
          runnable,
          session,
          currentYieldIndex,
          totalIterations,
          'aborted',
        )
      }

      const step = runnable.runnables[i]
      const stepResumeContext = i === startStep ? resumeContext?.stepResumeContext : undefined

      const gen = runnerConfig.run(step, session, config, signal, invocationId, stepResumeContext)

      let iterResult = await gen.next()
      while (!iterResult.done) {
        yield iterResult.value
        iterResult = await gen.next()
      }

      const stepResult = iterResult.value
      totalIterations += stepResult.iterations

      const earlyResult = mapStepResultToWorkflowResult(
        stepResult,
        runnable,
        session,
        currentYieldIndex,
        totalIterations,
      )
      if (earlyResult) return earlyResult
    }

    return createTerminalResult(runnable, session, currentYieldIndex, totalIterations, 'completed')
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
  )

  return workflowResultToRunResult(result, runnable)
}
