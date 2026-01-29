import type { z } from 'zod';
import type { ErrorContext } from '../types/events';
import type { ParseError, Correction } from '../parser';

export type ErrorRecovery =
  | { action: 'throw' }
  | { action: 'skip' }
  | { action: 'abort' }
  | { action: 'retry'; delay?: number }
  | { action: 'fallback'; result: unknown }
  | { action: 'pass' };

export class OutputParseError extends Error {
  constructor(
    public readonly rawOutput: string,
    public readonly schema: z.ZodType,
    public readonly parseErrors: ParseError[],
    public readonly partial?: unknown,
    public readonly corrections?: Correction[],
  ) {
    const firstError = parseErrors[0];
    const pathStr = firstError?.path?.length
      ? ` at ${firstError.path.join('.')}`
      : '';
    super(
      `Failed to parse structured output${pathStr}: ${firstError?.message ?? 'Unknown error'}`,
    );
    this.name = 'OutputParseError';
  }
}

export interface ErrorHandler {
  name?: string;
  canHandle?: (ctx: ErrorContext) => boolean | Promise<boolean>;
  handle: (ctx: ErrorContext) => ErrorRecovery | Promise<ErrorRecovery>;
}

export interface ComposedErrorHandler {
  handle: (ctx: ErrorContext) => Promise<ErrorRecovery>;
}
