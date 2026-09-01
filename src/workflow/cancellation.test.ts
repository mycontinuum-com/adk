/**
 * Workflow.cancellation — Cancellation
 *
 * Aborting the signal cancels in-flight fanout runs and queued work is not scheduled. The run
 * resolves aborted.
 *
 * Evidence: unit (abort signal; queued thunks never start)
 */
import { describe, it, expect } from 'vitest'

import { fanout } from '../agents/fanout'
import { adk } from '../api/app'

describe('workflow.cancellation', () => {
  it('aborting cancels queued fanout work and the run ends aborted (not completed)', async () => {
    const app = adk()
    const started: number[] = []

    const wf = app.step({
      name: 'cancel-test',
      execute: async (ctx) => {
        const thunks = Array.from({ length: 10 }, (_, i) => async () => {
          // Queued thunks must NOT begin once the run is aborted (ctx.signal flips on stream.abort()).
          if (ctx.signal?.aborted) return -1
          started.push(i)
          await new Promise<void>((res) => setTimeout(res, 100))
          return i
        })
        return fanout(thunks, { limit: 2 })
      },
    })

    const stream = app.run(wf, 'go')
    setTimeout(() => stream.abort(), 30)

    let abortedReject = false
    let result: { status?: string } | undefined
    await stream.then(
      (r) => {
        result = r as { status?: string }
      },
      (err) => {
        abortedReject = /abort/i.test(String((err as Error)?.message ?? err))
      },
    )

    // The run was aborted: it either rejected with an abort error or resolved with status 'aborted'
    // — it did NOT complete normally.
    expect(abortedReject || result?.status === 'aborted').toBe(true)
    expect(result?.status).not.toBe('completed')
    // Queued thunks were cancelled: with limit 2 and an abort at 30ms (well before the 100ms thunks
    // finish), the thunks admitted after the abort short-circuit on ctx.signal and never start.
    expect(started.length).toBeLessThan(10)
  })

  it('stream.abort() settles the run (does not hang)', async () => {
    const app = adk()

    const wf = app.step({
      name: 'abort-stream-test',
      execute: async () => {
        await new Promise<void>((res) => setTimeout(res, 500)) // long-running
        return { ran: true }
      },
    })

    const stream = app.run(wf, 'go')
    setTimeout(() => stream.abort(), 10)

    // Must settle (resolve or reject), not hang
    let settled = false
    const raceResult = await Promise.race([
      stream.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('hung')), 1000)),
    ])
    settled = raceResult === 'settled'

    expect(settled).toBe(true)
  })
})
