import type {
  Runnable,
  SessionService,
  RunConfig,
  RunResult,
  StreamEvent,
  Provider,
  ModelAdapter,
  SubRunner,
  HandoffOrigin,
  StateSchema,
} from '../types';
import type { Middleware } from '../middleware/types';
import type { ErrorHandler } from '../errors/types';
import type { BaseSession } from '../session';
import type { RunnableResumeContext } from '../session/resume/context';
import type { EventChannel } from '../channels';

export interface WorkflowRunnerConfig<S extends StateSchema = StateSchema> {
  sessionService: SessionService;
  run: (
    runnable: Runnable<S>,
    session: BaseSession,
    config: RunConfig | undefined,
    signal: AbortSignal,
    parentInvocationId?: string,
    resumeContext?: RunnableResumeContext,
  ) => AsyncGenerator<StreamEvent, RunResult>;
  subRunner?: SubRunner<S>;
  onStream?: (event: StreamEvent) => void;
  signal?: AbortSignal;
  fingerprint?: string;
  channel?: EventChannel;
}

export interface AgentRunnerConfig<S extends StateSchema = StateSchema> {
  sessionService: SessionService;
  getAdapter: (provider: Provider) => ModelAdapter;
  runnerMiddleware?: readonly Middleware<S>[];
  runnerErrorHandlers?: readonly ErrorHandler[];
  subRunner?: SubRunner<S>;
  runConfig?: RunConfig;
  signal?: AbortSignal;
  managed?: boolean;
  handoffOrigin?: HandoffOrigin;
  fingerprint?: string;
  channel?: EventChannel;
}
