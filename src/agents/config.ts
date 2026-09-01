import type { EventChannel } from '../channels'
import type { ErrorHandler } from '../errors/types'
import type { Hook } from '../hook/types'
import type { RunnableResumeContext } from '../session/resume/context'
import type {
  Runnable,
  SessionService,
  RunResult,
  StreamEvent,
  ModelAdapter,
  SubRunner,
  HandoffOrigin,
  StateSchema,
} from '../types'
import type { Session } from '../types'
import type { InternalRunConfig } from '../types/runtime'

export interface WorkflowRunnerConfig<S extends StateSchema = StateSchema> {
  sessionService: SessionService
  run: (
    runnable: Runnable<S>,
    session: Session,
    config: InternalRunConfig | undefined,
    signal: AbortSignal,
    parentInvocationId?: string,
    resumeContext?: RunnableResumeContext,
  ) => AsyncGenerator<StreamEvent, RunResult>
  subRunner?: SubRunner<S>
  onStream?: (event: StreamEvent) => void
  signal?: AbortSignal
  fingerprint?: string
  channel?: EventChannel
}

export interface AgentRunnerConfig<S extends StateSchema = StateSchema> {
  sessionService: SessionService
  getAdapter: (
    config: import('../types/runnables').ModelConfig,
  ) => ModelAdapter | Promise<ModelAdapter>
  runnerHooks?: readonly Hook<S>[]
  runnerErrorHandlers?: readonly ErrorHandler[]
  subRunner?: SubRunner<S>
  runConfig?: InternalRunConfig
  signal?: AbortSignal
  managed?: boolean
  handoffOrigin?: HandoffOrigin
  fingerprint?: string
  channel?: EventChannel
}
