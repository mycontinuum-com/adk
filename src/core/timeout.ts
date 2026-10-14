const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 3_600_000

export function requestTimeoutMs(timeoutMs: number | undefined): number {
  const ms = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_REQUEST_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutMs must be a whole number from 1 to ${MAX_REQUEST_TIMEOUT_MS}, got ${ms}`,
    )
  }
  return ms
}
