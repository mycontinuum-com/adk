import retry from 'async-retry'

import type { RetryConfig } from '../types/runnables'

function bailWith(bail: (e: Error) => void, error: Error): never {
  bail(error)
  throw error
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  signal?: AbortSignal,
): Promise<T> {
  return retry(
    async (bail) => {
      if (signal?.aborted) {
        bailWith(bail, new Error('Aborted'))
      }

      try {
        return await fn()
      } catch (error) {
        const err = error as Error
        if (config.retryableErrors && !config.retryableErrors(err)) {
          bailWith(bail, err)
        }
        throw err
      }
    },
    {
      retries: config.maxAttempts - 1,
      factor: config.backoffMultiplier,
      minTimeout: config.initialDelayMs,
      maxTimeout: config.maxDelayMs,
      randomize: true,
    },
  )
}

/**
 * A stream retry aborted before its request was sent, such as during the wait before a retry. The
 * attempt spent nothing. Matched by name, since each bundled entry of the package has its own copy
 * of this class.
 */
class RequestNotSentError extends Error {
  override readonly name = 'RequestNotSentError'

  constructor() {
    super('Aborted')
  }
}

/** Whether `error` is a `RequestNotSentError` from any copy of the package. */
function isRequestNotSent(error: unknown): boolean {
  return error instanceof Error && error.name === 'RequestNotSentError'
}

/**
 * Whether a failed request spent nothing: the provider answered it with an HTTP error status, such
 * as a 429, or it was a retry aborted before it was sent. Any other failure, such as a reset
 * connection, a timeout, a stream that ended early or an abort mid-request, may have been
 * processed.
 */
export function failedWithoutSpending(error: unknown): boolean {
  return answeredWithErrorStatus(error) || isRequestNotSent(error)
}

/**
 * Whether the provider answered the request with an HTTP error status. The OpenAI, Anthropic and
 * Google SDKs each throw an error carrying the response's numeric `status`, and Voyage's carries
 * `statusCode`; one raised without a response, such as a connection error, carries neither.
 */
function answeredWithErrorStatus(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const status =
    'status' in error ? error.status : 'statusCode' in error ? error.statusCode : undefined
  return typeof status === 'number' && status >= 400 && status < 600
}

export interface StreamRetryOptions<TYield> {
  config?: RetryConfig
  signal?: AbortSignal
  /**
   * Ends an attempt abandoned to retry; what it returns is yielded before the next attempt. A model
   * adapter returns the attempt's `model_end` (`abandonedAttemptEnd`), so the attempt writes its
   * usage line.
   */
  onRetry: (abandoned: { error: Error; durationMs: number }) => TYield
}

export async function* withStreamRetry<TYield, TReturn>(
  createStream: () => AsyncGenerator<TYield, TReturn>,
  options: StreamRetryOptions<TYield>,
): AsyncGenerator<TYield, TReturn> {
  const maxAttempts = options.config?.maxAttempts ?? 1

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new RequestNotSentError()
    }

    const startedAt = Date.now()
    try {
      return yield* createStream()
    } catch (error) {
      const err = error as Error
      const isRetryable = !options.config?.retryableErrors || options.config.retryableErrors(err)
      const isLastAttempt = attempt >= maxAttempts

      if (!isRetryable || isLastAttempt) {
        throw err
      }

      yield options.onRetry({ error: err, durationMs: Date.now() - startedAt })
      await sleep(computeRetryDelay(options.config!, attempt))
    }
  }

  throw new Error('Unreachable')
}

function computeRetryDelay(config: RetryConfig, attempt: number): number {
  return Math.min(
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
    config.maxDelayMs,
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
