import type { Middleware } from '../middleware/types';
import type { Runnable, RunResult, SessionService, Session, Runner } from '../types';

export type CLIStatus = 'idle' | 'running' | 'yielded' | 'completed' | 'error';

export type DisplayMode = 'content' | 'debug' | 'logging';

export interface CLIOptions {
  middleware?: Middleware[];
  showDurations?: boolean;
  showIds?: boolean;
  exitOnComplete?: boolean;
  logBufferSize?: number;
  defaultMode?: DisplayMode;
}

export interface CLIConfig {
  runner?: Runner;
  session?: Session;
  sessionService?: SessionService;
  input?: string;
  options?: CLIOptions;
}

export interface CLIHandle extends PromiseLike<RunResult> {
  readonly runner: Runner;
  readonly session: Session;
  readonly runnable: Runnable;
}
