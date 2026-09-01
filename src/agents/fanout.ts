import { cpus } from 'node:os'

export interface FanoutOptions {
  /** Maximum number of concurrent thunks. Defaults to min(16, cores - 2). */
  limit?: number
}

/**
 * Execute a list of async thunks with bounded concurrency.
 *
 * Guarantees: - Never more than `limit` thunks in flight at once. - A failed thunk resolves to
 * `null` (never rejects the whole batch). - Results are returned in input order. - The promise
 * never rejects.
 *
 * Default limit = min(16, cores - 2). With no thunks, resolves to [] immediately.
 *
 * @param thunks - Array of zero-arg async factories.
 * @param opts - Optional configuration. `limit` caps concurrency.
 */
export async function fanout<T>(
  thunks: Array<() => Promise<T>>,
  opts?: FanoutOptions,
): Promise<Array<T | null>> {
  const cores = cpus().length
  const defaultLimit = Math.max(1, Math.min(16, cores - 2))
  const limit = opts?.limit ?? defaultLimit

  if (thunks.length === 0) return []

  const results: Array<T | null> = Array.from<null, T | null>({ length: thunks.length }, () => null)
  let nextIndex = 0
  let inFlight = 0

  return new Promise<Array<T | null>>((resolve) => {
    let settled = 0

    function schedule(): void {
      while (inFlight < limit && nextIndex < thunks.length) {
        const index = nextIndex++
        inFlight++
        const thunk = thunks[index]
        Promise.resolve()
          .then(() => thunk())
          .then(
            (value) => {
              results[index] = value
            },
            () => {
              results[index] = null
            },
          )
          .finally(() => {
            inFlight--
            settled++
            if (settled === thunks.length) {
              resolve(results)
            } else {
              schedule()
            }
          })
      }
    }

    schedule()
  })
}
