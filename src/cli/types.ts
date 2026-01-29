import type { Middleware } from '../middleware/types';
import type { Runnable, RunResult, SessionService } from '../types';
import type { BaseRunner } from '../core';
import type { BaseSession } from '../session';

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
  runner?: BaseRunner;
  session?: BaseSession;
  sessionService?: SessionService;
  prompt?: string;
  options?: CLIOptions;
}

export interface CLIHandle extends PromiseLike<RunResult> {
  readonly runner: BaseRunner;
  readonly session: BaseSession;
  readonly runnable: Runnable;
}
