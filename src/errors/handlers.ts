import type { ErrorContext } from '../types/events';
import type { ErrorHandler, ErrorRecovery } from './types';

export interface RetryHandlerOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  retryable?: (ctx: ErrorContext) => boolean;
}

export function retryHandler(options: RetryHandlerOptions = {}): ErrorHandler {
  const {
    maxAttempts = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    retryable = () => true,
  } = options;

  const attempts = new Map<string, number>();

  return {
    name: 'retry',
    canHandle: (ctx) => retryable(ctx),
    handle: (ctx) => {
      const key = `${ctx.invocationId}:${ctx.phase}:${ctx.toolName ?? 'model'}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);

      if (attempt >= maxAttempts) {
        attempts.delete(key);
        return { action: 'pass' };
      }

      const delay = Math.min(
        baseDelay * Math.pow(backoffMultiplier, attempt - 1),
        maxDelay,
      );

      return { action: 'retry', delay };
    },
  };
}

export interface RateLimitHandlerOptions {
  maxRetries?: number;
  baseDelay?: number;
}

export function rateLimitHandler(
  options: RateLimitHandlerOptions = {},
): ErrorHandler {
  const { maxRetries = 5, baseDelay = 1000 } = options;

  return retryHandler({
    maxAttempts: maxRetries,
    baseDelay,
    backoffMultiplier: 2,
    retryable: (ctx) =>
      ctx.error.message.includes('rate limit') ||
      ctx.error.message.includes('429') ||
      ctx.error.message.includes('too many requests'),
  });
}

export interface TimeoutHandlerOptions {
  fallbackResult?: unknown;
}

export function timeoutHandler(
  options: TimeoutHandlerOptions = {},
): ErrorHandler {
  return {
    name: 'timeout',
    canHandle: (ctx) => ctx.error.message.includes('timed out'),
    handle: () => {
      if (options.fallbackResult !== undefined) {
        return { action: 'fallback', result: options.fallbackResult };
      }
      return { action: 'skip' };
    },
  };
}

export interface LoggingHandlerOptions {
  onError?: (ctx: ErrorContext) => void;
}

export function loggingHandler(
  options: LoggingHandlerOptions = {},
): ErrorHandler {
  const log =
    options.onError ??
    ((ctx) => {
      console.error(`[${ctx.phase}] Error in ${ctx.agent}:`, ctx.error.message);
    });

  return {
    name: 'logging',
    handle: (ctx) => {
      log(ctx);
      return { action: 'pass' };
    },
  };
}

export function defaultHandler(): ErrorHandler {
  return {
    name: 'default',
    handle: (ctx) => {
      return ctx.phase === 'tool' ? { action: 'skip' } : { action: 'throw' };
    },
  };
}
