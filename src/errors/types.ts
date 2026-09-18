import type { ParseError, Correction } from '../parser'
import type { ErrorContext } from '../types/events'
import type { AnyZodSchema } from '../types/zod'

export type ErrorRecovery =
  | { action: 'throw' }
  | { action: 'skip' }
  | { action: 'abort' }
  | { action: 'retry'; delay?: number }
  | { action: 'fallback'; result: unknown }
  | { action: 'pass' }

export class OutputParseError extends Error {
  constructor(
    public readonly rawOutput: string,
    public readonly schema: AnyZodSchema,
    public readonly parseErrors: ParseError[],
    public readonly partial?: unknown,
    public readonly corrections?: Correction[],
  ) {
    const firstError = parseErrors[0]
    const pathStr = firstError?.path?.length ? ` at ${firstError.path.join('.')}` : ''
    super(`Failed to parse structured output${pathStr}: ${firstError?.message ?? 'Unknown error'}`)
    this.name = 'OutputParseError'
  }
}

export class ConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly currentVersion: number,
  ) {
    super(`Failed to create session ${sessionId}: version conflict (current: ${currentVersion})`)
    this.name = 'ConflictError'
  }
}

export interface ErrorHandler {
  name?: string
  canHandle?: (ctx: ErrorContext) => boolean | Promise<boolean>
  handle: (ctx: ErrorContext) => ErrorRecovery | Promise<ErrorRecovery>
}

export interface ComposedErrorHandler {
  handle: (ctx: ErrorContext) => Promise<ErrorRecovery>
}
