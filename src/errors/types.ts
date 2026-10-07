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

/**
 * `app.decide` was given a model that has no decisions endpoint: its adapter has none, or the
 * provider does not serve the model there. A model call is no substitute, because it returns no
 * probabilities, so the call fails instead.
 */
export class DecisionsUnavailableError extends Error {
  readonly provider: string
  readonly modelName: string

  constructor(model: { provider: string; name: string }, options?: ErrorOptions) {
    super(
      `Decisions are not available for model '${model.name}' (${model.provider}): no decisions endpoint serves it`,
      options,
    )
    this.name = 'DecisionsUnavailableError'
    this.provider = model.provider
    this.modelName = model.name
  }

  /**
   * Matches by name. A provider entry such as `@animahealth/adk/openai` is a separate bundle with
   * its own copy of this class, so the error its adapter throws is not built by the copy a consumer
   * imports from `@animahealth/adk`.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === 'DecisionsUnavailableError'
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
