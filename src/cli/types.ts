import type { Hook } from '../hook/types'
import type { Runnable } from '../types/runnables'
import type { RunResult, Runner } from '../types/runtime'
import type { SessionService, Session } from '../types/session'

export type CLIStatus = 'idle' | 'running' | 'yielded' | 'completed' | 'error'

export type DisplayMode = 'content' | 'debug' | 'logging'

export interface CLIOptions {
  hooks?: Hook<any>[]
  showDurations?: boolean
  showIds?: boolean
  exitOnComplete?: boolean
  logBufferSize?: number
  defaultMode?: DisplayMode
}

export interface CLIConfig {
  runner?: Runner
  session?: Session
  sessionService?: SessionService
  input?: string
  options?: CLIOptions
}

export interface CLIHandle extends PromiseLike<RunResult> {
  readonly runner: Runner
  readonly session: Session
  readonly runnable: Runnable<any>
}
