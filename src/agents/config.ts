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
} from '../types';
import type { Middleware } from '../middleware/types';
import type { ErrorHandler } from '../errors/types';
import type { BaseSession } from '../session';
import type { RunnableResumeContext } from '../session/resume/context';
import type { EventChannel } from '../channels';

export interface WorkflowRunnerConfig {
  sessionService: SessionService;
  run: (
    runnable: Runnable,
    session: BaseSession,
    config: RunConfig | undefined,
    signal: AbortSignal,
    parentInvocationId?: string,
    resumeContext?: RunnableResumeContext,
  ) => AsyncGenerator<StreamEvent, RunResult>;
  subRunner?: SubRunner;
  onStream?: (event: StreamEvent) => void;
  signal?: AbortSignal;
  fingerprint?: string;
  channel?: EventChannel;
}

export interface AgentRunnerConfig {
  sessionService: SessionService;
  getAdapter: (provider: Provider) => ModelAdapter;
  runnerMiddleware?: readonly Middleware[];
  runnerErrorHandlers?: readonly ErrorHandler[];
  subRunner?: SubRunner;
  runConfig?: RunConfig;
  signal?: AbortSignal;
  managed?: boolean;
  handoffOrigin?: HandoffOrigin;
  fingerprint?: string;
  channel?: EventChannel;
}
