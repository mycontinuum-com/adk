import type { ForcedToolCallErrorDetails } from './forced-tool-gate'
import type { VoiceEvent } from './types'

import { ForcedToolCallError } from './forced-tool-gate'

export type OutputToolCompletionSource = 'output_tool_completion'

export type OutputToolCompletionPhase =
  | 'trigger'
  | 'generation'
  | 'tool'
  | 'forced_tool'
  | 'timeout'
  | 'skipped'

export interface OutputToolCompletionErrorDetails {
  intendedToolName: string
  source: OutputToolCompletionSource
  phase: OutputToolCompletionPhase
  elapsedMs: number
  attempts?: number
  maxAttempts?: number
  incorrectToolName?: string
  forcedToolReason?: ForcedToolCallErrorDetails['reason']
  cause?: unknown
}

export class OutputToolCompletionError extends Error {
  readonly intendedToolName: string
  readonly source: OutputToolCompletionSource
  readonly phase: OutputToolCompletionPhase
  readonly elapsedMs: number
  readonly attempts?: number
  readonly maxAttempts?: number
  readonly incorrectToolName?: string
  readonly forcedToolReason?: ForcedToolCallErrorDetails['reason']
  readonly cause?: unknown

  constructor(details: OutputToolCompletionErrorDetails, message?: string) {
    const forcedToolError = getForcedToolError(details.cause)
    super(
      message ??
        (details.phase === 'timeout'
          ? `Timed out waiting for output tool ${details.intendedToolName}`
          : `Output tool completion failed for ${details.intendedToolName} during ${details.phase}`),
    )
    this.name = 'OutputToolCompletionError'
    this.intendedToolName = details.intendedToolName
    this.source = details.source
    this.phase = details.phase
    this.elapsedMs = details.elapsedMs
    this.attempts = details.attempts ?? forcedToolError?.attempts
    this.maxAttempts = details.maxAttempts ?? forcedToolError?.maxAttempts
    this.incorrectToolName = details.incorrectToolName ?? forcedToolError?.incorrectToolName
    this.forcedToolReason = details.forcedToolReason ?? forcedToolError?.reason
    this.cause = details.cause
  }
}

export interface OutputToolCompletion {
  complete(): void
  fail(phase: OutputToolCompletionPhase, cause?: unknown): OutputToolCompletionError
  wait(): Promise<void>
  cancel(): void
}

export interface OutputToolCompletionOptions {
  intendedToolName: string
  source: OutputToolCompletionSource
  timeoutMs: number
  attempts?: number
  onVoiceEvent?: (event: VoiceEvent) => void
}

export function createOutputToolCompletion(
  options: OutputToolCompletionOptions,
): OutputToolCompletion {
  const startedAt = Date.now()
  let settled = false
  let resolve!: () => void
  let reject!: (error: OutputToolCompletionError) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})

  const emitBase = {
    intendedToolName: options.intendedToolName,
    source: options.source,
  } as const

  const elapsedMs = () => Date.now() - startedAt

  const timeout = setTimeout(() => {
    fail('timeout')
  }, options.timeoutMs)

  const clear = () => {
    clearTimeout(timeout)
    settled = true
  }

  const fail = (phase: OutputToolCompletionPhase, cause?: unknown) => {
    const error =
      cause instanceof OutputToolCompletionError
        ? cause
        : new OutputToolCompletionError({
            intendedToolName: options.intendedToolName,
            source: options.source,
            phase,
            elapsedMs: elapsedMs(),
            attempts: options.attempts,
            cause,
          })
    if (settled) return error
    clear()
    const sanitized = sanitizeError(error.cause ?? error)
    options.onVoiceEvent?.({
      type: 'output_tool_completion_failed',
      ...emitBase,
      phase: error.phase,
      elapsedMs: error.elapsedMs,
      ...(error.attempts !== undefined ? { attempts: error.attempts } : {}),
      ...(error.maxAttempts !== undefined ? { maxAttempts: error.maxAttempts } : {}),
      ...(error.incorrectToolName !== undefined
        ? { incorrectToolName: error.incorrectToolName }
        : {}),
      ...(error.forcedToolReason !== undefined ? { forcedToolReason: error.forcedToolReason } : {}),
      errorName: sanitized.name,
      errorMessage: sanitized.message,
    })
    reject(error)
    return error
  }

  options.onVoiceEvent?.({
    type: 'output_tool_completion_started',
    ...emitBase,
    elapsedMs: 0,
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
  })

  return {
    complete() {
      if (settled) return
      clear()
      options.onVoiceEvent?.({
        type: 'output_tool_completion_succeeded',
        ...emitBase,
        elapsedMs: elapsedMs(),
        ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      })
      resolve()
    },
    fail,
    wait() {
      return promise
    },
    cancel() {
      if (settled) return
      clear()
      resolve()
    },
  }
}

function sanitizeError(error: unknown): { name: string; message: string } {
  while (
    error instanceof Error &&
    'cause' in error &&
    (error as { cause?: unknown }).cause instanceof Error
  ) {
    error = (error as { cause?: unknown }).cause
  }
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message,
    }
  }
  return {
    name: 'Error',
    message: String(error),
  }
}

function getForcedToolError(error: unknown): ForcedToolCallError | undefined {
  while (error instanceof Error) {
    if (error instanceof ForcedToolCallError) return error
    error = (error as { cause?: unknown }).cause
  }
  return undefined
}
