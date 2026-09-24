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

type RunChild<S extends StateSchema> = (
  runnable: Runnable<S>,
  session: Session,
  config: InternalRunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId?: string,
  resumeContext?: RunnableResumeContext,
) => AsyncGenerator<StreamEvent, RunResult>

export interface WorkflowRunnerConfig<S extends StateSchema = StateSchema> {
  sessionService: SessionService
  /** Runs a child on the run's stream. */
  run: RunChild<S>
  /** Runs a child off the stream, for a parallel branch that is streamed from its ledger. */
  runDetached: RunChild<S>
  subRunner?: SubRunner<S>
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
