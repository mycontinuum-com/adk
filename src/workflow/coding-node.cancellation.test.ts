/**
 * Workflow.coding-node-cancellation-propagates — Coding Node Cancellation Propagates To The Coder
 *
 * Aborting propagates through the factory-passed signal into the in-flight CodingAgent run: the
 * coder is cancelled (stops running commands / spending tokens), no post-abort coding work is
 * scheduled, and the workspace is still disposed (dispose runs in finally). The signal threaded by
 * the seam is honored even outside app.run's own cancellation.
 *
 * Evidence: the coding agent received the abort (its run rejected/stopped on the signal); no
 * further commands ran after abort; dispose ran exactly once.
 */
import { describe, it, expect, vi } from 'vitest'

import type { ProvisionedWorkspace } from '../agents/coding/workspace-provisioner'

import { createCodingAgentFactory, runCodingNode, type CodingAgentFactory } from '../agents/coding'

/** Provisioner that records its dispose so we can assert it still runs on abort. */
function disposeTrackingProvisioner() {
  const disposeSpy = vi.fn<() => void>()
  const provisioner = {
    provision: async (_base: string, isolation: string): Promise<ProvisionedWorkspace> => ({
      path: '/fake/ws',
      isolation: isolation as ProvisionedWorkspace['isolation'],
      dispose: disposeSpy,
    }),
  }
  return { provisioner, disposeSpy }
}

describe('workflow.coding-node-cancellation-propagates', () => {
  it('the factory-passed signal reaches the coder and aborting cancels the in-flight run', async () => {
    const { provisioner, disposeSpy } = disposeTrackingProvisioner()
    const controller = new AbortController()

    let signalSeenByCoder: AbortSignal | undefined
    let workAfterAbort = false

    // The coder's run resolves a CodingResult that obeys the signal: it waits, and when the signal
    // fires it stops (rejects) WITHOUT doing further work.
    const factory: CodingAgentFactory = createCodingAgentFactory({
      build: () =>
        ({
          name: 'cancellable',
          run: (task: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signalSeenByCoder = task.signal
              const sig = task.signal
              if (sig?.aborted) {
                reject(new Error('aborted'))
                return
              }
              const timer = setTimeout(() => {
                // This represents "further command work" that must NOT happen after abort.
                workAfterAbort = true
              }, 1000)
              sig?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  reject(new Error('aborted'))
                },
                { once: true },
              )
            }),
        }) as never,
      delta: () => ({ diff: '', commandResult: 'aborted' }),
    })

    const promise = runCodingNode({
      factory,
      provisioner,
      base: '/repo',
      isolation: 'sandbox',
      task: 'long running build',
      signal: controller.signal,
    })

    // Abort mid-flight.
    setTimeout(() => controller.abort(), 10)

    await expect(promise).rejects.toThrow(/aborted/)

    // The seam threaded the abort signal into the coder's run.
    expect(signalSeenByCoder).toBe(controller.signal)
    // No post-abort command work ran.
    expect(workAfterAbort).toBe(false)
    // The workspace was still disposed (dispose runs in finally on the abort path).
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('an already-aborted signal short-circuits the coder, dispose still runs', async () => {
    const { provisioner, disposeSpy } = disposeTrackingProvisioner()
    const controller = new AbortController()
    controller.abort() // pre-aborted

    const runSpy = vi.fn<(task: { signal?: AbortSignal }) => Promise<unknown>>(
      (task: { signal?: AbortSignal }) => {
        if (task.signal?.aborted) return Promise.reject(new Error('aborted before start'))
        return Promise.resolve({ status: 'completed', sessionId: 'x', output: { items: [] } })
      },
    )

    const factory: CodingAgentFactory = createCodingAgentFactory({
      build: () => ({ name: 'pre', run: runSpy }) as never,
    })

    await expect(
      runCodingNode({
        factory,
        provisioner,
        base: '/repo',
        isolation: 'session',
        task: 'task',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted before start/)

    expect(runSpy).toHaveBeenCalledOnce()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })
})
