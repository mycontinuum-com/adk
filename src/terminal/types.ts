import type { Hook } from '../hook/types'
import type { Runnable } from '../types/runnables'
import type { RunResult, Runner } from '../types/runtime'
import type { SessionService, Session } from '../types/session'

export type TerminalStatus = 'idle' | 'running' | 'yielded' | 'completed' | 'error'

export type DisplayMode = 'content' | 'debug' | 'logging'

export interface TerminalOptions {
  hooks?: Hook<any>[]
  showDurations?: boolean
  showIds?: boolean
  exitOnComplete?: boolean
  logBufferSize?: number
  defaultMode?: DisplayMode
}

export interface TerminalConfig {
  runner?: Runner
  session?: Session
  sessionService?: SessionService
  input?: string
  options?: TerminalOptions
}

export interface TerminalHandle extends PromiseLike<RunResult> {
  readonly runner: Runner
  readonly session: Session
  readonly runnable: Runnable<any>
}
