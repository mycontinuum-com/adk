import retry from 'async-retry';
import type { RetryConfig } from '../types';

function bailWith(bail: (e: Error) => void, error: Error): never {
  bail(error);
  throw error;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  signal?: AbortSignal,
): Promise<T> {
  return retry(
    async (bail) => {
      if (signal?.aborted) {
        bailWith(bail, new Error('Aborted'));
      }

      try {
        return await fn();
      } catch (error) {
        const err = error as Error;
        if (config.retryableErrors && !config.retryableErrors(err)) {
          bailWith(bail, err);
        }
        throw err;
      }
    },
    {
      retries: config.maxAttempts - 1,
      factor: config.backoffMultiplier,
      minTimeout: config.initialDelayMs,
      maxTimeout: config.maxDelayMs,
      randomize: true,
    },
  );
}

export interface StreamRetryOptions<TYield> {
  config?: RetryConfig;
  signal?: AbortSignal;
  onRetry?: (
    error: Error,
    attempt: number,
    maxAttempts: number,
    invocationId: string,
  ) => TYield;
  invocationId?: string;
}

export async function* withStreamRetry<TYield, TReturn>(
  createStream: () => AsyncGenerator<TYield, TReturn>,
  options: StreamRetryOptions<TYield>,
): AsyncGenerator<TYield, TReturn> {
  const maxAttempts = options.config?.maxAttempts ?? 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new Error('Aborted');
    }

    try {
      return yield* createStream();
    } catch (error) {
      const err = error as Error;
      const isRetryable =
        !options.config?.retryableErrors || options.config.retryableErrors(err);
      const isLastAttempt = attempt >= maxAttempts;

      if (!isRetryable || isLastAttempt) {
        throw err;
      }

      await sleep(computeRetryDelay(options.config!, attempt));
    }
  }

  throw new Error('Unreachable');
}

function computeRetryDelay(config: RetryConfig, attempt: number): number {
  return Math.min(
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
    config.maxDelayMs,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
