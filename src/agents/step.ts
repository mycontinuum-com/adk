import type {
  Step,
  StepContext,
  StepSignal,
  StepResult,
  Runnable,
  RunResult,
  StreamEvent,
  AssistantEvent,
} from '../types'
import type { Session } from '../types'
import type { InternalRunConfig } from '../types/runtime'
import type { WorkflowRunnerConfig } from './config'

import { createStateAccessor } from '../context'
import {
  withInvocationBoundary,
  createInvocationId,
  createOrchestrationContext,
  type ResumeContext,
} from '../core'
import { createEventId } from '../session'
import {
  type WorkflowResult,
  createTerminalResult,
  createErrorResult,
  mapStepResultToWorkflowResult,
  workflowResultToRunResult,
  createInvocationBoundaryOptions,
} from './workflows'

export interface StepResumeContext extends ResumeContext {
  childResumeContext?: ResumeContext
}

export class StepSignalError extends Error {
  constructor(public readonly stepSignal: StepSignal) {
    super(`Step signal: ${stepSignal.signal}`)
    this.name = 'StepSignalError'
  }
}

function isRunnable(value: StepResult): value is Runnable {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof value.kind === 'string'
  )
}

interface StepContextWithOutput {
  ctx: StepContext
  getOutputValue: () => unknown | undefined
}

function createStepContext(
  invocationId: string,
  session: Session,
  runnerConfig: WorkflowRunnerConfig,
): StepContextWithOutput {
  const orchestration = createOrchestrationContext({
    session,
    sessionService: runnerConfig.sessionService,
    invocationId,
    subRunner: runnerConfig.subRunner,
    onStream: runnerConfig.onStream,
    signal: runnerConfig.signal,
    channel: runnerConfig.channel,
  })

  let outputValue: unknown | undefined
  let outputSet = false

  return {
    ctx: {
      invocationId,
      session,
      state: createStateAccessor(session, invocationId),
      skip: (): never => {
        throw new StepSignalError({ signal: 'skip' })
      },
      fail: (message: string): never => {
        throw new StepSignalError({ signal: 'fail', message })
      },
      respond: (text: string): never => {
        throw new StepSignalError({ signal: 'respond', text })
      },
      output: (value: unknown) => {
        outputValue = value
        outputSet = true
      },
      ...orchestration,
    },
    getOutputValue: () => (outputSet ? outputValue : undefined),
  }
}

export async function* runStep(
  runnable: Step,
  session: Session,
  config: InternalRunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: WorkflowRunnerConfig,
  resumeContext?: StepResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const invocationId = resumeContext?.invocationId ?? createInvocationId()
  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0

  async function* execute(): AsyncGenerator<StreamEvent, WorkflowResult<Step>> {
    if (signal.aborted) {
      return createTerminalResult(runnable, session, currentYieldIndex, 0, 'aborted')
    }

    try {
      const { ctx: stepCtx, getOutputValue } = createStepContext(
        invocationId,
        session,
        runnerConfig,
      )
      const result = await runnable.execute(stepCtx)
      const stepOutputValue = getOutputValue()

      if (result === undefined || result === null) {
        const wfResult = createTerminalResult(runnable, session, currentYieldIndex, 0, 'completed')
        if (stepOutputValue !== undefined) wfResult.outputValue = stepOutputValue
        return wfResult
      }

      if (isRunnable(result)) {
        const childResumeContext = resumeContext?.childResumeContext

        const gen = runnerConfig.run(
          result,
          session,
          config,
          signal,
          invocationId,
          childResumeContext,
        )

        let iterResult = await gen.next()
        while (!iterResult.done) {
          yield iterResult.value
          iterResult = await gen.next()
        }

        const childResult = iterResult.value

        const earlyResult = mapStepResultToWorkflowResult(
          childResult,
          runnable,
          session,
          currentYieldIndex,
          childResult.iterations,
        )
        if (earlyResult) {
          if (stepOutputValue !== undefined) earlyResult.outputValue = stepOutputValue
          return earlyResult
        }

        const wfResult = createTerminalResult(
          runnable,
          session,
          currentYieldIndex,
          childResult.iterations,
          'completed',
        )
        if (stepOutputValue !== undefined) wfResult.outputValue = stepOutputValue
        return wfResult
      }

      const wfResult = createTerminalResult(runnable, session, currentYieldIndex, 0, 'completed')
      if (stepOutputValue !== undefined) wfResult.outputValue = stepOutputValue
      return wfResult
    } catch (error) {
      if (error instanceof StepSignalError) {
        const sig = error.stepSignal

        switch (sig.signal) {
          case 'skip':
            return createTerminalResult(runnable, session, currentYieldIndex, 0, 'completed')

          case 'fail':
            return createErrorResult(runnable, session, currentYieldIndex, 0, sig.message)

          case 'respond': {
            const assistantEvent: AssistantEvent = {
              id: createEventId(),
              type: 'assistant',
              createdAt: Date.now(),
              invocationId,
              agentName: runnable.name,
              text: sig.text,
            }
            await runnerConfig.sessionService.appendEvent(session, assistantEvent)
            config?.onStream?.(assistantEvent)
            yield assistantEvent

            return createTerminalResult(runnable, session, currentYieldIndex, 0, 'completed')
          }
        }
      }

      const message = error instanceof Error ? error.message : String(error)
      return createErrorResult(runnable, session, currentYieldIndex, 0, message)
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
  )

  return workflowResultToRunResult(result, runnable)
}
