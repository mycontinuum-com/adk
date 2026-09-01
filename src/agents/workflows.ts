import type { InvocationBoundaryOptions } from '../core'
import type {
  Runnable,
  RunStatus,
  ToolYieldEvent,
  InvocationEndReason,
  StreamEvent,
  RunResult,
  AssistantEvent,
} from '../types'
import type { Session } from '../types'

export interface WorkflowResult<TRunnable extends Runnable = Runnable> {
  status: RunStatus
  session: Session
  iterations: number
  runnable: TRunnable
  yieldIndex: number
  yieldedTools?: ToolYieldEvent[]
  yieldedInvocationId?: string
  error?: string
  outputValue?: unknown
}

export function createWorkflowResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: Session,
  yieldIndex: number,
  status: RunStatus,
  iterations: number,
  extra?: { yieldedTools?: ToolYieldEvent[]; error?: string },
): WorkflowResult<TRunnable> {
  return {
    status,
    session,
    iterations,
    runnable,
    yieldIndex,
    ...extra,
  }
}

export function createYieldedResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: Session,
  yieldIndex: number,
  iterations: number,
  yieldedTools: ToolYieldEvent[],
): WorkflowResult<TRunnable> {
  return createWorkflowResult(runnable, session, yieldIndex, 'yielded_tool', iterations, {
    yieldedTools,
  })
}

export function createInputYieldResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: Session,
  yieldIndex: number,
  iterations: number,
  yieldedInvocationId?: string,
): WorkflowResult<TRunnable> {
  return {
    ...createWorkflowResult(runnable, session, yieldIndex, 'yielded_message', iterations),
    yieldedInvocationId,
  }
}

export function createErrorResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: Session,
  yieldIndex: number,
  iterations: number,
  error: string,
): WorkflowResult<TRunnable> {
  return createWorkflowResult(runnable, session, yieldIndex, 'error', iterations, {
    error,
  })
}

export function createTerminalResult<TRunnable extends Runnable>(
  runnable: TRunnable,
  session: Session,
  yieldIndex: number,
  iterations: number,
  status: 'completed' | 'aborted' | 'max_steps',
): WorkflowResult<TRunnable> {
  return createWorkflowResult(runnable, session, yieldIndex, status, iterations)
}

export function mapStepResultToWorkflowResult<TRunnable extends Runnable>(
  stepResult: RunResult,
  runnable: TRunnable,
  session: Session,
  yieldIndex: number,
  totalIterations: number,
): WorkflowResult<TRunnable> | null {
  switch (stepResult.status) {
    case 'yielded_tool':
      return createYieldedResult(
        runnable,
        session,
        yieldIndex,
        totalIterations,
        stepResult.yieldedTools,
      )
    case 'error':
      return createErrorResult(runnable, session, yieldIndex, totalIterations, stepResult.error)
    case 'aborted':
      return createTerminalResult(runnable, session, yieldIndex, totalIterations, 'aborted')
    case 'max_steps':
      return createTerminalResult(runnable, session, yieldIndex, totalIterations, 'max_steps')
    default:
      return null
  }
}

function computeOutputFromSession(session: Session) {
  const assistantEvents = session.events.filter((e): e is AssistantEvent => e.type === 'assistant')
  const lastAssistant = assistantEvents[assistantEvents.length - 1]
  const allMedia = assistantEvents.flatMap((e) => e.media ?? [])

  return {
    text: lastAssistant?.text,
    value: undefined,
    items: assistantEvents,
    media: allMedia.length > 0 ? allMedia : undefined,
  }
}

export function workflowResultToRunResult<TRunnable extends Runnable>(
  result: WorkflowResult<TRunnable>,
  runnable: TRunnable,
): RunResult {
  const sessionOutput = computeOutputFromSession(result.session)
  const output =
    result.outputValue !== undefined
      ? { ...sessionOutput, value: result.outputValue }
      : sessionOutput
  const base = {
    runnable,
    session: result.session,
    state: result.session.state,
    iterations: result.iterations,
    output,
  }

  switch (result.status) {
    case 'yielded_tool': {
      const yieldedTools = result.yieldedTools ?? []
      return {
        ...base,
        status: 'yielded_tool',
        yieldedTools,
      }
    }
    case 'yielded_message':
      return {
        ...base,
        status: 'yielded_message',
        yieldedInvocationId: result.yieldedInvocationId ?? '',
      }
    case 'error':
      return {
        ...base,
        status: 'error',
        error: result.error ?? 'Unknown error',
      }
    case 'aborted':
      return { ...base, status: 'aborted' }
    case 'max_steps':
      return { ...base, status: 'max_steps' }
    default:
      return { ...base, status: 'completed' }
  }
}

export interface InvocationBoundaryConfig {
  onStream?: (event: StreamEvent) => void
  fingerprint?: string
}

export function createInvocationBoundaryOptions<TRunnable extends Runnable>(
  config: InvocationBoundaryConfig | undefined,
): InvocationBoundaryOptions<WorkflowResult<TRunnable>> {
  return {
    onStream: config?.onStream as InvocationBoundaryOptions<WorkflowResult<TRunnable>>['onStream'],
    getIterations: (r) => r.iterations,
    getEndReason: (r) => r.status as InvocationEndReason,
    getError: (r) => r.error,
    isYielded: (r) => r.status === 'yielded_tool' || r.status === 'yielded_message',
    getYieldInfo: (r) => ({
      yieldedToolIds: r.yieldedTools?.map((c) => c.callId) ?? [],
      yieldIndex: r.yieldIndex,
      awaitingInput: r.status === 'yielded_message',
    }),
    fingerprint: config?.fingerprint,
  }
}
